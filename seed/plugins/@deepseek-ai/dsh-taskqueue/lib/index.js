import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { KNOWN_SESSION_EVENT_TYPES } from "@deepseek-ai/dsh-session";

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
 * 会话绑定 (v0.3.1, 默认): 任务直接绑定 queue_add 时的当前会话 —— 横幅、
 * 任务、执行、回复都在同一个会话, 对应关系清晰。若入队时会话还是"新会话"
 * (blank, 无 turn/start), 立即 followup 一条极简确认消息让 agent 跑一个轻量
 * turn 完成"转正"(真实 turn/start → 侧边栏可见、离开不消失、不会被 GUI 当
 * 新会话复用); 该 turn 只回复一句确认, 不执行任何操作, 成本极低
 * (~0.01~0.05 元, 实测待部署后确认)。
 *
 * 专属会话 (v0.3.0, 保留但默认不启用, config.ownSession=true 开启): 每个任务
 * 排队时新建独立会话派发到自己的窗口; 专属会话创建失败时回退绑定创建它的会话。
 * 派发时优先投递回任务绑定会话(离线时按 /queue target 设置的兜底目标,
 * 再退到任意在线会话)。
 *
 * 即时反馈 (v0.3.0): queue_add 成功后向当前会话注入 notice/banner 横幅
 * (kind="queue", 非 surface 事件 → 不进入模型历史、不消耗 token),
 * 由 dsh-notice-banner client 插件渲染成蓝色"任务队列"弹窗 —— 入队唯一提示。
 *
 * 自动标题 (v0.3.1): 入队时即给会话设置确定性标题"任务 #N · 内容前缀"
 * (source="user" 固定, 不触发 LLM 标题生成、不覆盖已有标题), agent 第一次
 * 回复前标题必然已在; 另注册 session_rename 模型工具, agent 可顺手改得更贴切。
 * 派发末尾提示 (v0.3.2): 派发消息在用户任务内容之后追加一段固定提示, 要求
 * agent 第一次回答时根据当前对话内容用 session_rename 把本会话标题重命名为
 * 贴切的任务标题 —— 侧边栏标题由 agent 按实际任务内容定, 而非固定前缀。
 *
 * 取消 (v0.3.1): 转正会话若只绑定本任务一个 pending 任务, 取消时归档该会话
 * (workspaceRegistry.archiveSession → 从侧边栏移出, 可恢复); 专属会话则 dispose。
 * queue_edit 可修改排队中任务内容。
 *
 * 可编辑队列面板 (v0.4.0): 注册框架通用 RPC 通道 /queue (list/edit/cancel/runnow),
 * 供 dsh-notice-banner 的队列横幅内嵌面板调用 —— 浏览器里直接查看/编辑/取消/
 * 立即派发排队任务, 不走模型回合、零 token; 派发前可改, 下发后只读。
 *
 * 派发: 通过 agent.followup 把任务文本作为 user message(source.kind="user",
 * 与 /goal 插件一致)投递到目标会话, 在对话中显示为一条普通用户消息记录,
 * agent 空闲后执行。
 *
 * 斜杠命令:
 *   /queue add <内容>                   入队, 绑当前会话, 等低谷自动执行
 *   /queue add --at "HH:mm|YYYY-MM-DD HH:mm" <内容>   指定时间执行
 *   /queue list                         查看队列
 *   /queue cancel <id>                  取消
 *   /queue edit <id> <新内容>           修改内容
 *   /queue run-now <id>                 立即执行
 *   /queue target [会话id]              查看/设置兜底派发目标会话
 */
export const name = "dsh-taskqueue";
// 注意: 插件 ctx 只能解析 inject 声明的服务 (fiber.store 机制) —— v0.4.0 起
// 队列可编辑面板需要浏览器端 RPC 通道, 故注入 connection (dsh-client-connection,
// web profile 基础 bundle 必有); 未声明的服务 (如 workspaceRegistry) ctx.get 返回
// undefined, 属既有限制。
export const inject = ["commands", "agents", "tools", "connection"];

const STATE_FILE = "/data/dsh/taskqueue.json";
const PRICING_PAGE_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing";
const WINDOW_CACHE_TTL_MS = 30 * 60 * 1000;
const CHECK_INTERVAL_MS = 60000;
// 派发后超过该时长仍未消费(消息丢失)才重派发, 避免和正常执行竞态
const REDISPATCH_GRACE_MS = 2 * 60 * 1000;
// 派发消息末尾的固定提示 (v0.3.2): 除用户输入的任务内容外, 追加一段指令,
// 要求 agent 在第一次回答时根据当前对话内容用 session_rename 工具把本会话
// 标题重命名为贴切的任务标题 —— 派发窗口在侧边栏的标题贴合实际任务。
const DISPATCH_TRAILING_HINT =
	"\n\n[末尾提示] 请在第一次回答时, 根据当前对话内容, 用 session_rename 工具把本会话标题重命名为贴切的任务标题。";

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
		const s = JSON.parse(await readFile(STATE_FILE, "utf8"));
		if (!s.locks) s.locks = {}; // v0.4.3: 编辑锁字段 (兼容旧状态文件)
		return s;
	} catch {
		return { version: 2, targetSessionId: null, tasks: [], locks: {} };
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

// ---------- 编辑锁 (v0.4.3) ----------
// 客户端面板编辑任务时经 /queue RPC editstart 锁定, 防止 tick 自动派发把正在编辑的
// 任务发出去 (用户编辑中被打断, 内容未保存就跑了); 同会话(id 更大)的任务也暂停派发,
// 编辑期间不被派发消息打断。editend (保存/取消/组件卸载) 释放。
const LOCK_TTL_MS = 30 * 60 * 1000; // 30 分钟无操作自动释放 (防用户关页面导致永久锁)

/** 清理过期编辑锁 (只改内存, 由调用方决定是否落盘) */
function cleanupStaleLocks(state) {
	if (!state.locks) return;
	const now = Date.now();
	for (const tid of Object.keys(state.locks)) {
		const lock = state.locks[tid];
		if (!lock || now - Date.parse(lock.since) > LOCK_TTL_MS) delete state.locks[tid];
	}
}

/** 任务是否被编辑锁阻止派发: 自身被锁, 或同会话有锁且本任务在锁任务之后 (按 id) */
function isTaskLocked(state, task) {
	if (!state.locks || Object.keys(state.locks).length === 0) return false;
	if (state.locks[task.id]) return true;
	for (const [tid, lock] of Object.entries(state.locks)) {
		if (lock && lock.sessionId && lock.sessionId === task.sessionId && task.id > parseInt(tid, 10)) return true;
	}
	return false;
}

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

export async function apply(ctx, config) {
	// v0.3.1: 专属会话机制保留但默认不启用 —— 默认任务绑当前会话(入队时
	// blank 会话走极简确认 turn 转正)。想回到"每任务新建专属会话"时在
	// cordis.patch.yml 的 taskqueue config 里设 ownSession: true。
	const cfg = { ownSession: false, ...(config ?? {}) };
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

	// ---------- 无 token 横幅反馈 (v0.3.0) ----------
	// 自定义会话事件 notice/banner: 非 surface 事件, 不进入模型历史、不消耗 token,
	// 由 dsh-notice-banner client 插件渲染横幅 (kind="queue" = 蓝色"任务队列"徽章)。
	// Set.add 幂等, 与其他插件重复注册无副作用 (持久化读取路径要求注册, 见 DSH 速查坑 A)。
	KNOWN_SESSION_EVENT_TYPES.add("notice/banner");
	/**
	 * 向会话注入队列横幅。⚠️ 必须在 session/event 观察者派发之外执行 (坑 B:
	 * 观察者内同步 append 会被静默吞掉), 因此一律 setTimeout 延迟。
	 */
	function appendQueueBanner(session, payload) {
		if (!session) return;
		setTimeout(() => {
			try {
				session.append("notice/banner", { kind: "queue", time: Date.now(), ...payload });
			} catch (err) {
				ctx.logger?.warn?.(`dsh-taskqueue: 横幅注入失败: ${String(err?.message ?? err)}`);
			}
		}, 100);
	}

	// ---------- 专属会话 (v0.3.0) ----------
	// 每个任务排队时建立独立会话, 派发到自己的窗口, 避免多个任务挤进同一会话。
	// 与会话创建/恢复的宿主路径 (ensureSession) 保持一致: 默认模型 + preset 挂载,
	// 否则恢复/新建的 agent 缺工具集、{{model}} 无值, 无法正常执行 (v0.2.5 踩坑)。
	// ⚠️ 建会话后必须 attach 到 cwd 对应 workspace, 否则 GUI 侧边栏落在"未分组"。
	const taskSessionHandles = new Map(); // sessionId -> AgentHandle (取消任务时销毁)
	async function createTaskSession(cwd) {
		const sessionId = `session-${randomUUID()}`;
		const defaultModel = ctx.get?.("agentDefaultModel")?.currentSelection?.() ?? {};
		const presets = ctx.get?.("agentPresets");
		let agentPreset;
		if (presets) {
			try {
				agentPreset = (await presets.resolve()).id; // 默认 preset id (standard-fetch)
			} catch { /* 无 preset 名单时跳过, 与宿主一致 */ }
		}
		const handle = await ctx.agents.create({
			sessionId,
			agentOptions: {
				...(defaultModel.provider ? { provider: defaultModel.provider } : {}),
				...(defaultModel.model ? { model: defaultModel.model } : {})
			},
			meta: {
				cwd,
				...(agentPreset === void 0 ? {} : { agentPreset })
			},
			setup: async (agentCtx) => {
				if (presets) await presets.mount(agentCtx);
			}
		});
		// attach 到 cwd 对应 workspace (与宿主 sessions.create 一致): 否则会话落在未分组
		try {
			const workspaces = ctx.get?.("workspaceRegistry");
			const workspace = workspaces && cwd ? await workspaces.resolveByPath(cwd) : void 0;
			if (workspace) await workspace.attachSession(sessionId);
			else ctx.logger?.warn?.(`dsh-taskqueue: 专属会话 ${shortSession(sessionId)} 未找到 cwd=${cwd} 对应 workspace, 将显示在未分组`);
		} catch (err) {
			ctx.logger?.warn?.(`dsh-taskqueue: 专属会话 ${shortSession(sessionId)} attach workspace 失败: ${String(err?.message ?? err)}`);
		}
		taskSessionHandles.set(sessionId, handle);
		return { sessionId, agent: handle.agent };
	}
	/** 取消任务时销毁其专属会话 (释放 agent), 失败仅告警不阻塞 */
	async function disposeTaskSession(sessionId) {
		const handle = taskSessionHandles.get(sessionId);
		if (!handle) return;
		taskSessionHandles.delete(sessionId);
		try {
			await handle.dispose();
		} catch (err) {
			ctx.logger?.warn?.(`dsh-taskqueue: 销毁专属会话 ${shortSession(sessionId)} 失败: ${String(err?.message ?? err)}`);
		}
	}

	// ---------- 入队 (v0.3.1 统一入口: 命令 add / 工具 queue_add 共用) ----------
	// 默认模式: 任务绑当前会话; 会话若为 blank(无 turn/start, 即 GUI 里的"新会话"),
	// 立即 followup 一条极简确认消息让 agent 跑一个轻量 turn 完成"转正" ——
	// 产生真实 turn/start → 侧边栏可见、离开不消失、不会被 connectWorkspace 当
	// 新会话复用。确认 turn 只回一句"已创建, 等待派发", 不执行任何操作。
	// config.ownSession=true 时保留 v0.3.0 行为: 排队即新建专属会话。
	async function enqueueTask({ state, id, content, at, agent }) {
		const session = agent?.session;
		const sessionId = agent?.id ?? session?.id ?? null;
		const task = {
			id, content, createdAt: new Date().toISOString(), status: "pending",
			...(sessionId ? { sessionId } : {}),
			...(at ? { scheduledAt: at } : {})
		};
		const when = at ? `于 ${beijingNowString(new Date(at))}` : "等低谷时段自动执行";
		if (cfg.ownSession) {
			// 专属会话模式 (默认关闭): 排队时新建独立会话
			const cwd = session?.header?.cwd;
			try {
				const created = await createTaskSession(cwd ?? "/workspace");
				task.sessionId = created.sessionId;
				task.ownSession = true;
				task.taskSession = true; // 真·专属会话: 取消时 dispose
			} catch (err) {
				ctx.logger?.warn?.(`dsh-taskqueue: 任务 #${id} 专属会话创建失败, 回退绑定当前会话: ${String(err?.message ?? err)}`);
			}
		} else {
			// 默认模式: blank 会话 → 极简确认 turn 转正
			const blank = session && !session.events.some((e) => e.type === "turn/start");
			if (blank && agent) {
				try {
					const confirm = createUserMessage({
						content: [{ type: "text", text: `[任务队列] 任务 #${id} 已入队, 等待派发执行。请仅回复"任务 #${id} 已创建, 等待派发", 不要执行任何其他操作、不要读取任何文件。` }],
						source: { kind: "user" }
					});
					task.ownSession = true; // 标记: 会话因本任务转正(取消时可归档移出列表)
					task.confirmMessageId = confirm.id;
					agent.followup(confirm);
				} catch (err) {
					ctx.logger?.warn?.(`dsh-taskqueue: 任务 #${id} 转正确认消息投递失败: ${String(err?.message ?? err)}`);
				}
			}
		}
		// 自动标题 (v0.3.1): 入队即设, agent 第一次回复前标题必然已在; 不覆盖已有标题
		try {
			const hasTitle = session?.events?.some((e) => e.type === "session/title");
			if (session && !hasTitle) {
				session.append("session/title", {
					title: `任务 #${id} · ${oneLine(content).slice(0, 20)}`,
					messageSeqs: [],
					source: { kind: "user" }
				});
			}
		} catch (err) {
			ctx.logger?.warn?.(`dsh-taskqueue: 设置任务 #${id} 会话标题失败: ${String(err?.message ?? err)}`);
		}
		state.tasks.push(task);
		// 入队唯一提示: notice/banner 横幅 (非 surface 事件, 零 token)
		// v0.4.1: 内容完整显示不截断 (原 slice(0,40) 截断已去掉, 横幅可折叠长内容无妨)
		// v0.4.3: openPanel=true → 横幅出现即展开手风琴面板, 新任务可直接编辑 (未派发前)
		appendQueueBanner(session, {
			openPanel: true,
			title: `任务 #${id} 已入队`,
			lines: [`执行: ${when}`, `内容: ${content}`]
		});
		return { id, when };
	}

	/** 取消任务 (命令/工具共用): 转正会话只绑本任务一个 pending → 归档移出列表; 专属会话 dispose */
	async function cancelTask(state, id) {
		const t = state.tasks.find((x) => x.id === id && x.status === "pending");
		if (!t) return { kind: "error", text: `未找到排队中的任务 #${id}` };
		t.status = "cancelled";
		let removed = false;
		if (t.taskSession && t.sessionId) {
			await disposeTaskSession(t.sessionId);
			removed = true;
		} else if (t.ownSession && t.sessionId) {
			const only = state.tasks.filter((x) => x.status === "pending" && x.sessionId === t.sessionId).length === 1;
			if (only) {
				try {
					await ctx.get?.("workspaceRegistry")?.archiveSession(t.sessionId);
					removed = true;
				} catch (err) {
					ctx.logger?.warn?.(`dsh-taskqueue: 归档任务 #${id} 会话失败: ${String(err?.message ?? err)}`);
				}
			}
		}
		return { kind: "success", text: `任务 #${id} 已取消${removed ? " (任务会话已移出列表)" : ""}` };
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
			// 消息前加"自动调度任务 #N"提示, 方便在对话里一眼识别出是队列自动派发的
			// (而非自己手动输入的消息), 并知道是第几号任务;
			// 末尾追加 DISPATCH_TRAILING_HINT (v0.3.2): 要求 agent 第一次回答时
			// 根据当前对话内容用 session_rename 重命名本会话标题。
			content: [{ type: "text", text: `[任务队列] 【自动调度任务 #${task.id}】 ${task.content}${DISPATCH_TRAILING_HINT}` }],
			// source.kind="user" 让 GUI 把它渲染成普通用户气泡(与 /goal 插件一致),
			// 派发后在对话中形成可见的记录, 而不是折叠的"上下文注入"灰条。
			source: { kind: "user" }
		});
		task.messageId = message.id; // 记录消息 id, 用于重启后校验消息是否仍存活
		agent.followup(message);
		task.status = "dispatched";
		task.dispatchedAt = new Date().toISOString();
		// 自动标题 (v0.3.0): 若目标会话尚无标题, 按任务内容设置确定性标题 —
		// 让派发窗口在侧边栏立即可辨识 (source.kind="user" 固定标题, 不触发 LLM 生成)。
		try {
			const session = agent.session;
			const hasTitle = session?.events?.some((e) => e.type === "session/title");
			if (session && !hasTitle) {
				const title = `任务 #${task.id} · ${oneLine(task.content).slice(0, 20)}`;
				session.append("session/title", {
					title,
					messageSeqs: [],
					source: { kind: "user" }
				});
			}
		} catch (err) {
			ctx.logger?.warn?.(`dsh-taskqueue: 设置任务 #${task.id} 会话标题失败: ${String(err?.message ?? err)}`);
		}
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
			// 1) 派发到期任务 (pending); v0.4.3: 编辑锁中的任务 (及同会话后续任务) 跳过
			cleanupStaleLocks(state);
			const due = state.tasks.filter((t) => t.status === "pending"
				&& (t.scheduledAt ? now >= Date.parse(t.scheduledAt) : !isBeijingPeak(windowsNow))
				&& !isTaskLocked(state, t));
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
					// v0.3.1: 任务绑当前会话; blank 会话走极简确认 turn 转正
					const r = await enqueueTask({ state, id, content, at, agent: invocation?.agent });
					return { kind: "success", text: `任务 #${r.id} 已入队` };
				});
			}
			case "list": {
				const state = await readState();
				const pending = state.tasks.filter((t) => t.status === "pending");
				const rest2 = state.tasks.filter((t) => t.status !== "pending");
				const windowsNow = await resolveWindows();
				const peak = isBeijingPeak(windowsNow);
				// v0.4.3: 横幅文字精简 (历史移到面板底部), openPanel=true 出现即展开手风琴
				appendQueueBanner(invocation?.agent?.session, {
					openPanel: true,
					title: `任务队列 · 排队中 ${pending.length} 个`,
					lines: [
						pending.length === 0
							? "(队列为空)"
							: `排队中 ${pending.length} 个 / 历史 ${rest2.length} 个`,
						"任务列表见下方面板: 点行展开可 编辑/取消/立即派发"
					]
				});
				return { kind: "success", text: `任务队列: ${pending.length} 排队中 / ${rest2.length} 历史 (详情见横幅面板)` };
			}
			case "cancel": {
				const id = parseInt(rest, 10);
				if (!Number.isInteger(id)) return { kind: "error", text: "用法: /queue cancel <id>" };
				return await mutateState(async (state) => {
					const r = await cancelTask(state, id);
					if (r.kind === "error") return r;
					// v0.4.2: 取消反馈注入横幅卡片 (完整内容)
					const t = state.tasks.find((x) => x.id === id);
					appendQueueBanner(invocation?.agent?.session, {
						title: `任务 #${id} 已取消`,
						lines: t ? [`内容: ${t.content}`] : []
					});
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
					// v0.4.2: 修改反馈注入横幅卡片 (完整新内容)
					appendQueueBanner(invocation?.agent?.session, {
						title: `任务 #${t.id} 内容已更新`,
						lines: [`新内容: ${t.content}`]
					});
					return { kind: "success", text: `任务 #${t.id} 内容已更新` };
				});
			}
			case "run-now": {
				const id = parseInt(rest, 10);
				if (!Number.isInteger(id)) return { kind: "error", text: "用法: /queue run-now <id>" };
				return await mutateState(async (state) => {
					const t = state.tasks.find((x) => x.id === id && x.status === "pending");
					if (!t) return { kind: "error", text: `未找到排队中的任务 #${id}` };
					if (isTaskLocked(state, t)) return { kind: "error", text: `任务 #${id} 正在编辑中, 暂不能派发 (保存或取消编辑后再试)` };
					const agent = await findTargetAgent(state, t);
					if (!agent) return { kind: "error", text: "任务绑定会话已离线且无兜底会话, 稍后再试" };
					await dispatchTask(state, t, agent);
					// v0.4.2: 派发反馈注入横幅卡片 (完整内容)
					appendQueueBanner(invocation?.agent?.session, {
						title: `任务 #${id} 已派发`,
						lines: [`内容: ${t.content}`, `派发到: ${shortSession(agent.id)}`]
					});
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
					"/queue add <内容>                   入队(绑当前会话), 等低谷自动执行",
					"/queue add --at \"HH:mm\" <内容>    指定时间执行 (HH:mm 或 YYYY-MM-DD HH:mm)",
					"/queue list                         查看队列(含各任务绑定会话)",
					"/queue cancel <id>                  取消任务(任务会话移出列表)",
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
		description: "把任务加入低谷时段任务队列(任务绑定当前会话执行): 默认等官方低谷价时段(动态解析官方页)自动派发到当前会话执行, 也可用 at 指定时间(北京时区 HH:mm 或 YYYY-MM-DD HH:mm)",
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
			const at = args.at ? parseAt(args.at) : null;
			if (args.at && !at) throw new Error("at 时间格式无效 (HH:mm 或 YYYY-MM-DD HH:mm, 且需为未来)");
			return await mutateState(async (state) => {
				const id = state.tasks.length ? Math.max(...state.tasks.map((t) => t.id)) + 1 : 1;
				// v0.3.1: 任务绑当前会话; blank 会话走极简确认 turn 转正
				const r = await enqueueTask({ state, id, content: args.content, at, agent: exec?.agent });
				return { id: r.id, text: `任务 #${r.id} 已入队` };
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
		execute: async (_args, exec) => {
			const state = await readState();
			const windowsNow = await resolveWindows();
			const peak = isBeijingPeak(windowsNow);
			const pending = state.tasks.filter((t) => t.status === "pending");
			const done = state.tasks.filter((t) => t.status !== "pending");
			// v0.4.3: 横幅文字精简 (历史移到面板底部), openPanel=true 出现即展开手风琴
			appendQueueBanner(exec?.agent?.session, {
				openPanel: true,
				title: `任务队列 · 排队中 ${pending.length} 个`,
				lines: [
					pending.length === 0
						? "(队列为空)"
						: `排队中 ${pending.length} 个 / 历史 ${done.length} 个`,
					"任务列表见下方面板: 点行展开可 编辑/取消/立即派发"
				]
			});
			return { text: `任务队列: ${pending.length} 排队中 / ${done.length} 历史 (详情见横幅面板)` };
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
		execute: async (args, exec) => {
			return await mutateState(async (state) => {
				const r = await cancelTask(state, args.id);
				if (r.kind === "error") throw new Error(r.text);
				// v0.4.2: 取消反馈注入横幅卡片 (完整内容)
				const t = state.tasks.find((x) => x.id === args.id);
				appendQueueBanner(exec?.agent?.session, {
					title: `任务 #${args.id} 已取消`,
					lines: t ? [`内容: ${t.content}`] : []
				});
				return { text: r.text };
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
		execute: async (args, exec) => {
			return await mutateState(async (state) => {
				const t = state.tasks.find((x) => x.id === args.id && x.status === "pending");
				if (!t) throw new Error(`未找到排队中的任务 #${args.id}`);
				t.content = args.content;
				// v0.4.2: 修改反馈注入横幅卡片 (完整新内容)
				appendQueueBanner(exec?.agent?.session, {
					title: `任务 #${t.id} 内容已更新`,
					lines: [`新内容: ${t.content}`]
				});
				return { text: `任务 #${t.id} 内容已更新` };
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
		execute: async (args, exec) => {
			return await mutateState(async (state) => {
				const t = state.tasks.find((x) => x.id === args.id && x.status === "pending");
				if (!t) throw new Error(`未找到排队中的任务 #${args.id}`);
				if (isTaskLocked(state, t)) throw new Error(`任务 #${args.id} 正在编辑中, 暂不能派发 (保存或取消编辑后再试)`);
				const agent = await findTargetAgent(state, t);
				if (!agent) return { text: `任务 #${t.id} 绑定会话已离线且无兜底会话, 保持排队` };
				await dispatchTask(state, t, agent);
				// v0.4.2: 派发反馈注入横幅卡片 (完整内容)
				appendQueueBanner(exec?.agent?.session, {
					title: `任务 #${t.id} 已派发`,
					lines: [`内容: ${t.content}`, `派发到: ${shortSession(agent.id)}`]
				});
				return { text: `任务 #${t.id} 已立即派发到 ${shortSession(agent.id)}` };
			});
		},
		presentCall: (args) => ({ card: "generic", title: "立即派发任务", kind: "other", rawInput: args })
	}));

	// ---------- /queue RPC 通道 (v0.4.0) ----------
	// 浏览器端 client 插件 (dsh-notice-banner 队列面板) 通过框架通用 RPC
	// (ctx.connection.rpc.call("/queue", "<endpoint>", payload)) 直接读写队列,
	// 不走模型回合、零 token —— 解决"查看/修改任务列表不方便、修改无弹窗反馈"。
	// 通道信任策略与 /api 一致 (不传 authority → 沿用 client-connection 的
	// trustedHosts, 隧道/局域网域名均可访问)。端点:
	//   list   → { tasks: [...], pendingCount, peak, windowSource, targetSession* }
	//   edit   { id, content }   → 改排队中任务内容
	//   cancel { id }            → 取消
	//   runnow { id }            → 立即派发 (不等低谷; 编辑锁中阻止)
	//   editstart { id }         → 锁定任务 (客户端开始编辑, 防派发) (v0.4.3)
	//   editend { id }           → 释放锁 (保存/取消/卸载) (v0.4.3)
	// 返回 { ok: true, value } | { ok: false, error: { code, message } }。
	// options 传 {}: 不设 authority → register 用 this.trustedHosts (与 /api 同源
	// 信任列表, 隧道/局域网域名可访问); 传 { authority: "loopback" } 则只认回环。
	// ⚠️ options 不能省略: register 里直接读 options.authority, 缺参会 TypeError。
	ctx.get?.("connection")?.rpc?.handle?.("/queue", async (endpoint, payload) => {
		try {
			switch (endpoint) {
			case "list": {
				const state = await readState();
				const windowsNow = await resolveWindows();
				const peak = isBeijingPeak(windowsNow);
				cleanupStaleLocks(state);
				const tasks = state.tasks.map((t) => ({
					id: t.id,
					content: t.content,
					status: t.status,
					statusText: STATUS_TEXT[t.status] ?? t.status,
					createdAt: t.createdAt,
					scheduledAt: t.scheduledAt ?? null,
					sessionShort: shortSession(t.sessionId),
					whenText: t.scheduledAt
						? `定于 ${beijingNowString(new Date(t.scheduledAt)).slice(5, 16)}`
						: (peak ? "等低谷" : "低谷中"),
					locked: isTaskLocked(state, t) // v0.4.3: 编辑锁标记 (客户端显示"编辑中")
				}));
				return { ok: true, value: {
					tasks,
					pendingCount: tasks.filter((t) => t.status === "pending").length,
					targetSessionId: state.targetSessionId,
					targetSessionShort: shortSession(state.targetSessionId),
					peak,
					windowSource
				} };
			}
			case "edit": {
				const id = payload?.id;
				const content = typeof payload?.content === "string" ? payload.content.trim() : "";
				if (!Number.isInteger(id) || !content) {
					return { ok: false, error: { code: "bad-request", message: "需要 id(整数) 与 content(非空字符串)" } };
				}
				return await mutateState(async (state) => {
					const t = state.tasks.find((x) => x.id === id && x.status === "pending");
					if (!t) return { ok: false, error: { code: "not-found", message: `未找到排队中的任务 #${id}` } };
					t.content = content;
					if (state.locks) delete state.locks[id]; // 保存成功即释放编辑锁
					return { ok: true, value: { id: t.id, content: t.content } };
				});
			}
			case "cancel": {
				const id = payload?.id;
				if (!Number.isInteger(id)) return { ok: false, error: { code: "bad-request", message: "需要 id(整数)" } };
				return await mutateState(async (state) => {
					const r = await cancelTask(state, id);
					if (r.kind === "error") return { ok: false, error: { code: "not-found", message: r.text } };
					if (state.locks) delete state.locks[id];
					return { ok: true, value: { id, text: r.text } };
				});
			}
			case "runnow": {
				const id = payload?.id;
				if (!Number.isInteger(id)) return { ok: false, error: { code: "bad-request", message: "需要 id(整数)" } };
				return await mutateState(async (state) => {
					const t = state.tasks.find((x) => x.id === id && x.status === "pending");
					if (!t) return { ok: false, error: { code: "not-found", message: `未找到排队中的任务 #${id}` } };
					if (isTaskLocked(state, t)) {
						return { ok: false, error: { code: "locked", message: `任务 #${id} 正在编辑中, 暂不能派发 (保存或取消编辑后再试)` } };
					}
					const agent = await findTargetAgent(state, t);
					if (!agent) return { ok: false, error: { code: "unavailable", message: "任务绑定会话已离线且无兜底会话, 稍后再试" } };
					await dispatchTask(state, t, agent);
					return { ok: true, value: { id, text: `任务 #${id} 已立即派发到 ${shortSession(agent.id)}` } };
				});
			}
			case "editstart": {
				const id = payload?.id;
				if (!Number.isInteger(id)) return { ok: false, error: { code: "bad-request", message: "需要 id(整数)" } };
				return await mutateState(async (state) => {
					const t = state.tasks.find((x) => x.id === id && x.status === "pending");
					if (!t) return { ok: false, error: { code: "not-found", message: `未找到排队中的任务 #${id}` } };
					state.locks = state.locks ?? {};
					state.locks[id] = { sessionId: t.sessionId ?? null, since: new Date().toISOString() };
					return { ok: true, value: { id } };
				});
			}
			case "editend": {
				const id = payload?.id;
				if (!Number.isInteger(id)) return { ok: false, error: { code: "bad-request", message: "需要 id(整数)" } };
				return await mutateState(async (state) => {
					if (state.locks) delete state.locks[id];
					return { ok: true, value: { id } };
				});
			}
			default:
				return { ok: false, error: { code: "bad-request", message: `未知端点 ${endpoint}` } };
			}
		} catch (err) {
			ctx.logger?.warn?.(`dsh-taskqueue: /queue RPC ${endpoint} 失败: ${String(err?.message ?? err)}`);
			return { ok: false, error: { code: "internal", message: String(err?.message ?? err) } };
		}
	}, {});

	// ---------- 会话标题工具 (v0.3.0) ----------
	// agent 发现本会话第一条消息是队列自动派发任务时, 可在回答时顺手把会话标题
	// 改成更贴切的标题 (用户需求: "agent 顺便把当前的会话标题修改成合适的标题")。
	ctx.tools.register(defineTool({
		name: "session_rename",
		description: "把当前会话的标题修改为指定标题 (固定标题, 不会再次被自动生成覆盖; 适合在队列自动派发任务等场景给会话起个贴切的名字)",
		parameters: { title: { type: "string", required: true, description: "新会话标题" } },
		output: {
			schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true } } },
			render: (_args, value) => [{ type: "text", text: value.text }]
		},
		execute: async (args, exec) => {
			const session = exec?.agent?.session;
			if (!session) throw new Error("无法获取当前会话");
			const normalized = String(args.title ?? "").trim();
			if (!normalized) throw new Error("标题不能为空");
			// 优先走 sessionTitle 服务 (规范化 + 固定 + 取代在途自动生成), 退化则直接 append
			// (source=user + messageSeqs=[] 满足标题不变式: user 来源必须空 messageSeqs)。
			const titles = ctx.get?.("sessionTitle");
			if (titles?.rename) {
				const accepted = titles.rename(session, normalized);
				return { text: `会话标题已改为: ${accepted.title}` };
			}
			session.append("session/title", {
				title: normalized,
				messageSeqs: [],
				source: { kind: "user" }
			});
			return { text: `会话标题已改为: ${normalized}` };
		},
		presentCall: (args) => ({ card: "generic", title: "修改会话标题", kind: "other", rawInput: args })
	}));
}
