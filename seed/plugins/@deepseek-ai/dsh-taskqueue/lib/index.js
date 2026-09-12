import { readFileSync } from "node:fs";
import { readFile, writeFile, rename, stat, chown, chmod, mkdir, appendFile } from "node:fs/promises";
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
 *   - 也可以指定"容器重启后"执行 (--on restart / when="restart", v0.6.0): 容器每次
 *     重启后的首个 tick 自动派发, 每次重启只尝试一次 (派发失败保持排队,
 *     下次重启再试 —— "已重启未发送又重启, 则再次重启后发送");
 *     重启检测基于 /proc/1/stat 的 PID1 starttime 变化 (容器重启必然新进程),
 *     状态文件持久化 lastBootId 记录上次已处理的重启。
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
 *   /queue add --on restart <内容>     容器重启后自动执行 (v0.6.0; v0.8.5 起同样遵循错峰: 高峰重启则等低谷)
 *   /queue add -r <内容>               同 --on restart (v0.6.1, iOS 单横线简写)
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
// v0.7.0: 错峰出行模式 (offpeak mode) —— 设置里开启后, 高峰期间所有用户消息
// (已有/新会话) 默认入队 (客户端把 session.prompt 转成 /queue RPC add), 平峰/关闭时正常发送。
const MODE_FILE = "/data/dsh/offpeak-mode.json";
const PRICING_PAGE_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing";
const WINDOW_CACHE_TTL_MS = 30 * 60 * 1000;
const CHECK_INTERVAL_MS = 60000;
// 派发后超过该时长仍未消费(消息丢失)才重派发, 避免和正常执行竞态
const REDISPATCH_GRACE_MS = 2 * 60 * 1000; // ⚠️ 已废弃(E): 旧"丢消息重发"宽限期, 由 claim 观测+熔断取代

// ---------- E 降级 / 熔断 (2026-09-10; 原则: 缺能力静默停用, 禁止重试风暴) ----------
// 单向状态机: pending(排队) → dispatched(已派发) → done | failed; cancelled 为人工终态。
// 自动路径**只处理 pending**; dispatched 若无 claim 只会被观测/熔断为 failed, **永不自动重发**。
// 2026-09-09 事故链: 无终态 + "丢消息重发"校验在 0.1.2 resume 语义下把已执行任务误判为丢失
//   → 每 ~3 分钟无限重发历史任务。本段即针对该链的 fail-safe 改造。
const SCHEMA_VERSION = 3;                 // 状态表版本(含终态字段; 落盘后可用于确认新代码已装载)
const TASK_FAIL_BREAKER = 3;              // 同任务连续 N 次无 claim/派发异常 → failed(停发该任务)
const TICK_FAIL_BREAKER = 5;              // tick 全局连续异常 ≥N 次 → 自动派发路径整体停用
const CLAIM_TIMEOUT_MS = 10 * 60 * 1000;  // 派发后多久仍无 claim 且不在 inbox → 记一次"未确认"
const TERMINAL_STATUS = new Set(["done", "failed", "cancelled"]);
// 派发消息末尾的固定提示 (v0.3.2): 除用户输入的任务内容外, 追加一段指令,
// 要求 agent 在第一次回答时根据当前对话内容用 session_rename 工具把本会话
// 标题重命名为贴切的任务标题 —— 派发窗口在侧边栏的标题贴合实际任务。
const DISPATCH_TRAILING_HINT =
	"\n\n[末尾提示] 请在第一次回答时, 根据当前对话内容, 用 session_rename 工具把本会话标题重命名为贴切的任务标题。";

// 内置兜底 (2026-08-23 官方: 周一至周五 9-12/14-18 高峰, 其余空闲)
const FALLBACK_WINDOWS = { weekdaysOnly: true, windows: [[9, 12], [14, 18]] };

// ---------- 容器重启检测 (v0.6.0) ----------
// "重启后发送"时机: 任务在容器重启后**且处于低谷时段**的首个 tick 自动派发 (v0.8.5 遵循错峰:
// 重启发生在高峰 → 任务标记 armed 持久化, 等低谷窗口到达再执行; armed 在尝试派发时消费)。
// 检测依据: 容器重启 = PID1 (dsh-entrypoint) 是全新进程 → /proc/1/stat 的
// starttime (第22字段) 必然变化; host 的 boot_id 不随容器重启变化, 不可用。
// 解析: 先按 ")" 切分 (comm 可能含空格/括号), 再取剩余字段第 20 个 (0-based 19)。
// 返回 null 表示无法读取 (此时跳过重启触发检测, 不误派发)。
function readBootId() {
	try {
		const s = readFileSync("/proc/1/stat", "utf8");
		const starttime = s.split(")")[1]?.trim().split(/\s+/)[19];
		return starttime ? `pid1:${starttime}` : null;
	} catch {
		return null;
	}
}

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

let stateFileMeta = null; // 首次写入时记住 STATE_FILE 原属主/权限 (供原子写保留)
async function writeState(state) {
	try {
		// 原子写 (tmp + rename): 避免写一半崩溃/并发截断产生 0 字节 taskqueue.json
		// —— readState 遇解析失败会回退到空表, 那等于丢整个队列历史 (2026-09-10 加固)。
		const tmp = `${STATE_FILE}.tmp`;
		await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
		// 保持原属主/权限: 原子 rename 会以当前进程身份生成新 inode, 否则属主会从
		// dockeruser(1028) 漂成 root (权限漂移正是 09-09 credentials 事故的同类风险)。
		try {
			if (stateFileMeta === null) {
				stateFileMeta = await stat(STATE_FILE)
					.then((st) => ({ uid: st.uid, gid: st.gid, mode: st.mode & 0o777 }))
					.catch(() => false);
			}
			if (stateFileMeta) {
				await chown(tmp, stateFileMeta.uid, stateFileMeta.gid);
				await chmod(tmp, stateFileMeta.mode);
			}
		} catch { /* 非 root/无权限 → 忽略, 不影响写盘 */ }
		await rename(tmp, STATE_FILE);
		return true;
	} catch {
		return false;
	}
}

// ---------- 错峰出行模式状态 (v0.7.0 / v0.8.0 / v0.8.3) ----------
// 独立状态文件 (与队列任务状态分离, 设置项不随队列滚动):
//   { enabled: boolean, exempt: { [sessionId]: true }, debug: "auto" | "peak" | "offpeak" }
//   v0.8.0 新增 exempt: 单会话豁免 map —— 豁免会话高峰时段照常发送 (客户端拦截器放行)。
//   v0.8.3 新增 debug: 强制时段 (调试用) —— "peak" 强制当前为高峰、"offpeak" 强制平峰,
//     "auto"(默认) = 按官方页判定。强制只影响"时段口径", 不区分客户端拦截与服务端派发:
//     强制 peak → 消息入队且队列不派发; 强制 offpeak → 消息直发且到期任务立即派发。
async function readMode() {
	try {
		const m = JSON.parse(await readFile(MODE_FILE, "utf8"));
		return {
			enabled: m?.enabled === true,
			exempt: (m?.exempt && typeof m.exempt === "object" && !Array.isArray(m.exempt)) ? m.exempt : {},
			debug: normalizeDebug(m?.debug)
		};
	} catch {
		return { enabled: false, exempt: {}, debug: "auto" };
	}
}

async function writeMode(mode) {
	try {
		// 原子写 (tmp + rename): 与 taskqueue.json 同纪律, 避免写一半留下残缺 JSON
		const tmp = `${MODE_FILE}.tmp`;
		await writeFile(tmp, JSON.stringify(mode, null, 2), "utf8");
		await rename(tmp, MODE_FILE);
		return true;
	} catch {
		return false;
	}
}

// ---------- 强制时段 (debug, v0.8.3) ----------
// 目的: 官方低谷/高峰窗口只在工作日固定时段出现, 平峰(周末/夜间)无法实测错峰功能。
// 用法: /queue debug peak|offpeak|auto (或 RPC mode.debug)。
const DEBUG_VALUES = ["auto", "peak", "offpeak"];
function normalizeDebug(v) {
	return DEBUG_VALUES.includes(v) ? v : "auto";
}
/** 当前是否高峰: 强制值优先于官方页判定 (唯一口径, 客户端与服务端共用同一返回值) */
function effectivePeak(mode, windows, now = new Date()) {
	if (mode?.debug === "peak") return true;
	if (mode?.debug === "offpeak") return false;
	return isBeijingPeak(windows, now);
}
/** 时段来源文案: 强制时明确标注 debug, 便于"忘记关"时一眼可见 */
function peakSourceText(mode, windowSource) {
	if (mode?.debug === "peak") return `强制高峰(debug)`;
	if (mode?.debug === "offpeak") return `强制平峰(debug)`;
	return windowSource;
}
/** mode.get / mode.set / mode.exempt / mode.debug 的统一返回体 */
function modeValue(mode, windows, windowSource) {
	return {
		enabled: mode.enabled,
		peak: effectivePeak(mode, windows),
		windowSource,
		peakSource: peakSourceText(mode, windowSource),
		debug: mode.debug,
		exempt: mode.exempt
	};
}

// ---------- 客户端诊断上报 (v0.8.3) ----------
// 背景: 错峰拦截器跑在浏览器里, 之前"拦截器没装上"完全静默 —— 只能靠用户现象猜。
// 客户端 apply/药丸渲染/拦截命中都上报一行, 服务端落盘 + 保留最近若干条供 mode.get 回读,
// 这样没有浏览器控制台也能远程取证 (log/taskqueue/offpeak-debug.log)。
const DIAG_LOG = "/workspace/log/taskqueue/offpeak-debug.log";
const diagRecent = [];
async function appendDiag(entry) {
	const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
	diagRecent.push({ at: entry.at ?? new Date().toISOString(), ...entry });
	if (diagRecent.length > 20) diagRecent.splice(0, diagRecent.length - 20);
	try {
		await mkdir("/workspace/log/taskqueue", { recursive: true });
		await appendFile(DIAG_LOG, line + "\n", "utf8");
	} catch { /* 落盘失败不影响功能 (仅诊断) */ }
}

const STATUS_TEXT = {
	pending: "排队中",
	dispatched: "已派发",
	done: "已完成",
	failed: "已失败",
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

	// ---------- 会话日志读取 (v0.8.4, 0.1.2 适配) ----------
	// ⚠️ 0.1.2-rc.1 起宿主 `Session` **没有 `events` 属性**了 (dsh-session: 只有
	// header/surface/seq/eventAt/snapshotEvents()/ownEvents())。历史上有 5 处读
	// `session.events`, 于是全部静默失效 —— 其中**最严重的是 blank 判定**:
	// `Array.isArray(session?.events)` 恒 false ⇒ blank 恒 false ⇒ 「新会话转正」
	// (v0.3.1 的防串台机制) **从未触发**, GUI 会继续把 blank 会话当"新会话"复用,
	// 多个任务落进同一个新会话 (2026-09-12 用户实测反馈)。
	// 统一走本 helper: 旧版取 session.events, 0.1.2 取 snapshotEvents()/ownEvents()。
	function readSessionEvents(session) {
		if (!session) return null;
		if (Array.isArray(session.events)) return session.events; // < 0.1.2
		try {
			if (typeof session.snapshotEvents === "function") return session.snapshotEvents();
		} catch { /* 日志不可读 → 试下一个 */ }
		try {
			if (typeof session.ownEvents === "function") return session.ownEvents();
		} catch { /* 都拿不到 */ }
		return null;
	}
	/**
	 * 是否仍是 GUI 里的"新会话"(blank)。
	 * 与宿主同口径 (dsh-api-session-controller 服务端半: `blank = metadata?.blank ?? session.seq === 0`,
	 * 增量规则 `state.blank && event.type !== "turn/start"`): 日志里没有 turn/start 即 blank。
	 * 读不到日志 → 返回 false (fail-safe: 宁可不发转正确认 turn, 也不误发/抛错)。
	 */
	function isBlankSession(session) {
		if (!session) return false;
		if (typeof session.seq === "number" && session.seq === 0) return true; // 空日志必为 blank
		const events = readSessionEvents(session);
		if (events === null) return false;
		return !events.some((e) => e && e.type === "turn/start");
	}
	/** 日志里是否已有某类型事件 (读不到日志 → null = 未知, 由调用方决定默认) */
	function hasSessionEvent(session, type) {
		const events = readSessionEvents(session);
		if (events === null) return null;
		return events.some((e) => e && e.type === type);
	}

	// ---------- 入队 (v0.3.1 统一入口: 命令 add / 工具 queue_add 共用) ----------
	// 默认模式: 任务绑当前会话; 会话若为 blank(无 turn/start, 即 GUI 里的"新会话"),
	// 立即 followup 一条极简确认消息让 agent 跑一个轻量 turn 完成"转正" ——
	// 产生真实 turn/start → 侧边栏可见、离开不消失、不会被 connectWorkspace 当
	// 新会话复用。确认 turn 只回一句"已创建, 等待派发", 不执行任何操作。
	// config.ownSession=true 时保留 v0.3.0 行为: 排队即新建专属会话。
	async function enqueueTask({ state, id, content, at, when, agent: agentIn, sessionId: explicitSessionId }) {
		const explicit = explicitSessionId ?? null;
		// v0.8.4: 只给 sessionId 的调用方 (高峰期客户端拦截 RPC add) 内部反查 live agent ——
		// 否则拿不到 session ⇒ blank 判定(转正) 与队列横幅都会静默丢失
		const agent = agentIn ?? (explicit ? ctx.agents?.get?.(explicit) ?? null : null);
		const session = agent?.session;
		// v0.7.0: RPC add (客户端错峰拦截) 无 agent 但带明确 sessionId → 优先用显式会话绑定
		const sessionId = explicit ?? agent?.id ?? session?.id ?? null;
		const task = {
			id, content, createdAt: new Date().toISOString(), status: "pending",
			...(sessionId ? { sessionId } : {}),
			...(at ? { scheduledAt: at } : {}),
			// v0.6.0: when="restart" → 容器重启后派发 (trigger 字段, 不入 scheduledAt)
			...(when === "restart" ? { trigger: "restart" } : {})
		};
		const whenText = at
			? `于 ${beijingNowString(new Date(at))}`
			: when === "restart"
				? "容器重启后"
				: "等低谷时段自动执行";
		let engaged = false; // v0.8.4: 是否因本任务触发 blank 会话转正 (确认 turn)
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
			// 默认模式: blank 会话 → 极简确认 turn 转正 (防串台: GUI 会复用 blank 会话当"新会话")
			// v0.8.4 (2026-09-12): 0.1.2 起 `session.events` 已不存在, 旧写法
			// `Array.isArray(session?.events)` 恒 false ⇒ blank 恒 false ⇒ **转正从未触发**;
			// 改用 isBlankSession() (与宿主同口径: 日志无 turn/start 即 blank)。
			// 同一 blank 会话在"第一个确认 turn 真正开始前"连发多条消息时, 不要重复投确认 turn
			// (turn/start 出现前 session 仍是 blank; 已有 pending 的 confirmMessageId 即视为转正中)
			const engaging = state.tasks.some((t) => t.sessionId === sessionId && t.status === "pending" && t.confirmMessageId);
			const blank = !engaging && isBlankSession(session);
			if (blank && !agent) {
				ctx.logger?.warn?.(`dsh-taskqueue: 任务 #${id} 命中 blank 会话 ${shortSession(sessionId)} 但该会话无 live agent, 无法转正 (会话仍会被 GUI 当"新会话"复用)`);
				void appendDiag({ event: "enqueue.blank-no-agent", taskId: id, sessionId: shortSession(sessionId) });
			}
			if (blank && agent) {
				try {
					const confirm = createUserMessage({
						content: [{ type: "text", text: `[任务队列] 任务 #${id} 已入队, 等待派发执行。请仅回复"任务 #${id} 已创建, 等待派发", 不要执行任何其他操作、不要读取任何文件。` }],
						source: { kind: "user" }
					});
					task.ownSession = true; // 标记: 会话因本任务转正(取消时可归档移出列表)
					task.confirmMessageId = confirm.id;
					agent.followup(confirm);
					engaged = true;
					void appendDiag({ event: "enqueue.engaged", taskId: id, sessionId: shortSession(sessionId) });
				} catch (err) {
					ctx.logger?.warn?.(`dsh-taskqueue: 任务 #${id} 转正确认消息投递失败: ${String(err?.message ?? err)}`);
					void appendDiag({ event: "enqueue.engage-failed", taskId: id, error: String(err?.message ?? err) });
				}
			}
		}
		// 自动标题 (v0.3.1): 入队即设, agent 第一次回复前标题必然已在; 不覆盖已有标题
		try {
			// v0.8.4: 0.1.2 起 session.events 不存在 → readSessionEvents(); 读不到(null)按"无标题"处理(旧行为)
			const hasTitle = hasSessionEvent(session, "session/title") === true;
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
		// v0.8.5: 横幅内容行只给短预览 (与 v0.4.1 之前一致), 避免把整段长消息糊在会话里;
		// 全文仍在队列面板 (横幅内可展开) 中查看/编辑 —— 面板读的是任务状态文件, 不受此处影响。
		appendQueueBanner(session, {
			openPanel: true,
			title: `任务 #${id} 已入队`,
			lines: [`执行: ${whenText}`, `内容: ${oneLine(content).slice(0, 40)}${oneLine(content).length > 40 ? "…" : ""}`]
		});
		return { id, when: whenText, engaged };
	}

	/** v0.5.0: 已派发且派发消息仍在目标会话收件箱排队 (未被 claim 执行) —— "排队发送中",
	 *  可取消窗口。派发 = followup 进收件箱 + 立即标 dispatched; 若目标会话正在对话
	 *  (回合未结束), 消息躺在 inbox.nextTurn 排队等当前回合结束才被取走执行。 */
	function isQueuedSending(t) {
		if (t.status !== "dispatched" || !t.messageId) return false;
		try {
			const agent = ctx.agents.get(t.sessionId);
			if (!agent?.inbox) return false;
			return agent.inbox.locate(t.messageId) !== undefined;
		} catch { return false; }
	}

	/**
	 * 取消任务 (命令/工具/RPC 共用):
	 *   - pending: 排队中 → 直接取消 (转正会话归档/专属会话 dispose, 原逻辑)
	 *   - dispatched + 消息仍在收件箱 (v0.5.0): 已派发但目标会话正忙, 消息在
	 *     inbox 排队未执行 —— 视为"排队中"可取消: 标记 cancelled + Inbox.remove
	 *     撤回消息 (与 GUI 会话消息队列编辑同一持久化原语, 纯删除, 会话不会执行)。
	 *   - dispatched + 消息已被 claim 进会话历史: 已开始执行, 不可取消 (删除=改写历史)。
	 */
	async function cancelTask(state, id) {
		const t = state.tasks.find((x) => x.id === id);
		if (!t) return { kind: "error", text: `未找到任务 #${id}` };
		if (t.status === "cancelled") return { kind: "error", text: `任务 #${id} 已取消` };
		if (t.status === "dispatched") {
			try {
				const agent = ctx.agents.get(t.sessionId);
				if (t.messageId && agent?.inbox && agent.inbox.remove(t.messageId)) {
					t.status = "cancelled";
					t.cancelledAt = new Date().toISOString();
					return { kind: "success", text: `任务 #${id} 已取消 (派发消息仍在排队, 已撤回, 会话不会执行)` };
				}
			} catch (err) {
				ctx.logger?.warn?.(`dsh-taskqueue: 撤回任务 #${id} 派发消息失败: ${String(err?.message ?? err)}`);
			}
			return { kind: "error", text: `任务 #${id} 已派发并开始执行 (或绑定会话离线), 无法取消` };
		}
		if (t.status === "pending") {
			t.status = "cancelled";
			t.cancelledAt = new Date().toISOString();
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
		return { kind: "error", text: `任务 #${id} 状态异常, 无法取消` };
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

	// ================= E: 降级 / 熔断 / 终态 (2026-09-10) =================
	// 原则(写进代码与文档): 缺能力 → 静默停用该入口(fail-safe off); 禁止重试风暴;
	//   禁止把失败当成功; 禁止历史任务自动重放; 自动路径只处理 fresh pending。
	let autoDisabled = false;            // 本进程内自动派发是否停用 (重启自动重测能力, 不持久化)
	let autoDisabledReason = null;
	let tickFailStreak = 0;              // tick 全局连续异常计数 (某轮零异常即清零)
	const dispatchedMsgIds = new Map();  // messageId -> taskId (claim 事件快速过滤, 避免无关消息写盘)
	const claimedMsgIds = new Set();     // 已被 claim 成会话内 user/message 的 messageId (0.1.2 事件观察者维护)
	const titledSessions = new Set();    // 本插件已设过标题的会话 (替代不可用的 session.events 判定)

	/** 能力门闩: boot 时静态探测宿主能力, 缺失即停用自动路径 (宁停勿发) */
	function probeCapabilities() {
		const missing = [];
		const A = ctx.agents;
		if (!A) missing.push("agents 服务");
		else {
			if (typeof A.get !== "function") missing.push("agents.get");
			if (typeof A.list !== "function") missing.push("agents.list");
			if (typeof A.resume !== "function") missing.push("agents.resume");
		}
		if (typeof ctx.on !== "function") missing.push("ctx.on(事件订阅)");
		if (typeof ctx.effect !== "function") missing.push("ctx.effect");
		return missing.length ? { ok: false, reason: `缺少能力: ${missing.join(", ")}` } : { ok: true };
	}

	/** 停用自动派发 (只记日志, 不重试; 人工 run-now --force 不受影响) */
	function disableAuto(reason) {
		if (autoDisabled) return;
		autoDisabled = true;
		autoDisabledReason = reason;
		ctx.logger?.warn?.(`dsh-taskqueue: [fail-safe] 自动派发已整体停用 — ${reason} (历史任务不再自动处理; 需执行请人工 /queue run-now <id> --force)`);
	}

	const _caps = probeCapabilities();
	if (!_caps.ok) disableAuto(_caps.reason);

	/** 终态置位 (单向: 已到终态不再改; 顺手清掉 claim 索引) */
	function setTerminal(task, status, extra = {}) {
		if (TERMINAL_STATUS.has(task.status)) return false;
		task.status = status;
		task[status === "done" ? "doneAt" : status === "failed" ? "failedAt" : "cancelledAt"] = new Date().toISOString();
		Object.assign(task, extra);
		if (task.messageId) dispatchedMsgIds.delete(task.messageId);
		return true;
	}

	/** 熔断/失败告警: 日志 warn + (会话在线时)队列横幅; 绝不重发 */
	function alertTask(task, text) {
		ctx.logger?.warn?.(`dsh-taskqueue: ${text}`);
		try {
			const agent = task.sessionId ? ctx.agents.get?.(task.sessionId) : null;
			if (agent?.session) {
				appendQueueBanner(agent.session, {
					state: "warn",
					title: `任务 #${task.id} 已熔断`,
					lines: [text, `内容: ${oneLine(task.content).slice(0, 120)}`]
				});
			}
		} catch { /* 告警失败不影响主流程 */ }
	}

	/** 是否已被 claim 成会话内 user/message (完成证据; 只看同一进程内的会话视图, 不 resume) */
	function isMessageClaimed(task, agent) {
		if (!task.messageId) return false;
		if (claimedMsgIds.has(task.messageId)) return true; // 0.1.2: 观察者维护的权威来源
		try {
			const evs = readSessionEvents(agent?.session) ?? []; // v0.8.4: 0.1.2 适配 (原 session.events 恒 undefined)
			for (let i = evs.length - 1; i >= 0; i--) {
				const e = evs[i];
				if (e.type === "user/message" && e.data?.id === task.messageId) return true;
			}
		} catch { /* 会话不可读 → 无证据(也不重发) */ }
		return false;
	}

	/** 消息是否仍挂在 inbox (在飞, 非失败) */
	function isMessageInInbox(task, agent) {
		if (!task.messageId) return false;
		try {
			if (agent?.inbox?.nextTurn?.some((m) => m.id === task.messageId)) return true;
			if (agent?.inbox?.nextStep?.some((m) => m.id === task.messageId)) return true;
		} catch { /* 保守: 读不到按不在 inbox 处理 */ }
		return false;
	}

	/** 人工 force 重新排队 (E6: 历史任务只允许人工 run-now; 这是唯一允许回到 pending 的路径) */
	function requeueForManualForce(task) {
		task.lastTerminal = { status: task.status, at: task[task.status + "At"] ?? null };
		task.status = "pending";
		task.requeuedAt = new Date().toISOString();
		task.requeuedBy = "manual-force";
		delete task.dispatchedAt;
		delete task.messageId;
		task.roundId = null;
		task.dispatchCount = 0;
		task.unconfirmedCount = 0;
		task.failCount = 0;
		delete task.failReason;
	}

	/** claim = 消息被 agent 真正取走执行 → done (E3 完成依据; 只置终态, 从不重发) */
	async function onClaimed(payload) {
		try {
			const msgId = payload?.message?.id;
			if (!msgId || !dispatchedMsgIds.has(msgId)) return; // 快速过滤: 与队列无关的消息零写盘
			await mutateState((state) => {
				let hit = 0;
				for (const t of state.tasks) {
					if (t.status !== "dispatched" || t.messageId !== msgId) continue;
					if (setTerminal(t, "done", { doneTurn: payload?.turn ?? null, failCount: 0, unconfirmedCount: 0 })) hit++;
				}
				if (hit) ctx.logger?.info?.(`dsh-taskqueue: claim 确认 ${hit} 个任务 → done (messageId=${String(msgId).slice(0, 8)}${payload?.turn != null ? `, turn=${payload.turn}` : ""})`);
				return hit;
			});
		} catch (err) {
			ctx.logger?.warn?.(`dsh-taskqueue: claim 处理失败(忽略, 不重发): ${String(err?.message ?? err)}`);
		}
	}

	/** discarded = 派发消息被 inbox 丢弃, 从未执行 → failed (绝不重发) */
	async function onDiscarded(payload) {
		try {
			const msgId = payload?.message?.id;
			if (!msgId || !dispatchedMsgIds.has(msgId)) return;
			const failed = [];
			await mutateState((state) => {
				for (const t of state.tasks) {
					if (t.status !== "dispatched" || t.messageId !== msgId) continue;
					if (setTerminal(t, "failed", { failReason: "派发消息被 inbox 丢弃, 从未执行" })) failed.push(t);
				}
				return failed.length;
			});
			for (const t of failed) alertTask(t, `任务 #${t.id} 派发消息被 inbox 丢弃(从未执行) → failed (不重发)`);
		} catch (err) {
			ctx.logger?.warn?.(`dsh-taskqueue: discarded 处理失败(忽略, 不重发): ${String(err?.message ?? err)}`);
		}
	}

	// 订阅 claim/discarded (全局钩子: cordis dispatch 对 global 不做作用域过滤, 与 reconcile 同法)
	// 2026-09-10 (0.1.2 适配): agent.session.events 不再可用 → 用 session/event 观察者
	// 自行跟踪"派发消息已被 claim 成会话内 user/message"(只记我们关心的 messageId, 内存有界)
	ctx.on("session/event", (_session, event) => {
		try {
			const id = event?.data?.id;
			if (event?.type === "user/message" && id && dispatchedMsgIds.has(id)) claimedMsgIds.add(id);
		} catch { /* 忽略 */ }
	}, { global: true });
	ctx.on("agent/inbox/claimed", (payload) => { void onClaimed(payload); }, { global: true });
	ctx.on("agent/inbox/discarded", (payload) => { void onDiscarded(payload); }, { global: true });

	// boot 引导: 建 claim 索引 + 状态表版本标记 (只读+一次版本落盘; 不触发任何派发)
	void serialized(async () => {
		try {
			const st = await readState();
			for (const t of st.tasks ?? []) if (t.status === "dispatched" && t.messageId) dispatchedMsgIds.set(t.messageId, t.id);
			if (st.schemaVersion !== SCHEMA_VERSION) {
				st.schemaVersion = SCHEMA_VERSION;
				await writeState(st);
			}
			ctx.logger?.info?.(`dsh-taskqueue: 状态表 v${st.schemaVersion ?? 2} → v${SCHEMA_VERSION} 就绪; 待确认派发消息 ${dispatchedMsgIds.size} 个; 自动派发=${autoDisabled ? `停用(${autoDisabledReason})` : "启用"}`);
		} catch (err) {
			ctx.logger?.warn?.(`dsh-taskqueue: 启动引导失败(自动路径保守停用): ${String(err?.message ?? err)}`);
			disableAuto("启动引导异常");
		}
	});

	async function dispatchTask(state, task, agent, opts = {}) {
		const force = opts.force === true;
		// E 硬门闩: 自动路径只允许 pending; 历史/终态任务必须人工 force 显式重排 (防任何未来 bug 造成重放)
		if (task.status !== "pending" && !force) {
			ctx.logger?.warn?.(`dsh-taskqueue: 拒绝隐式重发任务 #${task.id} (status=${task.status}); 历史任务只能人工 /queue run-now ${task.id} --force`);
			return false;
		}
		if (autoDisabled && !force) {
			ctx.logger?.warn?.(`dsh-taskqueue: 自动派发停用中(${autoDisabledReason}), 跳过任务 #${task.id}`);
			return false;
		}
		// 去重键 (E4): (sessionId + taskId + roundId) 幂等; 本轮已有 claim 证据 → 直接终态, 不重复发送
		const roundId = force ? randomUUID() : (task.roundId ?? randomUUID());
		task.roundId = roundId;
		task.dedupeKey = `${task.sessionId ?? "-"}|${task.id}|${roundId}`;
		if (task.messageId && isMessageClaimed(task, agent)) {
			setTerminal(task, "done", { failCount: 0 });
			ctx.logger?.info?.(`dsh-taskqueue: 任务 #${task.id} 本轮(${roundId.slice(0, 8)})已有 claim 证据 → 判 done, 不重复发送`);
			return true;
		}
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
		task.messageId = message.id; // 记录消息 id (claim 匹配/去重键的核心)
		task.dispatchCount = (task.dispatchCount || 0) + 1;
		task.dispatchedBy = force ? "manual-force" : "auto";
		task.status = "dispatched";
		task.dispatchedAt = new Date().toISOString();
		// ⚠️ 不要在此重置 failCount: 它是"连续失败"熔断计数, 只有 claim/done 才清零;
		//    否则投递失败会被每轮重置, 熔断永远不触发 (2026-09-10 harness 实测踩到)。
		task.unconfirmedCount = 0;
		// ⚠️ 顺序关键 (2026-09-10 E2E 实测教训): 必须在 followup 之前完成
		//   ① 置 dispatched ② 登记 claim 索引 ③ 落盘 —— claim 事件可能紧随 followup
		//   触发; 若登记/落盘在后, 处理函数会因"索引未命中"或"状态文件里还是 pending"
		//   而漏掉本次 claim, 任务将永远停在 dispatched (无终态)。
		dispatchedMsgIds.set(task.messageId, task.id);
		await writeState(state);
		// ④ 最后才真正投递 (此处可能同步/紧随触发 claim 事件 → 上面三步保证能被匹配到)
		try {
			agent.followup(message);
		} catch (err) {
			// 投递失败 = 消息未送达: 回滚为 pending(清掉 messageId/索引, 避免留下"假 dispatched"),
			// 再由 tick 的熔断计数决定是否重试/停发 (最多 TASK_FAIL_BREAKER 次, 不是重试风暴)。
			dispatchedMsgIds.delete(task.messageId);
			delete task.messageId;
			delete task.dispatchedAt;
			task.status = "pending";
			await writeState(state);
			throw err;
		}
		// 自动标题 (v0.3.0): 若目标会话尚无标题, 按任务内容设置确定性标题 —
		// 让派发窗口在侧边栏立即可辨识 (source.kind="user" 固定标题, 不触发 LLM 生成)。
		try {
			const session = agent.session;
			// v0.8.4: 优先读会话日志 (0.1.2 用 snapshotEvents); 日志不可读时退回内存集合 (2026-09-10 的兜底)
			const titleInLog = hasSessionEvent(session, "session/title");
			const hasTitle = titleInLog === null ? titledSessions.has(String(session?.id ?? "")) : titleInLog;
			if (session && !hasTitle) {
				const title = `任务 #${task.id} · ${oneLine(task.content).slice(0, 20)}`;
				session.append("session/title", {
					title,
					messageSeqs: [],
					source: { kind: "user" }
				});
				titledSessions.add(String(session.id ?? ""));
			}
		} catch (err) {
			ctx.logger?.warn?.(`dsh-taskqueue: 设置任务 #${task.id} 会话标题失败: ${String(err?.message ?? err)}`);
		}
		// followup 期间 claim 处理函数可能已把本任务置终态并落盘 → 合并回来再写,
		// 否则会用陈旧的内存状态覆盖掉刚写入的 done (stale write)。
		try {
			const fresh = await readState();
			const ft = fresh?.tasks?.find((x) => x.id === task.id);
			if (ft && TERMINAL_STATUS.has(ft.status) && !TERMINAL_STATUS.has(task.status)) {
				task.status = ft.status;
				task.doneAt = ft.doneAt ?? task.doneAt;
				task.doneTurn = ft.doneTurn ?? task.doneTurn;
				task.failReason = ft.failReason ?? task.failReason;
			}
		} catch { /* 读回失败则按内存状态落盘 */ }
		const ok = await writeState(state);
		if (!ok) ctx.logger?.warn?.(`dsh-taskqueue: 任务 #${task.id} 已派发但状态落盘失败, 重启后可能重复派发`);
		ctx.logger?.info?.(`dsh-taskqueue: 已派发任务 #${task.id} 到 agent ${agent.id} (round=${roundId.slice(0, 8)}, by=${task.dispatchedBy})`);
		return true;
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
			const evs = readSessionEvents(agent?.session) ?? []; // v0.8.4: 0.1.2 适配
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
			const modeNow = await readMode(); // v0.8.3: 强制时段(debug) 与客户端拦截同口径
			const peakNow = effectivePeak(modeNow, windowsNow);
			const now = Date.now();
			// v0.6.0: 容器重启检测 —— PID1 starttime 变化 = 发生一次重启。
			// trigger=restart 的任务只在"检测到重启的这一次 tick"派发 (尝试一次;
			// 派发失败保持 pending, 下次重启再试 —— 满足"已重启未发送又重启,
			// 再次重启后发送"); 尝试后消费事件 (更新 lastBootId 落盘)。
			const bootId = readBootId();
			const restartDetected = bootId !== null && state.lastBootId !== bootId;
			if (bootId === null) ctx.logger?.warn?.("dsh-taskqueue: 无法读取容器启动标识 (/proc/1/stat), 跳过重启触发检测");
			// 1) 派发到期任务 (**仅 pending**); v0.4.3: 编辑锁中的任务 (及同会话后续任务) 跳过
			cleanupStaleLocks(state);
			let changed = false;
			const pendingAlerts = [];
			let tickHadError = false;
			// E 可观测性: 自动路径的熔断/恢复状态落盘 (dsh web 不转出插件 logger, 日志不可取证)
			if (autoDisabled && state.failSafe?.disabled !== true) {
				state.failSafe = { disabled: true, reason: autoDisabledReason, at: new Date().toISOString() };
				changed = true;
			} else if (!autoDisabled && state.failSafe?.disabled === true) {
				state.failSafe = { disabled: false, at: new Date().toISOString(), note: "能力探测通过, 自动路径恢复" };
				changed = true;
			}
			if (autoDisabled) {
				ctx.logger?.warn?.(`dsh-taskqueue: [fail-safe] 自动派发停用中 (${autoDisabledReason}); 本轮只观测不派发, 待人工 run-now`);
			}
			// v0.8.5: 「重启后发送」类任务也遵循错峰出行 —— 重启发生即把这类任务标记为
			// **已就绪(armed, 持久化)**, 但只有**当前是低谷**才真正派发 (用户在高峰期重启时,
			// 任务不再立刻按高峰价执行, 而是等低谷窗口)。armed 在"真正尝试派发"时消费掉,
			// 保持原有语义: 每次重启只尝试一次, 失败/异常保持 pending 等下次重启。
			if (restartDetected) {
				for (const t of state.tasks) {
					if (t.status === "pending" && t.trigger === "restart" && t.armed !== true) {
						t.armed = true;
						t.armedAt = new Date().toISOString();
						changed = true;
					}
				}
			}
			const due = autoDisabled ? [] : state.tasks.filter((t) => t.status === "pending"
				&& (t.trigger === "restart"
					? (t.armed === true && !peakNow) // v0.8.5: 重启已就绪 + 当前低谷 (原来是"一重启就发", 不看时段)
					: (t.scheduledAt ? now >= Date.parse(t.scheduledAt) : !peakNow))
				&& !isTaskLocked(state, t));
			for (const task of due) {
				try {
					const agent = await findTargetAgent(state, task);
					if (!agent) continue; // 该任务无可用会话, 下次再试 (armed 保留, 下轮低谷继续找)
					// v0.8.5: 真正尝试派发即消费"重启已就绪"标记 (每次重启只尝试一次)
					if (task.trigger === "restart" && task.armed === true) { delete task.armed; delete task.armedAt; changed = true; }
					const sent = await dispatchTask(state, task, agent);
					if (sent) changed = true;
				} catch (err) {
					// E 熔断: 派发异常 → 任务失败计数 + 全局连续异常计数(按异常次数累加); 达限即停发
					tickHadError = true;
					tickFailStreak += 1;
					task.failCount = (task.failCount || 0) + 1;
					task.lastFailReason = String(err?.message ?? err);
					ctx.logger?.warn?.(`dsh-taskqueue: 任务 #${task.id} 派发异常 (任务失败计数 ${task.failCount}/${TASK_FAIL_BREAKER}, 全局连续异常 ${tickFailStreak}/${TICK_FAIL_BREAKER}): ${task.lastFailReason}`);
					changed = true;
					if (tickFailStreak >= TICK_FAIL_BREAKER) disableAuto(`tick 连续 ${tickFailStreak} 次派发异常`);
					if (task.failCount >= TASK_FAIL_BREAKER) {
						if (setTerminal(task, "failed", { failReason: `连续 ${task.failCount} 次派发异常: ${task.lastFailReason}` })) pendingAlerts.push(task);
					}
				}
			}
			// 消费重启事件: 无论 restart 任务是否全部派发成功, 都更新 lastBootId,
			// 防止后续 tick 重复触发 (派发失败的任务保持 pending, 等下次重启再试)
			if (restartDetected) {
				state.lastBootId = bootId;
				await writeState(state);
				const armedN = state.tasks.filter((t) => t.status === "pending" && t.trigger === "restart" && t.armed === true).length;
				ctx.logger?.info?.(`dsh-taskqueue: 检测到容器重启 (bootId=${bootId}), restart 触发任务 本次派发 ${due.filter((t) => t.trigger === "restart").length} 个 / 已就绪待低谷 ${armedN} 个${peakNow ? " (当前高峰 → 遵循错峰, 等低谷执行)" : ""}`);
			}
			// 2) E: 已派发任务的**完成观测 (claim 驱动)** —— 本段只观测/置终态, **绝不重发**。
			//    历史 dispatched: 目标会话已含同 messageId 的 user/message → done;
			//    仍挂在 inbox → 在飞(不计数); 既不在 inbox 又无 claim 且超过 CLAIM_TIMEOUT_MS
			//    → 记一次"未确认", 连续 TASK_FAIL_BREAKER 次 → failed + 告警。
			//    ⚠️ 本段**不使用 agents.resume**: 只读在线 agent 视图, 避免重现 0.1.2
			//    resume 语义误判("已执行任务被判丢失") → 无限重发的原始事故链。
			for (const task of state.tasks) {
				// (D, 2026-09-10) 2026-09-09 的 kill switch `if (true) continue;` 已删除:
				// E 的 claim 驱动完成 + 熔断已接管, 且本块**不含任何重发调用**(只观测/置终态)。
				if (task.status !== "dispatched" || !task.dispatchedAt) continue;
				const sid = task.sessionId ?? state.targetSessionId;
				const agent = sid ? ctx.agents.get?.(sid) : null;
				if (!agent) continue; // 会话不在线: 无证据, 状态不动 (等人工或下次在线)
				if (isMessageClaimed(task, agent)) {
					if (setTerminal(task, "done", { failCount: 0, unconfirmedCount: 0 })) {
						changed = true;
						ctx.logger?.info?.(`dsh-taskqueue: 任务 #${task.id} 观测到 claim 证据 → done`);
					}
					continue;
				}
				if (isMessageInInbox(task, agent)) { task.unconfirmedCount = 0; continue; }
				if (now - Date.parse(task.dispatchedAt) < CLAIM_TIMEOUT_MS) continue;
				task.unconfirmedCount = (task.unconfirmedCount || 0) + 1;
				task.lastUnconfirmedAt = new Date().toISOString();
				changed = true;
				ctx.logger?.warn?.(`dsh-taskqueue: 任务 #${task.id} 派发后无 claim 且不在 inbox (未确认 ${task.unconfirmedCount}/${TASK_FAIL_BREAKER})`);
				if (task.unconfirmedCount >= TASK_FAIL_BREAKER) {
					if (setTerminal(task, "failed", { failReason: `派发后连续 ${task.unconfirmedCount} 轮无 claim 且不在 inbox (未执行/凭据失败等)` })) pendingAlerts.push(task);
				}
			}
			// E 熔断: 某轮零异常 → 全局连续异常计数清零 (累计在 catch 内按异常次数进行)
			if (!tickHadError) tickFailStreak = 0;
			for (const t of pendingAlerts) alertTask(t, `任务 #${t.id} 已熔断为 failed: ${t.failReason ?? "未知原因"} (不重发; 需重跑请人工 /queue run-now ${t.id} --force)`);
			if (changed) await writeState(state);
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
				let on = null;
				let content = rest;
				const atMatch = /^--at\s+("[^"]*"|'[^']*'|\S+)\s*(.*)$/.exec(rest);
				const onMatch = /^--on\s+("[^"]*"|'[^']*'|\S+)\s*(.*)$/.exec(rest);
				// v0.6.1: -r = --on restart 的单横线简写 (iOS 上 -- 难输入); 无需再打 restart
				const rMatch = /^-r\s+(.*)$/.exec(rest);
				if ((atMatch && onMatch) || ((atMatch || onMatch) && rMatch)) return { kind: "error", text: "--at / --on / -r 只能同时用一个" };
				if (atMatch) {
					at = parseAt(atMatch[1].replace(/^["']|["']$/g, ""));
					content = atMatch[2];
				} else if (onMatch) {
					on = onMatch[1].replace(/^["']|["']$/g, "");
					content = onMatch[2];
				} else if (rMatch) {
					on = "restart";
					content = rMatch[1];
				}
				if (!content || /^(?:--at|--on|-r)$/.test(rest.trim())) return { kind: "error", text: "用法: /queue add [--at \"HH:mm\" | --on restart | -r] <内容>" };
				if (rest.includes("--at") && !at) return { kind: "error", text: "--at 时间格式无效 (HH:mm 或 YYYY-MM-DD HH:mm, 且需为未来)" };
				if (on !== null && on !== "restart") return { kind: "error", text: "--on/-r 目前仅支持 restart (容器重启后派发)" };
				return await mutateState(async (state) => {
					const id = state.tasks.length ? Math.max(...state.tasks.map((t) => t.id)) + 1 : 1;
					// v0.3.1: 任务绑当前会话; blank 会话走极简确认 turn 转正
					const r = await enqueueTask({ state, id, content, at, when: on, agent: invocation?.agent });
					return { kind: "success", text: `任务 #${r.id} 已入队` };
				});
			}
			case "list": {
				const state = await readState();
				const pending = state.tasks.filter((t) => t.status === "pending");
				const queued = state.tasks.filter((t) => isQueuedSending(t)); // v0.5.0: 已派发未执行也算排队中
				const rest2 = state.tasks.filter((t) => t.status !== "pending" && !isQueuedSending(t));
				const queueN = pending.length + queued.length;
				const windowsNow = await resolveWindows();
				const modeNow = await readMode();
				const peak = effectivePeak(modeNow, windowsNow);
				// v0.4.3: 横幅文字精简 (历史移到面板底部), openPanel=true 出现即展开手风琴
				appendQueueBanner(invocation?.agent?.session, {
					openPanel: true,
					title: `任务队列 · 排队中 ${queueN} 个`,
					lines: [
						queueN === 0
							? "(队列为空)"
							: `排队中 ${queueN} 个 / 历史 ${rest2.length} 个`,
						`时段: ${peak ? "高峰" : "平峰"} · ${peakSourceText(modeNow, windowSource)}`,
						"任务列表见下方面板: 点行展开可 编辑/取消/立即派发 (已派发未执行的也可取消)"
					]
				});
				return { kind: "success", text: `任务队列: ${queueN} 排队中 / ${rest2.length} 历史 (详情见横幅面板)` };
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
					return { kind: "success", text: r.text };
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
				// E6: 历史/终态任务只允许人工强制重排 (--force); 自动路径永远不会重放历史
				const force = /(^|\s)--force(\s|$)/.test(rest);
				const id = parseInt(rest.replace(/--force/g, "").trim(), 10);
				if (!Number.isInteger(id)) return { kind: "error", text: "用法: /queue run-now <id> [--force]  (--force = 人工重新派发历史/终态任务)" };
				return await mutateState(async (state) => {
					const t = state.tasks.find((x) => x.id === id && (x.status === "pending" || force));
					if (!t) return { kind: "error", text: `未找到排队中的任务 #${id} (历史/终态任务需 --force)` };
					if (t.status !== "pending") requeueForManualForce(t);
					if (isTaskLocked(state, t)) return { kind: "error", text: `任务 #${id} 正在编辑中, 暂不能派发 (保存或取消编辑后再试)` };
					const agent = await findTargetAgent(state, t);
					if (!agent) return { kind: "error", text: "任务绑定会话已离线且无兜底会话, 稍后再试" };
					await dispatchTask(state, t, agent, { force: true });
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
			// v0.8.3 debug: 强制当前时段 (平峰期实测错峰功能; 客户端拦截与服务端派发同口径)
			case "debug": case "forcepeak": {
				const arg = rest.trim().toLowerCase();
				const cur = await readMode();
				if (!arg) {
					return { kind: "success", text: `当前强制时段: ${cur.debug}${cur.debug === "auto" ? " (按官方页判定)" : ""}\n用法: /queue debug peak | offpeak | auto` };
				}
				if (!DEBUG_VALUES.includes(arg)) {
					return { kind: "error", text: `用法: /queue debug peak | offpeak | auto (当前: ${cur.debug})` };
				}
				await writeMode({ enabled: cur.enabled, exempt: cur.exempt, debug: arg });
				await appendDiag({ event: "mode.debug", debug: arg, via: "slash" });
				const windowsNow = await resolveWindows();
				const peak = effectivePeak({ ...cur, debug: arg }, windowsNow);
				const label = arg === "peak" ? "强制高峰" : arg === "offpeak" ? "强制平峰" : "自动(官方页判定)";
				return { kind: "success", text: [
					`已设置: ${label} (debug=${arg})`,
					arg === "peak" ? "→ 客户端: 高峰时段消息自动入队; 服务端: 队列暂停派发" :
						arg === "offpeak" ? "→ 客户端: 消息正常直发; 服务端: 到期任务立即派发" :
							`→ 恢复官方页判定: 当前${peak ? "高峰" : "平峰"} (${windowSource})`,
					"恢复: /queue debug auto"
				].join("\n") };
			}
			case "help": case "":
				return { kind: "success", text: [
					"/queue add <内容>                   入队(绑当前会话), 等低谷自动执行",
					"/queue add --at \"HH:mm\" <内容>    指定时间执行 (HH:mm 或 YYYY-MM-DD HH:mm)",
					"/queue add --on restart <内容>     容器重启后、到低谷时段自动执行 (v0.8.5 遵循错峰; 每次重启尝试一次, 失败等下次重启)",
					"/queue add -r <内容>               同 --on restart (iOS 单横线简写)",
					"/queue list                         查看队列(含各任务绑定会话)",
					"/queue cancel <id>                  取消任务(排队中/已派发未执行的均可取消)",
					"/queue edit <id> <新内容>           修改任务内容",
					"/queue run-now <id>                 立即派发(不等低谷)",
					"/queue target [会话id]              查看/设置兜底派发目标会话",
					"/queue debug peak|offpeak|auto      强制当前时段 (调试: 平峰期实测错峰功能)",
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
		description: "把任务加入低谷时段任务队列(任务绑定当前会话执行): 默认等官方低谷价时段(动态解析官方页)自动派发到当前会话执行, 也可用 at 指定时间(北京时区 HH:mm 或 YYYY-MM-DD HH:mm), 或用 when=\"restart\" 指定容器重启后(且在低谷时段)自动派发",
		parameters: {
			content: { type: "string", required: true, description: "任务内容" },
			at: { type: "string", description: "可选指定时间: HH:mm 或 YYYY-MM-DD HH:mm (北京时区)" },
			when: { type: "string", description: "可选发送时机: restart=容器重启后自动派发 (v0.8.5 起同样遵循错峰: 重启发生在高峰时等到低谷再执行; 每次重启尝试一次, 失败等下次重启; 默认缺省=等低谷时段自动派发)" }
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
			if (args.when && args.when !== "restart") throw new Error("when 仅支持 restart (容器重启后派发)");
			return await mutateState(async (state) => {
				const id = state.tasks.length ? Math.max(...state.tasks.map((t) => t.id)) + 1 : 1;
				// v0.3.1: 任务绑当前会话; blank 会话走极简确认 turn 转正
				const r = await enqueueTask({ state, id, content: args.content, at, when: args.when, agent: exec?.agent });
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
			const modeNow = await readMode();
			const peak = effectivePeak(modeNow, windowsNow);
			const pending = state.tasks.filter((t) => t.status === "pending");
			const queued = state.tasks.filter((t) => isQueuedSending(t)); // v0.5.0
			const done = state.tasks.filter((t) => t.status !== "pending" && !isQueuedSending(t));
			const queueN = pending.length + queued.length;
			// v0.4.3: 横幅文字精简 (历史移到面板底部), openPanel=true 出现即展开手风琴
			appendQueueBanner(exec?.agent?.session, {
				openPanel: true,
				title: `任务队列 · 排队中 ${queueN} 个`,
				lines: [
					queueN === 0
						? "(队列为空)"
						: `排队中 ${queueN} 个 / 历史 ${done.length} 个`,
					`时段: ${peak ? "高峰" : "平峰"} · ${peakSourceText(modeNow, windowSource)}`,
					"任务列表见下方面板: 点行展开可 编辑/取消/立即派发 (已派发未执行的也可取消)"
				]
			});
			return { text: `任务队列: ${queueN} 排队中 / ${done.length} 历史 (时段: ${peak ? "高峰" : "平峰"} · ${peakSourceText(modeNow, windowSource)}, 详情见横幅面板)` };
		},
		presentCall: () => ({ card: "generic", title: "查看任务队列", kind: "other" })
	}));

	ctx.tools.register(defineTool({
		name: "queue_cancel",
		description: "取消任务(按 id; 排队中的, 或已派发但派发消息仍在目标会话排队未执行的均可取消, 已开始执行的无法取消)",
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
		description: "立即派发排队中的任务(不等低谷时段, 按 id; force=true 才可人工重排历史/终态任务)",
		parameters: {
			id: { type: "integer", required: true, description: "任务 id" },
			force: { type: "boolean", description: "人工强制重新派发历史/终态任务 (E6: 自动路径永不重放历史; 缺省 false)" }
		},
		output: {
			schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true } } },
			render: (_args, value) => [{ type: "text", text: value.text }]
		},
		execute: async (args, exec) => {
			const force = args.force === true;
			return await mutateState(async (state) => {
				const t = state.tasks.find((x) => x.id === args.id && (x.status === "pending" || force));
				if (!t) throw new Error(`未找到排队中的任务 #${args.id} (历史/终态任务需 force=true)`);
				if (t.status !== "pending") requeueForManualForce(t);
				if (isTaskLocked(state, t)) throw new Error(`任务 #${args.id} 正在编辑中, 暂不能派发 (保存或取消编辑后再试)`);
				const agent = await findTargetAgent(state, t);
				if (!agent) return { text: `任务 #${t.id} 绑定会话已离线且无兜底会话, 保持排队` };
				await dispatchTask(state, t, agent, { force: true });
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
				const modeNow = await readMode();
				const peak = effectivePeak(modeNow, windowsNow);
				cleanupStaleLocks(state);
				const tasks = state.tasks.map((t) => ({
					id: t.id,
					content: t.content,
					status: t.status,
					statusText: STATUS_TEXT[t.status] ?? t.status,
					queuedSending: isQueuedSending(t), // v0.5.0: 已派发且消息仍在收件箱排队 (可撤回)
					createdAt: t.createdAt,
					scheduledAt: t.scheduledAt ?? null,
					trigger: t.trigger ?? null, // v0.6.0: "restart" = 容器重启后派发
					sessionShort: shortSession(t.sessionId),
					whenText: t.trigger === "restart"
						? (t.armed === true ? "重启后 · 等低谷" : "等待容器重启")
						: (t.scheduledAt
							? `定于 ${beijingNowString(new Date(t.scheduledAt)).slice(5, 16)}`
							: (peak ? "等低谷" : "低谷中")),
					locked: isTaskLocked(state, t) // v0.4.3: 编辑锁标记 (客户端显示"编辑中")
				}));
				return { ok: true, value: {
					tasks,
					pendingCount: tasks.filter((t) => t.status === "pending").length,
					targetSessionId: state.targetSessionId,
					targetSessionShort: shortSession(state.targetSessionId),
					peak,
					windowSource,
					peakSource: peakSourceText(modeNow, windowSource),
					debug: modeNow.debug
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
				// E6: payload.force=true 才允许人工重排历史/终态任务 (面板按钮不带 force, 行为不变)
				const id = payload?.id;
				const force = payload?.force === true;
				if (!Number.isInteger(id)) return { ok: false, error: { code: "bad-request", message: "需要 id(整数)" } };
				return await mutateState(async (state) => {
					const t = state.tasks.find((x) => x.id === id && (x.status === "pending" || force));
					if (!t) return { ok: false, error: { code: "not-found", message: `未找到排队中的任务 #${id}` } };
					if (t.status !== "pending") requeueForManualForce(t);
					if (isTaskLocked(state, t)) {
						return { ok: false, error: { code: "locked", message: `任务 #${id} 正在编辑中, 暂不能派发 (保存或取消编辑后再试)` } };
					}
					const agent = await findTargetAgent(state, t);
					if (!agent) return { ok: false, error: { code: "unavailable", message: "任务绑定会话已离线且无兜底会话, 稍后再试" } };
					await dispatchTask(state, t, agent, { force: true });
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
			// ── v0.7.0 错峰出行模式 ────────────────────────────────────────────
			// mode.get    → { enabled, peak, windowSource, peakSource, debug, exempt } 开关 + 实时时段 + 豁免 map
			// mode.set    { enabled }                               持久化开关 (写 MODE_FILE, 保留 exempt/debug)
			// mode.exempt { sessionId, exempt } (v0.8.0)            单会话豁免切换 (高峰照常发送)
			// mode.debug  { debug: auto|peak|offpeak } (v0.8.3)     强制当前时段 (调试; 客户端拦截与服务端派发同口径)
			// diag        { event, ...} (v0.8.3)                    客户端诊断上报 (落 log/taskqueue/offpeak-debug.log)
			// diag.get    → { recent, file }                        回读最近诊断 (无控制台远程取证)
			// add         { content, sessionId }                    客户端拦截后入队 (绑指定会话,
			//                                                        与 queue_add 工具同路径, 零 token)
			case "mode.get": {
				const mode = await readMode();
				const windowsNow = await resolveWindows();
				return { ok: true, value: { ...modeValue(mode, windowsNow, windowSource), diag: diagRecent.slice(-8) } };
			}
			case "mode.set": {
				const enabled = payload?.enabled === true;
				const cur = await readMode();
				await writeMode({ enabled, exempt: cur.exempt, debug: cur.debug });
				const windowsNow = await resolveWindows();
				return { ok: true, value: modeValue({ enabled, exempt: cur.exempt, debug: cur.debug }, windowsNow, windowSource) };
			}
			case "mode.exempt": {
				const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
				const exempt = payload?.exempt === true;
				if (!sessionId) {
					return { ok: false, error: { code: "bad-request", message: "需要 sessionId(当前会话)" } };
				}
				const cur = await readMode();
				const exemptMap = { ...cur.exempt };
				if (exempt) exemptMap[sessionId] = true;
				else delete exemptMap[sessionId];
				await writeMode({ enabled: cur.enabled, exempt: exemptMap, debug: cur.debug });
				const windowsNow = await resolveWindows();
				return { ok: true, value: modeValue({ enabled: cur.enabled, exempt: exemptMap, debug: cur.debug }, windowsNow, windowSource) };
			}
			// v0.8.3 强制时段 (debug): 平峰期实测错峰功能用 —— "peak" = 当作高峰(消息入队/队列不派发),
			// "offpeak" = 当作平峰(消息直发/到期任务立即派发), "auto" = 恢复官方页判定。
			case "mode.debug": {
				const debug = normalizeDebug(payload?.debug);
				const raw = typeof payload?.debug === "string" ? payload.debug : "";
				if (raw && debug === "auto" && raw !== "auto") {
					return { ok: false, error: { code: "bad-request", message: `debug 只接受 ${DEBUG_VALUES.join(" / ")}` } };
				}
				const cur = await readMode();
				await writeMode({ enabled: cur.enabled, exempt: cur.exempt, debug });
				const windowsNow = await resolveWindows();
				await appendDiag({ event: "mode.debug", debug });
				return { ok: true, value: modeValue({ enabled: cur.enabled, exempt: cur.exempt, debug }, windowsNow, windowSource) };
			}
			// v0.8.3 客户端诊断: 错峰拦截器在浏览器里, 静默失效时无从取证 —— 客户端 apply/渲染/命中都上报。
			case "diag": {
				const event = typeof payload?.event === "string" ? payload.event.slice(0, 64) : "unknown";
				const rest = (payload && typeof payload === "object") ? { ...payload } : {};
				delete rest.event;
				await appendDiag({ event, ...rest });
				return { ok: true, value: { file: DIAG_LOG } };
			}
			case "diag.get": {
				return { ok: true, value: { recent: diagRecent.slice(-20), file: DIAG_LOG } };
			}
			case "add": {
				const content = typeof payload?.content === "string" ? payload.content.trim() : "";
				const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : null;
				if (!content) {
					return { ok: false, error: { code: "bad-request", message: "需要 content(非空字符串)" } };
				}
				if (!sessionId) {
					return { ok: false, error: { code: "bad-request", message: "需要 sessionId(当前会话)" } };
				}
				return await mutateState(async (state) => {
					const id = state.tasks.length ? Math.max(...state.tasks.map((t) => t.id)) + 1 : 1;
					// 绑客户端传来的会话: 先查 live agent (有则走完整入队含转正/横幅), 无则仅绑会话 id
					const agent = ctx.agents?.get?.(sessionId) ?? null;
					const r = await enqueueTask({ state, id, content, at: null, when: null, agent, sessionId });
					// v0.8.4: 回传 engaged (blank 会话已发转正确认 turn) —— 客户端诊断用, 也可远程确证防串台机制生效
					return { ok: true, value: { id: r.id, when: r.when, engaged: r.engaged === true } };
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
