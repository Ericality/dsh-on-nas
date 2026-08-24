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
 * 派发: 通过 agent.followup 把任务文本作为 user message 投递到目标会话
 * (默认: 最后一个使用 /queue 命令的会话), agent 空闲后执行。
 *
 * 斜杠命令:
 *   /queue add <内容>                   入队, 等低谷自动执行
 *   /queue add --at "HH:mm|YYYY-MM-DD HH:mm" <内容>   指定时间执行
 *   /queue list                         查看队列
 *   /queue cancel <id>                  取消
 *   /queue edit <id> <新内容>           修改内容
 *   /queue run-now <id>                 立即执行
 *   /queue target [会话id]              查看/设置派发目标会话
 */
export const name = "dsh-taskqueue";
export const inject = ["commands", "agents", "tools"];

const STATE_FILE = "/data/dsh/taskqueue.json";
const PRICING_PAGE_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing";
const WINDOW_CACHE_TTL_MS = 30 * 60 * 1000;
const CHECK_INTERVAL_MS = 60000;

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

// ---------- 状态持久化 ----------
async function readState() {
	try {
		return JSON.parse(await readFile(STATE_FILE, "utf8"));
	} catch {
		return { version: 1, targetSessionId: null, tasks: [] };
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
	async function dispatchTask(state, task, agent) {
		const message = createUserMessage({
			content: [{ type: "text", text: `[任务队列] ${task.content}` }],
			source: { kind: "plugin", plugin: "taskqueue" }
		});
		agent.followup(message);
		task.status = "dispatched";
		task.dispatchedAt = new Date().toISOString();
		await writeState(state);
		ctx.logger?.info?.(`dsh-taskqueue: 已派发任务 #${task.id} 到 agent ${agent.id}`);
	}

	async function findTargetAgent(state) {
		const agents = ctx.agents;
		if (state.targetSessionId) {
			const a = agents.get(state.targetSessionId);
			if (a) return a;
		}
		// 兜底: 第一个在线 agent
		const list = agents.list?.() ?? [];
		return list[0] ?? null;
	}

	// ---------- 定时检查 ----------
	async function tick() {
		const state = await readState();
		const windowsNow = await resolveWindows();
		const now = Date.now();
		const due = state.tasks.filter((t) => t.status === "pending"
			&& (t.scheduledAt ? now >= Date.parse(t.scheduledAt) : !isBeijingPeak(windowsNow)));
		if (due.length === 0) return;
		const agent = await findTargetAgent(state);
		if (!agent) return; // 无在线会话, 下次再试
		for (const task of due) await dispatchTask(state, task, agent);
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
			const state = await readState();
			// 自动固定派发目标 = 使用命令的会话
			if (!state.targetSessionId && invocation?.agent?.id) {
				state.targetSessionId = invocation.agent.id;
				await writeState(state);
			}
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
				const id = state.tasks.length ? Math.max(...state.tasks.map((t) => t.id)) + 1 : 1;
				const task = {
					id,
					content,
					createdAt: new Date().toISOString(),
					status: "pending",
					...(at ? { scheduledAt: at } : {})
				};
				state.tasks.push(task);
				await writeState(state);
				const when = at ? `于 ${beijingNowString(new Date(at))}` : "等低谷时段自动执行";
				return { kind: "success", text: `任务 #${id} 已入队 (${when}): ${content}` };
			}
			case "list": {
				const pending = state.tasks.filter((t) => t.status === "pending");
				const rest2 = state.tasks.filter((t) => t.status !== "pending");
				const windowsNow = await resolveWindows();
				const now = new Date();
				const lines = [];
				if (pending.length === 0) lines.push("(队列为空)");
				for (const t of pending) {
					const when = t.scheduledAt
						? `定于 ${beijingNowString(new Date(t.scheduledAt))}`
						: (isBeijingPeak(windowsNow) ? "等低谷" : "低谷中, 将尽快派发");
					lines.push(`#${t.id} [${when}] ${t.content.slice(0, 60)}`);
				}
				if (rest2.length > 0) lines.push(`-- 历史: ${rest2.map((t) => `#${t.id}${STATUS_TEXT[t.status] ?? t.status}`).join(", ")}`);
				lines.push(`目标会话: ${state.targetSessionId ?? "未固定"} · 高峰窗口: ${windowSource}`);
				return { kind: "success", text: lines.join("\n") };
			}
			case "cancel": {
				const id = parseInt(rest, 10);
				const t = state.tasks.find((x) => x.id === id && x.status === "pending");
				if (!t) return { kind: "error", text: `未找到排队中的任务 #${id}` };
				t.status = "cancelled";
				await writeState(state);
				return { kind: "success", text: `任务 #${id} 已取消` };
			}
			case "edit": {
				const m = /^(\d+)\s+(.+)$/.exec(rest);
				if (!m) return { kind: "error", text: "用法: /queue edit <id> <新内容>" };
				const t = state.tasks.find((x) => x.id === parseInt(m[1], 10) && x.status === "pending");
				if (!t) return { kind: "error", text: `未找到排队中的任务 #${m[1]}` };
				t.content = m[2];
				await writeState(state);
				return { kind: "success", text: `任务 #${t.id} 内容已更新: ${t.content}` };
			}
			case "run-now": {
				const id = parseInt(rest, 10);
				const t = state.tasks.find((x) => x.id === id && x.status === "pending");
				if (!t) return { kind: "error", text: `未找到排队中的任务 #${id}` };
				const agent = await findTargetAgent(state);
				if (!agent) return { kind: "error", text: "当前无在线会话可派发, 稍后再试" };
				await dispatchTask(state, t, agent);
				return { kind: "success", text: `任务 #${id} 已立即派发` };
			}
			case "target": {
				if (!rest) return { kind: "success", text: `派发目标会话: ${state.targetSessionId ?? "未固定(默认用当前会话)"}` };
				state.targetSessionId = rest;
				await writeState(state);
				return { kind: "success", text: `派发目标会话已设为 ${rest}` };
			}
			case "help": case "":
				return { kind: "success", text: [
					"/queue add <内容>                   入队, 等低谷自动执行",
					"/queue add --at \"HH:mm\" <内容>    指定时间执行 (HH:mm 或 YYYY-MM-DD HH:mm)",
					"/queue list                         查看队列",
					"/queue cancel <id>                  取消任务",
					"/queue edit <id> <新内容>           修改任务内容",
					"/queue run-now <id>                 立即派发(不等低谷)",
					"/queue target [会话id]              查看/设置派发目标会话",
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
		description: "把任务加入低谷时段任务队列: 默认等官方低谷价时段(动态解析官方页)自动派发执行, 也可用 at 指定时间(北京时区 HH:mm 或 YYYY-MM-DD HH:mm)",
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
			const state = await readState();
			if (!state.targetSessionId && exec?.agent?.id) {
				state.targetSessionId = exec.agent.id;
				await writeState(state);
			}
			const at = args.at ? parseAt(args.at) : null;
			if (args.at && !at) throw new Error("at 时间格式无效 (HH:mm 或 YYYY-MM-DD HH:mm, 且需为未来)");
			const id = state.tasks.length ? Math.max(...state.tasks.map((t) => t.id)) + 1 : 1;
			state.tasks.push({
				id, content: args.content, createdAt: new Date().toISOString(), status: "pending",
				...(at ? { scheduledAt: at } : {})
			});
			await writeState(state);
			const when = at ? `于 ${beijingNowString(new Date(at))}` : "等低谷时段自动执行";
			return { id, text: `任务 #${id} 已入队 (${when}): ${args.content}` };
		},
		presentCall: (args) => ({ card: "generic", title: "加入任务队列", kind: "other", rawInput: args })
	}));

	ctx.tools.register(defineTool({
		name: "queue_list",
		description: "查看任务队列(排队中任务/历史/目标会话/当前高峰窗口来源)",
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
					? `定于 ${beijingNowString(new Date(t.scheduledAt))}`
					: (isBeijingPeak(windowsNow) ? "等低谷" : "低谷中, 将尽快派发");
				lines.push(`#${t.id} [${when}] ${t.content.slice(0, 60)}`);
			}
			const done = state.tasks.filter((t) => t.status !== "pending");
			if (done.length > 0) lines.push(`-- 历史: ${done.map((t) => `#${t.id}${STATUS_TEXT[t.status] ?? t.status}`).join(", ")}`);
			lines.push(`目标会话: ${state.targetSessionId ?? "未固定"} · 高峰窗口: ${windowSource}`);
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
			const state = await readState();
			const t = state.tasks.find((x) => x.id === args.id && x.status === "pending");
			if (!t) throw new Error(`未找到排队中的任务 #${args.id}`);
			t.status = "cancelled";
			await writeState(state);
			return { text: `任务 #${args.id} 已取消` };
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
			const state = await readState();
			const t = state.tasks.find((x) => x.id === args.id && x.status === "pending");
			if (!t) throw new Error(`未找到排队中的任务 #${args.id}`);
			t.content = args.content;
			await writeState(state);
			return { text: `任务 #${t.id} 内容已更新: ${t.content}` };
		},
		presentCall: (args) => ({ card: "generic", title: "修改任务", kind: "other", rawInput: args })
	}));

	ctx.tools.register(defineTool({
		name: "queue_runnow",
		description: "立即派发排队中的任务(不等低谷时段, 按 id)",
		parameters: { id: { type: "integer", required: true, description: "任务 id" } },
		output: {
			schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true } } },
			render: (_args, value) => [{ type: "text", text: value.text }]
		},
		execute: async (args, exec) => {
			const state = await readState();
			const t = state.tasks.find((x) => x.id === args.id && x.status === "pending");
			if (!t) throw new Error(`未找到排队中的任务 #${args.id}`);
			if (exec?.agent) await dispatchTask(state, t, exec.agent);
			else return { text: `任务 #${t.id} 已标记待派发(当前无会话)` };
			return { text: `任务 #${t.id} 已立即派发` };
		},
		presentCall: (args) => ({ card: "generic", title: "立即派发任务", kind: "other", rawInput: args })
	}));
}
