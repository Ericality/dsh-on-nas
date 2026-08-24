import { readFile, writeFile } from "node:fs/promises";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";

/**
 * @deepseek-ai/dsh-taskqueue (本地辅助插件, 非官方包)
 *
 * 客户端任务队列:
 *   - 不着急的需求先丢进队列, 到"低谷时段"(官方价半价窗口)自动派发给 agent 执行;
 *   - 也可以指定时间执行 (--at);
 *   - 派发前可随时查看/修改/取消。
 *
 * 低谷时段判定: 每次从官方定价页解析"高峰时段为北京时间..."定义
 * (当前: 周一至周五 9-12/14-18 为高峰, 其余空闲), 缓存 30 分钟;
 * 解析失败回退内置定义。官方调整时段会自动跟随。
 *
 * 会话绑定: 每个任务在创建时记录所在会话(sessionId)。派发时优先投递回
 * 创建它的会话(该会话离线时按 /queue target 设置的兜底目标, 再退到任意
 * 在线会话), 因此不同会话创建的任务会派发到各自会话继续。
 *
 * 派发: 通过 agent.followup 把任务文本作为 user message(source.kind="user",
 * 与 /goal 插件一致)投递到目标会话, 在对话中显示为一条普通用户消息记录,
 * agent 空闲后执行。
 *
 * 斜杠命令:
 *   /queue add <内容>                   入队, 等低谷自动执行
 *   /queue add --at "HH:mm|YYYY-MM-DD HH:mm" <内容>   指定时间执行
 *   /queue list                         查看队列
 *   /queue cancel <id>                  取消
 *   /queue edit <id> <新内容>           修改内容
 *   /queue run-now <id>                 立即执行
 *   /queue target [会话id]              查看/设置兜底派发目标会话
 */
export const name = "dsh-taskqueue";
export const inject = ["commands", "agents", "tools"];

const STATE_FILE = "/data/dsh/taskqueue.json";
const PRICING_PAGE_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing";
const WINDOW_CACHE_TTL_MS = 30 * 60 * 1000;
const CHECK_INTERVAL_MS = 60000;
// 派发后超过该时长仍未消费(消息丢失)才重派发, 避免和正常执行竞态
const REDISPATCH_GRACE_MS = 2 * 60 * 1000;

// 内置兜底 (2026-08-23 官方: 周一至周五 9-12/14-18 高峰, 其余空闲)
const FALLBACK_WINDOWS = { weekdaysOnly: true, windows: [[9, 12], [14, 18]] };

// ---------- 官方页解析: 高峰窗口定义 ----------
async function fetchPeakWindows() {
	try {
		const resp = await fetch(PRICING_PAGE_URL, {
			headers: { "User-Agent": "Mozilla/5.0" },
			signal: AbortSignal.timeout(12000)
		});
		if (!resp.ok) return null;
		let text = await resp.text();
		text = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ");
		text = text.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
		const idx = text.indexOf("高峰时段为北京时间");
		if (idx < 0) return null;
		const seg = text.slice(idx, idx + 120);
		const weekdaysOnly = /周一至周五/.test(seg);
		const windows = [...seg.matchAll(/(\d{1,2}):\d{2}\s*-\s*(\d{1,2}):\d{2}/g)]
			.map((m) => [parseInt(m[1], 10), parseInt(m[2], 10)])
			.filter(([a, b]) => a >= 0 && b > a && b <= 24);
		if (windows.length === 0) return null;
		return { weekdaysOnly, windows };
	} catch {
		return null;
	}
}

/** 当前(北京时区)是否处于高峰时段 */
function isBeijingPeak(windows, now = new Date()) {
	const bj = new Date(now.getTime() + 8 * 3600 * 1000);
	if (windows.weekdaysOnly) {
		const day = bj.getUTCDay(); // 0=周日
		if (day === 0 || day === 6) return false;
	}
	const h = bj.getUTCHours();
	return windows.windows.some(([s, e]) => h >= s && h < e);
}

function beijingNowString(now = new Date()) {
	return new Date(now.getTime() + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 16);
}

/** 会话 id 短显示: session-xxxxxxxx */
function shortSession(id) {
	if (!id) return "未绑定";
	const m = /^session-([0-9a-f]{8})/.exec(id);
	return m ? `session-${m[1]}` : id.slice(0, 16);
}

// ---------- 状态持久化 ----------
async function readState() {
	try {
		return JSON.parse(await readFile(STATE_FILE, "utf8"));
	} catch {
		return { version: 2, targetSessionId: null, tasks: [] };
	}
}

async function writeState(state) {
	try {
		await writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
		return true;
	} catch {
		return false;
	}
}

const STATUS_TEXT = {
	pending: "排队中",
	dispatched: "已派发",
	cancelled: "已取消"
};

/** 列表一行显示用: 压缩连续空白为单空格并去首尾 */
function oneLine(s) {
	return String(s ?? "").replace(/\s+/g, " ").trim();
}

/** 解析 --at 参数: "HH:mm"(下一次) 或 "YYYY-MM-DD HH:mm" */
function parseAt(value, now = new Date()) {
	if (!value) return null;
	const m1 = /^(\d{1,2}):(\d{2})$/.exec(value);
	if (m1) {
		const h = parseInt(m1[1], 10), min = parseInt(m1[2], 10);
		if (h > 23 || min > 59) return null;
		const t = new Date(now.getTime() + 8 * 3600 * 1000);
		t.setUTCHours(h, min, 0, 0);
		const target = new Date(t.getTime() - 8 * 3600 * 1000);
		if (target <= now) target.setUTCDate(target.getUTCDate() + 1); // 今天已过 -> 明天
		return target.toISOString();
	}
	const m2 = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})$/.exec(value);
	if (m2) {
		const iso = `${m2[1]}T${String(m2[2]).padStart(2, "0")}:${m2[3]}:00+08:00`;
		const t = new Date(iso);
		if (Number.isNaN(t.getTime()) || t <= now) return null;
		return t.toISOString();
	}
	return null;
}

export async function apply(ctx) {
	let windows = FALLBACK_WINDOWS;
	let windowSource = "内置兜底";
	let lastWindowFetch = 0;

	async function refreshWindows() {
		const fresh = await fetchPeakWindows();
		if (fresh) {
			windows = fresh;
			windowSource = `官方页(${beijingNowString().slice(5)})`;
		}
		lastWindowFetch = Date.now();
	}

	async function resolveWindows() {
		if (Date.now() - lastWindowFetch > WINDOW_CACHE_TTL_MS) await refreshWindows();
		return windows;
	}

	// ---------- 派发 ----------
	// 派发是"读状态->派发->写状态"的非原子流程, 并发(定时 tick + 手动 run-now)
	// 时可能基于旧状态互相覆盖, 导致任务被重复派发。用 promise 链把所有派发串行化。
	let dispatchChain = Promise.resolve();
	function serialized(fn) {
		const run = dispatchChain.then(fn, fn);
		dispatchChain = run.catch(() => {});
		return run;
	}
	/** 串行化的"读状态->改->写盘", 所有会写状态的操作都走这里, 避免并发覆盖 */
	function mutateState(fn) {
		return serialized(async () => {
			const state = await readState();
			const result = await fn(state);
			await writeState(state);
			return result;
		});
	}

	async function dispatchTask(state, task, agent) {
		const message = createUserMessage({
			content: [{ type: "text", text: `[任务队列] ${task.content}` }],
			// source.kind="user" 让 GUI 把它渲染成普通用户气泡(与 /goal 插件一致),
			// 派发后在对话中形成可见的记录, 而不是折叠的"上下文注入"灰条。
			source: { kind: "user" }
		});
		task.messageId = message.id; // 记录消息 id, 用于重启后校验消息是否仍存活
		agent.followup(message);
		task.status = "dispatched";
		task.dispatchedAt = new Date().toISOString();
		const ok = await writeState(state);
		if (!ok) ctx.logger?.warn?.(`dsh-taskqueue: 任务 #${task.id} 已派发但状态落盘失败, 重启后可能重复派发`);
		ctx.logger?.info?.(`dsh-taskqueue: 已派发任务 #${task.id} 到 agent ${agent.id}`);
	}

	/**
	 * 校验派发消息是否仍存活:
	 *   - 在 agent 的 inbox 里排队等待消费 -> 存活
	 *   - 已被 claim 成会话里的 user/message (id 匹配) -> 已消费
	 *   - 都没有 -> 消息丢失(典型: 派发后未消费就遇到容器重启, dispose 会清空 inbox)
	 */
	function isMessageAlive(task, agent) {
		if (!task.messageId) return true; // 旧任务无 messageId, 不参与校验
		try {
			if (agent.inbox?.nextTurn?.some((m) => m.id === task.messageId)) return true;
			if (agent.inbox?.nextStep?.some((m) => m.id === task.messageId)) return true;
			const evs = agent.session?.events ?? [];
			for (let i = evs.length - 1; i >= 0; i--) {
				const e = evs[i];
				if (e.type === "user/message" && e.data?.id === task.messageId) return true;
			}
		} catch { /* 会话不可读时保守跳过 */ }
		return false;
	}

	// 目标会话解析优先级:
	//   1) 任务创建时的会话 (task.sessionId), 不在线则尝试 resume 恢复(无人值守也能派发)
	//   2) /queue target 设置的兜底目标会话 (state.targetSessionId)
	//   3) 任意在线 agent
	async function findTargetAgent(state, task) {
		const agents = ctx.agents;
		const boundId = task?.sessionId ?? state.targetSessionId;
		if (boundId) {
			const a = agents.get(boundId);
			if (a) return a;
			// 绑定会话不在线: 主动恢复其持久 agent (dsh 重启后不会自动恢复会话,
			// 不恢复的话低谷任务在无人值守时会一直滞留)
			try {
				// resume 必须带 agentOptions(provider/model) 和 setup(挂载默认 preset):
				// 否则恢复出来的 agent 没有 preset(standard-fetch) 组合, 工具集只剩插件工具、
				// 系统提示词 {{model}} 无值, 无法正常执行。与宿主冷恢复路径
				// (createApiRemoteAgentResolver + composeAgent) 保持一致。
				const defaultModel = ctx.get?.("agentDefaultModel")?.currentSelection?.() ?? {};
				const handle = await agents.resume?.({
					resumeSessionId: boundId,
					agentOptions: {
						...(defaultModel.provider ? { provider: defaultModel.provider } : {}),
						...(defaultModel.model ? { model: defaultModel.model } : {})
					},
					setup: async (agentCtx) => {
						// 挂载部署默认 preset (当前 standard-fetch), 恢复的 agent 才能
						// 解析到该 preset 的工具集/提示词段; 无 preset 名单时跳过(与宿主一致)。
						const presets = ctx.get?.("agentPresets");
						if (presets) await presets.mount(agentCtx);
					}
				});
				const restored = handle?.agent ?? agents.get(boundId);
				if (restored) {
					ctx.logger?.info?.(`dsh-taskqueue: 已恢复会话 ${shortSession(boundId)} 的 agent 用于派发`);
					return restored;
				}
			} catch (e) {
				ctx.logger?.warn?.(`dsh-taskqueue: 恢复会话 ${shortSession(boundId)} 失败: ${e?.message ?? e}`);
			}
		}
		if (state.targetSessionId && state.targetSessionId !== boundId) {
			const a = agents.get(state.targetSessionId);
			if (a) return a;
		}
		// 兜底: 第一个在线 agent
		const list = agents.list?.() ?? [];
		return list[0] ?? null;
	}

	// ---------- 定时检查 ----------
	async function tick() {
		await serialized(async () => {
			const state = await readState();
			const windowsNow = await resolveWindows();
			const now = Date.now();
			// 1) 派发到期任务 (pending)
			const due = state.tasks.filter((t) => t.status === "pending"
				&& (t.scheduledAt ? now >= Date.parse(t.scheduledAt) : !isBeijingPeak(windowsNow)));
			for (const task of due) {
				const agent = await findTargetAgent(state, task);
				if (!agent) continue; // 该任务无可用会话, 下次再试
				await dispatchTask(state, task, agent);
			}
			// 2) 校验已派发任务: 派发超过 REDISPATCH_GRACE_MS 且消息已丢失(典型:
			//    派发后未消费就遇容器重启, dispose 清空 inbox) -> 重新派发
			for (const task of state.tasks) {
				if (task.status !== "dispatched" || !task.dispatchedAt) continue;
				if (now - Date.parse(task.dispatchedAt) < REDISPATCH_GRACE_MS) continue;
				const agent = await findTargetAgent(state, task);
				if (!agent) continue;
				if (isMessageAlive(task, agent)) continue;
				ctx.logger?.warn?.(`dsh-taskqueue: 任务 #${task.id} 派发消息已丢失(可能重启清空 inbox), 重新派发`);
				await dispatchTask(state, task, agent);
			}
		});
	}

	const timer = setInterval(() => { void tick().catch(() => {}); }, CHECK_INTERVAL_MS);
	timer.unref?.();
	setTimeout(() => { void tick().catch(() => {}); }, 3000);
	ctx.effect(() => () => clearInterval(timer));

	// ---------- 命令 ----------
	ctx.commands.register({
		name: "queue",
		description: "任务队列: 入队等低谷自动执行 / 指定时间 / 查看修改取消",
		input: { hint: "add [--at \"HH:mm\"] <内容> | list | cancel <id> | edit <id> <内容> | run-now <id> | target [会话id]" },
		handler: async (invocation) => {
			const sessionId = invocation?.agent?.id ?? null;
			const raw = (invocation?.rawInput ?? "").trim();
			const parts = raw.split(/\s+/);
			const sub = (parts[0] ?? "").toLowerCase();
			const rest = raw.slice(parts[0]?.length ?? 0).trim();

			switch (sub) {
			case "add": {
				let at = null;
				let content = rest;
				const atMatch = /^--at\s+("[^"]*"|'[^']*'|\S+)\s*(.*)$/.exec(rest);
				if (atMatch) {
					at = parseAt(atMatch[1].replace(/^["']|["']$/g, ""));
					content = atMatch[2];
				}
				if (!content) return { kind: "error", text: "用法: /queue add [--at \"HH:mm\"] <内容>" };
				if (rest.includes("--at") && !at) return { kind: "error", text: "--at 时间格式无效 (HH:mm 或 YYYY-MM-DD HH:mm, 且需为未来)" };
				return await mutateState(async (state) => {
					const id = state.tasks.length ? Math.max(...state.tasks.map((t) => t.id)) + 1 : 1;
					state.tasks.push({
						id,
						content,
						createdAt: new Date().toISOString(),
						status: "pending",
						...(sessionId ? { sessionId } : {}),
						...(at ? { scheduledAt: at } : {})
					});
					const when = at ? `于 ${beijingNowString(new Date(at))}` : "等低谷时段自动执行";
					return { kind: "success", text: `任务 #${id} 已入队 (${when}, 派发到当前会话 ${shortSession(sessionId)}): ${content}` };
				});
			}
			case "list": {
				const state = await readState();
				const pending = state.tasks.filter((t) => t.status === "pending");
				const rest2 = state.tasks.filter((t) => t.status !== "pending");
				const windowsNow = await resolveWindows();
				const now = new Date();
				const lines = [];
				if (pending.length === 0) lines.push("(队列为空)");
				for (const t of pending) {
					const when = t.scheduledAt
						? `定于 ${beijingNowString(new Date(t.scheduledAt)).slice(5, 16)}`
						: (isBeijingPeak(windowsNow) ? "等低谷" : "低谷中");
					lines.push(`#${t.id} ${oneLine(t.content).slice(0, 50)} [${when}]${t.sessionId ? ` (${shortSession(t.sessionId)})` : ""}`);
				}
				for (const t of rest2) {
					lines.push(`#${t.id} ${oneLine(t.content).slice(0, 50)} [${STATUS_TEXT[t.status] ?? t.status}]`);
				}
				lines.push(`兜底目标: ${state.targetSessionId ? shortSession(state.targetSessionId) : "未设置"} · 高峰窗口: ${windowSource}`);
				return { kind: "success", text: lines.join("\n") };
			}
			case "cancel": {
				const id = parseInt(rest, 10);
				if (!Number.isInteger(id)) return { kind: "error", text: "用法: /queue cancel <id>" };
				return await mutateState(async (state) => {
					const t = state.tasks.find((x) => x.id === id && x.status === "pending");
					if (!t) return { kind: "error", text: `未找到排队中的任务 #${id}` };
					t.status = "cancelled";
					return { kind: "success", text: `任务 #${id} 已取消` };
				});
			}
			case "edit": {
				const m = /^(\d+)\s+(.+)$/.exec(rest);
				if (!m) return { kind: "error", text: "用法: /queue edit <id> <新内容>" };
				return await mutateState(async (state) => {
					const t = state.tasks.find((x) => x.id === parseInt(m[1], 10) && x.status === "pending");
					if (!t) return { kind: "error", text: `未找到排队中的任务 #${m[1]}` };
					t.content = m[2];
					return { kind: "success", text: `任务 #${t.id} 内容已更新: ${t.content}` };
				});
			}
			case "run-now": {
				const id = parseInt(rest, 10);
				if (!Number.isInteger(id)) return { kind: "error", text: "用法: /queue run-now <id>" };
				return await mutateState(async (state) => {
					const t = state.tasks.find((x) => x.id === id && x.status === "pending");
					if (!t) return { kind: "error", text: `未找到排队中的任务 #${id}` };
					const agent = await findTargetAgent(state, t);
					if (!agent) return { kind: "error", text: "任务绑定会话已离线且无兜底会话, 稍后再试" };
					await dispatchTask(state, t, agent);
					return { kind: "success", text: `任务 #${id} 已立即派发到 ${shortSession(agent.id)}` };
				});
			}
			case "target": {
				if (!rest) {
					const state = await readState();
					return { kind: "success", text: `兜底派发目标会话: ${state.targetSessionId ? shortSession(state.targetSessionId) : "未设置(任务默认派发回创建它的会话)"}` };
				}
				return await mutateState(async (state) => {
					state.targetSessionId = rest;
					return { kind: "success", text: `兜底派发目标会话已设为 ${rest}` };
				});
			}
			case "help": case "":
				return { kind: "success", text: [
					"/queue add <内容>                   入队, 派发回当前会话, 等低谷自动执行",
					"/queue add --at \"HH:mm\" <内容>    指定时间执行 (HH:mm 或 YYYY-MM-DD HH:mm)",
					"/queue list                         查看队列(含各任务绑定会话)",
					"/queue cancel <id>                  取消任务",
					"/queue edit <id> <新内容>           修改任务内容",
					"/queue run-now <id>                 立即派发(不等低谷)",
					"/queue target [会话id]              查看/设置兜底派发目标会话",
					"/queue help                         本帮助",
					"低谷时段由官方页动态解析(当前: 周一至周五 9-12/14-18 高峰, 其余低谷)"
				].join("\n") };
			default:
				return { kind: "error", text: "未知子命令, 用 /queue help 查看用法" };
			}
		}
	});

	// ---------- 模型工具 (不依赖客户端斜杠命令, 自然语言即可调用) ----------
	ctx.tools.register(defineTool({
		name: "queue_add",
		description: "把任务加入低谷时段任务队列: 默认等官方低谷价时段(动态解析官方页)自动派发回当前会话执行, 也可用 at 指定时间(北京时区 HH:mm 或 YYYY-MM-DD HH:mm)",
		parameters: {
			content: { type: "string", required: true, description: "任务内容" },
			at: { type: "string", description: "可选指定时间: HH:mm 或 YYYY-MM-DD HH:mm (北京时区)" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: { type: "integer", required: true },
					text: { type: "string", required: true }
				}
			},
			render: (_args, value) => [{ type: "text", text: value.text }]
		},
		execute: async (args, exec) => {
			const sessionId = exec?.agent?.id ?? null;
			const at = args.at ? parseAt(args.at) : null;
			if (args.at && !at) throw new Error("at 时间格式无效 (HH:mm 或 YYYY-MM-DD HH:mm, 且需为未来)");
			return await mutateState(async (state) => {
				const id = state.tasks.length ? Math.max(...state.tasks.map((t) => t.id)) + 1 : 1;
				state.tasks.push({
					id, content: args.content, createdAt: new Date().toISOString(), status: "pending",
					...(sessionId ? { sessionId } : {}),
					...(at ? { scheduledAt: at } : {})
				});
				const when = at ? `于 ${beijingNowString(new Date(at))}` : "等低谷时段自动执行";
				return { id, text: `任务 #${id} 已入队 (${when}, 派发回当前会话 ${shortSession(sessionId)}): ${args.content}` };
			});
		},
		presentCall: (args) => ({ card: "generic", title: "加入任务队列", kind: "other", rawInput: args })
	}));

	ctx.tools.register(defineTool({
		name: "queue_list",
		description: "查看任务队列(排队中任务及各自绑定会话/历史/兜底目标会话/当前高峰窗口来源)",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					text: { type: "string", required: true }
				}
			},
			render: (_args, value) => [{ type: "text", text: value.text }]
		},
		execute: async () => {
			const state = await readState();
			const windowsNow = await resolveWindows();
			const now = new Date();
			const lines = [];
			const pending = state.tasks.filter((t) => t.status === "pending");
			if (pending.length === 0) lines.push("(队列为空)");
			for (const t of pending) {
				const when = t.scheduledAt
					? `定于 ${beijingNowString(new Date(t.scheduledAt)).slice(5, 16)}`
					: (isBeijingPeak(windowsNow) ? "等低谷" : "低谷中");
				lines.push(`#${t.id} ${oneLine(t.content).slice(0, 50)} [${when}]${t.sessionId ? ` (${shortSession(t.sessionId)})` : ""}`);
			}
			const done = state.tasks.filter((t) => t.status !== "pending");
			for (const t of done) {
				lines.push(`#${t.id} ${oneLine(t.content).slice(0, 50)} [${STATUS_TEXT[t.status] ?? t.status}]`);
			}
			lines.push(`兜底目标: ${state.targetSessionId ? shortSession(state.targetSessionId) : "未设置"} · 高峰窗口: ${windowSource}`);
			return { text: lines.join("\n") };
		},
		presentCall: () => ({ card: "generic", title: "查看任务队列", kind: "other" })
	}));

	ctx.tools.register(defineTool({
		name: "queue_cancel",
		description: "取消排队中的任务(按 id)",
		parameters: { id: { type: "integer", required: true, description: "任务 id" } },
		output: {
			schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true } } },
			render: (_args, value) => [{ type: "text", text: value.text }]
		},
		execute: async (args) => {
			return await mutateState(async (state) => {
				const t = state.tasks.find((x) => x.id === args.id && x.status === "pending");
				if (!t) throw new Error(`未找到排队中的任务 #${args.id}`);
				t.status = "cancelled";
				return { text: `任务 #${args.id} 已取消` };
			});
		},
		presentCall: (args) => ({ card: "generic", title: "取消任务", kind: "other", rawInput: args })
	}));

	ctx.tools.register(defineTool({
		name: "queue_edit",
		description: "修改排队中任务的内容(按 id)",
		parameters: {
			id: { type: "integer", required: true, description: "任务 id" },
			content: { type: "string", required: true, description: "新内容" }
		},
		output: {
			schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true } } },
			render: (_args, value) => [{ type: "text", text: value.text }]
		},
		execute: async (args) => {
			return await mutateState(async (state) => {
				const t = state.tasks.find((x) => x.id === args.id && x.status === "pending");
				if (!t) throw new Error(`未找到排队中的任务 #${args.id}`);
				t.content = args.content;
				return { text: `任务 #${t.id} 内容已更新: ${t.content}` };
			});
		},
		presentCall: (args) => ({ card: "generic", title: "修改任务", kind: "other", rawInput: args })
	}));

	ctx.tools.register(defineTool({
		name: "queue_runnow",
		description: "立即派发排队中的任务(不等低谷时段, 按 id, 派发回任务绑定会话)",
		parameters: { id: { type: "integer", required: true, description: "任务 id" } },
		output: {
			schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true } } },
			render: (_args, value) => [{ type: "text", text: value.text }]
		},
		execute: async (args) => {
			return await mutateState(async (state) => {
				const t = state.tasks.find((x) => x.id === args.id && x.status === "pending");
				if (!t) throw new Error(`未找到排队中的任务 #${args.id}`);
				const agent = await findTargetAgent(state, t);
				if (!agent) return { text: `任务 #${t.id} 绑定会话已离线且无兜底会话, 保持排队` };
				await dispatchTask(state, t, agent);
				return { text: `任务 #${t.id} 已立即派发到 ${shortSession(agent.id)}` };
			});
		},
		presentCall: (args) => ({ card: "generic", title: "立即派发任务", kind: "other", rawInput: args })
	}));
}
