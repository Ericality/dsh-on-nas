import z from "@deepseek-ai/schemastery";
import { KNOWN_SESSION_EVENT_TYPES } from "@deepseek-ai/dsh-session";
import { attachReconcile, lastTurnEnd, turnElapsedMs } from "@deepseek-ai/dsh-reconcile";
import { appendFileSync, mkdirSync } from "node:fs";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";

/**
 * @deepseek-ai/dsh-notify (本地辅助插件, 非官方包)
 *
 * 任务完成推送通知, 两个通道可同时用:
 *   - Bark (支持多设备 Key): POST https://api.day.app/push
 *   - Synology Chat 机器人: POST 到外部收件 webhook (SYNO.Chat.External incoming)
 *
 * 触发: 每个 agent 回合 (turn/end) 结束时, 若回合耗时 >= minTurnMs (默认 60s,
 * 避免聊天短回复刷屏) 才推送。配置见 profile patch 的 notify 行;
 * 也支持环境变量 DSH_BARK_KEYS(逗号分隔) / DSH_SYNOLOGY_WEBHOOK_URL。
 *
 * 内容演进:
 * v0.2.0: 通知里带会话标题、本轮用户问题摘要、agent 答复摘要。
 * v0.3.0 (2026-08-24, 用户要求): 本地横幅不再与外部通知重复 —
 *   仅当 agent 回复含"新的总结信息"时, 才注入本地横幅 (【总结】展示)。
 * v0.4.0 (2026-08-26): 被中断回合 (容器重启) 在会话恢复时补推"回合被中断"通知 (幂等对账)。
 * v0.5.0 (2026-08-29, 用户要求): 群晖推送**完整问答内容** —
 *   - 去掉 60/100 字符截断, 问题/回复全文推送;
 *   - 代码层去除 Markdown 格式 (stripMarkdown), 推送纯文本, 不依赖 agent 另答;
 *   - Synology Chat 单条消息硬上限 2000 字符 → 按页分块 (composeSynologyPages),
 *     每条都带【问题】+ 页码 [x/N] + 会话短 id, 多个会话同时结束推送也不会混淆。
 * v0.5.1 (2026-08-29, 用户要求): **纯文本增强排版** — 群晖 Chat 不渲染 markdown,
 *   改用 emoji 标签 (📌标题 / ❓问题 / 🤖回复) + 全角分隔线 (━━━) 突出字段;
 *   修复分页**并发发送触发 entry.cgi 限流 (411) 丢页** → 改为逐页串行 + 1.5s 间隔;
 *   分页**优先在段落/换行边界切断** (cutAtBoundary), 避免长段落被拦腰截断。
 * v0.5.2 (2026-08-29, 用户要求): **提问回合通知** — agent 回复以提问结尾 (在等用户回应) 时,
 *   不受 minTurnMs 限制**无条件推送** (标题"DSH 需要你回应"), 不注入总结横幅, 也不重复推"任务完成"。
 * v0.5.3 (2026-08-29, 用户要求): **格式再设计 + 全局串行发送** —
 *   - 块首尾都用 34 个等号线 (=) 包裹; 块内去掉 [x/y] 页码, 多页无缝拼接
 *     (群晖 Chat 拼接短时间推送, 用等号线区分块即可);
 *   - emoji 换跨平台通用: ✅完成 / ❌中断 / ⁉️提问 放标题前, 👀 问题, 💡 回复, ➡️ 选项
 *     (回复中 markdown 列表行自动转 ➡️);
 *   - 问题↔回复之间保留 30 个 ─ 横向分隔线;
 *   - 续页 (截断部分) 直接发内容不加装饰, 页脚 (回合/用时/原因/会话) 放最后页结束等号前;
 *   - **通知发送全局 FIFO 串行**: 一个通知的所有页发完 (含 1.5s 限流间隔) 才发下一个,
 *     杜绝多会话/多回合通知交错导致的分页乱序 (用户 2026-08-29 确认)。
 * v0.5.4 (2026-08-29, 用户要求): **提问通知改为真实 asking 状态触发** —
 *   仅当 agent 调用 **ask_user_question 工具** (tool/call 事件, 前端渲染选择组件等用户回答)
 *   才推送「⁉️ DSH 需要你回应」; 问题/选项从工具参数解析, 选项转 ➡️ 行;
 *   不再用文本问句启发式 (isQuestionText) 判定 (普通问句结尾会误触发,
 *   用户 2026-08-29 实测困惑后确认); isQuestionText 函数保留但不再参与推送。
 *
 * v0.6.0 (2026-09-12, 用户要求 · 通知中枢 Stage 1): **多设备 + 类型路由 + group/level 规范 +
 *   设置卡** — 配置文件 /data/dsh/notify-hub.json (0600, dsh-notify 写 / auth-proxy 读),
 *   设备列表 (Bark 多台 + 群晖 Chat) + routeDefault + routes[type]; 类型枚举与 Bark
 *   group/level/isArchive 见下方 NOTIFY_TYPES (§2.2 冻结表);
 *   现有三处推送 (完成/提问/中断) 全部走 type=task.done, 分页逻辑不变;
 *   标题里冗余的 "DSH" 字样移除 (改由 Bark 的 "[DSH] " 前缀统一承载, 用户 2026-09-12 确认);
 *   新增已认证 RPC 通道 /notify-hub (get/saveDevice/deleteDevice/setRoutes/test) 与
 *   服务名 notifyHub (ctx.provide), 供设置卡与其它插件使用。
 *
 * v0.7.0 (2026-09-12, 用户裁定 · 通知设置整改): **独立 type + options + 显式关闭** —
 *   契约 docs/任务记录/2026-09-12-通知设置整改-契约v0.7.0.md (逐字实现):
 *   - 三处推送拆成独立 type: turn/end → task.done, ask_user_question → task.asking,
 *     重启补推 → task.interrupted (group 统一 DSH-任务 / level active); NOTIFY_TYPES 12 项
 *     全部带 hasProducer (false = 预留类型, 暂无生产者);
 *   - `routes[type] = []` **落盘保留** = 该 type 显式关闭 (零请求, 不回落默认) —— 本次唯一
 *     破坏性变更 (旧版把空数组当"未配置");
 *   - 新增 `options` { minTurnMs, bannerSummary, reconcile } + RPC `setOptions`;
 *     `get` 增补 options / effective / types[].hasProducer;
 *     minTurnMs 初值取 patch config.minTurnMs, 但运行期一律以 options 为准 (改完即时生效)。
 *
 * 附带命令 /notify-test 用于验证各通道。
 * 通知发送是 fire-and-forget, 失败只记日志, 不影响任务。
 */
export const name = "dsh-notify";
export const inject = ["commands", "connection"];

export const Config = z.object({
	barkKeys: z.array(z.string()).default([]),
	synologyWebhookUrl: z.string().default(""),
	minTurnMs: z.number().default(60000)
});

// ============================================================================
// 通知中枢 (Stage 1, 2026-09-12): 多设备 + 类型路由 + group/level 规范
// 契约 (冻结, 不得擅自改): docs/任务记录/2026-09-12-通知中枢Stage1-接口细化.md
//   + docs/任务记录/2026-09-11-通知中枢与访问安全-实施任务书.md §2
// 配置文件 /data/dsh/notify-hub.json (0600; dsh-notify 写 / auth-proxy 读 ⇒ 跨进程契约)。
// ============================================================================
const SEND_TIMEOUT_MS = 10000;
/** Synology Chat incoming webhook 单条消息硬上限: 超过被拒收 (entry.cgi success:false) */
export const SYNOLOGY_PAGE_LIMIT = 2000;
/** 配置文件路径 (§2.1)。可用 env 覆盖 (仅供测试隔离, 生产走默认值)。 */
const HUB_FILE = process.env.DSH_NOTIFY_HUB_FILE || "/data/dsh/notify-hub.json";
const HUB_VERSION = 2; // v0.7.0: 读侧兼容 version 1 (旧文件无 options ⇒ 用默认值, 不写盘)
/** RPC 通道名 (§3.3)。 */
export const CHANNEL = "/notify-hub";

/** 设备 id 语法 (§2.1)。 */
export const DEVICE_ID_RE = /^[a-z0-9_-]{1,32}$/;
/** 设备类型枚举 (§2.1)。 */
export const DEVICE_KINDS = ["bark", "synology"];
/** 标题前缀 (§2.2, 仅作用于 Bark)。 */
export const TITLE_PREFIX = "[DSH] ";

/**
 * 通知类型枚举 + group/level 规范 (§2.2 冻结表, 逐字一致, 不得擅自改)。
 * isArchive 统一 1 (见 sendBarkDevice)。
 * v0.7.0: 新增 task.asking / task.interrupted (三者独立路由), 全部 12 项带 `hasProducer`
 * (false = 预留类型, 当前无任何生产者 ⇒ 客户端置灰不可交互, 服务端仍可发送)。
 * v0.8.1 (2026-09-13, 通知中枢 Stage 4): 新增通知类型 `auth.otp`（登录一次性码发到手机）
 * ⇒ NOTIFY_TYPES 共 **13 项**。该 type 由 auth-proxy 产生（`POST /login?step=code&action=send-otp`
 * 同步下发）；Bark payload 新增 `icon` 字段**仅对 auth.otp 生效**（默认 DSH 图标, 见 auth-proxy 侧
 * `DSH_NOTIFY_ICON_URL`），其余 5 类 auth.* payload 逐字不变。路由由用户在设置卡里配。
 */
export const NOTIFY_TYPES = [
	{ type: "auth.login_failed", label: "登录失败（密码/验证码错误）", group: "DSH-安全", level: "timeSensitive", hasProducer: true },
	{ type: "auth.locked", label: "触发锁定（含全站闸）", group: "DSH-安全", level: "timeSensitive", hasProducer: true },
	{ type: "auth.unlocked", label: "锁定期满 / 手动解除", group: "DSH-安全", level: "active", hasProducer: true },
	{ type: "auth.new_device", label: "新设备通过 TOTP 验证", group: "DSH-安全", level: "timeSensitive", hasProducer: true },
	{ type: "auth.mfa_changed", label: "MFA 启用 / 停用 / 重生成", group: "DSH-安全", level: "timeSensitive", hasProducer: true },
	{ type: "auth.otp", label: "登录一次性码（发到手机）", group: "DSH-安全", level: "timeSensitive", hasProducer: true },
	{ type: "task.done", label: "对话完成（回合结束汇总）", group: "DSH-任务", level: "active", hasProducer: true },
	{ type: "task.asking", label: "需要你回应（agent 提问）", group: "DSH-任务", level: "active", hasProducer: true },
	{ type: "task.interrupted", label: "回合被中断（重启后补推）", group: "DSH-任务", level: "active", hasProducer: true },
	{ type: "cost.alert", label: "费用提醒", group: "DSH-费用", level: "active", hasProducer: false },
	{ type: "queue.dispatched", label: "队列派发", group: "DSH-队列", level: "passive", hasProducer: false },
	{ type: "queue.cancelled", label: "队列取消", group: "DSH-队列", level: "passive", hasProducer: false },
	{ type: "test", label: "测试推送（设置卡逐台）", group: "DSH-测试", level: "active", hasProducer: true }
];
const TYPE_MAP = new Map(NOTIFY_TYPES.map((t) => [t.type, t]));
/** 未在 §2.2 表中列出的 type 的兜底规范 (仍可发送, 不阻断)。 */
export const FALLBACK_TYPE_SPEC = { group: "DSH-任务", level: "active" };

/** 取某 type 的 group/level 规范; 未知 type 走兜底。 */
export function typeSpec(type) {
	return TYPE_MAP.get(String(type)) ?? { type: String(type), label: String(type), ...FALLBACK_TYPE_SPEC };
}

// ---- options (§3, v0.7.0 新增) ---------------------------------------------

/** options 键白名单 (§4 setOptions「仅接受上表三键」)。 */
export const OPTION_KEYS = ["minTurnMs", "bannerSummary", "reconcile"];
/** minTurnMs 取值范围 (§3): 0…3600000 ms (0 = 不设门槛)。 */
export const MIN_TURN_MS_MAX = 3600000;
/**
 * options 默认值 (§3): `minTurnMs` 初值 = patch `config.minTurnMs ?? 60000`
 * (由 apply/configureHub 注入, 保证升级前后行为一致); `bannerSummary`/`reconcile` 恒 true。
 */
let optionsDefaults = { minTurnMs: 60000, bannerSummary: true, reconcile: true };
/** 当前默认值副本 (供测试/诊断)。 */
export function optionDefaults() {
	return { ...optionsDefaults };
}
/** 用 patch 配置的 minTurnMs 覆盖 options.minTurnMs 初值 (§3)。 */
export function setOptionsDefaults(patchMinTurnMs) {
	if (Number.isFinite(patchMinTurnMs)) {
		optionsDefaults = { ...optionsDefaults, minTurnMs: clampMinTurnMs(patchMinTurnMs, optionsDefaults.minTurnMs) };
	}
	return optionDefaults();
}
/** 夹到 [0, 3600000] 整数 (§3); 非 number/NaN ⇒ 用 fallback。 */
function clampMinTurnMs(v, fallback) {
	if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
	return Math.min(MIN_TURN_MS_MAX, Math.max(0, Math.round(v)));
}
/**
 * 规整 options (§3): 缺失键 ⇒ 用默认值; `minTurnMs` 非整数/越界 ⇒ 夹到 [0, 3600000];
 * 非布尔 ⇒ 用默认值; 未知键一律丢弃。**不抛错** (setOptions 也走这里)。
 */
export function normalizeOptions(raw, defaults = optionsDefaults) {
	const base = defaults ?? optionsDefaults;
	const out = {
		minTurnMs: clampMinTurnMs(base?.minTurnMs, optionsDefaults.minTurnMs),
		bannerSummary: typeof base?.bannerSummary === "boolean" ? base.bannerSummary : true,
		reconcile: typeof base?.reconcile === "boolean" ? base.reconcile : true
	};
	if (raw && typeof raw === "object") {
		if (raw.minTurnMs !== undefined) out.minTurnMs = clampMinTurnMs(raw.minTurnMs, out.minTurnMs);
		if (typeof raw.bannerSummary === "boolean") out.bannerSummary = raw.bannerSummary;
		if (typeof raw.reconcile === "boolean") out.reconcile = raw.reconcile;
	}
	return out;
}

/** 运行时 options 快照 (v0.7.0): 由 loadHub() 按 mtime 刷新 ⇒ 设置卡改完即刻生效, 无需重启。 */
let hubOptions = { ...optionsDefaults };
/** 当前生效 options (同步读快照; 供 apply 的事件路径与诊断用)。 */
export function currentOptions() {
	return { ...hubOptions };
}

/** 分页串行发送间隔: 避开 Synology entry.cgi 限流 (code 411, 实测 1.5s 安全; v0.5.1 结论保留)。 */
const SEND_PAGE_INTERVAL_MS = 1500;

/** 进程内日志器 (apply 时注入)。 */
let logger = null;
/** 迁移源 (apply 时由 patch config + env 填充, 见 §2.1 迁移)。 */
let hubMigrationSource = {};
/** 运行时 hub 缓存 (设置卡改配置即刻生效) + 其 mtime (外部改文件时自动失效)。 */
let hubCache = null;
let hubCacheMtime = 0;
/** 是否存在可用通道 (enabled 设备数 > 0); 供同步事件路径做快速短路。 */
let hubHasChannel = false;
/** 全局 FIFO 串行发送队列 (v0.5.3 语义保留: 一个通知所有页/设备发完才发下一个)。 */
let sendQueue = Promise.resolve();

const asArray = (v) => (Array.isArray(v) ? v : []);

/** 脱敏: 日志/响应里绝不出现明文 URL / key / token (§3.2)。 */
export function sanitize(text) {
	return String(text ?? "")
		.replace(/https?:\/\/[^\s"'<>]+/g, (u) => urlTail(u))
		.replace(/((?:device_key|token|key|apikey|api_key)=)[^&\s"']+/gi, "$1…");
}

/** 只回 URL 尾号 (§3.2/§7); 响应与日志永不回明文。 */
export function urlTail(url) {
	const s = String(url ?? "").replace(/\/+$/, "");
	return `…${s.slice(-4)}`;
}

/** 标题前缀统一 "[DSH] " (§2.2), 幂等 (已带前缀不重复加)。 */
export function barkTitle(title) {
	const t = String(title ?? "").trim();
	return t.startsWith(TITLE_PREFIX.trim()) ? t : `${TITLE_PREFIX}${t}`;
}

/**
 * 由设备 URL 推导 Bark 端点 + device_key (§4)。
 * 兼容自建/路径前缀: `https://api.day.app/AbC` → `POST https://api.day.app/push` + key AbC;
 * `https://mydomain/bark/AbC` → `POST https://mydomain/bark/push` + key AbC。
 * URL 自带的 query 参数原样带回 (own), 由调用方以"自带优先"的顺序合并。
 */
export function resolveBark(deviceUrl) {
	const u = new URL(String(deviceUrl));
	const own = {};
	for (const [k, v] of u.searchParams) own[k] = v;
	const segments = u.pathname.split("/").filter(Boolean);
	let key = own.device_key ?? "";
	// 末段不是 push 且 query 未给 device_key ⇒ 末段即设备 key (标准 Bark URL 形态)
	if (!key && segments.length && segments[segments.length - 1] !== "push") key = segments.pop();
	const path = `/${segments.join("/")}`;
	const isPushPath = segments[segments.length - 1] === "push";
	const endpoint = u.origin + (isPushPath ? path : `${path === "/" ? "" : path}/push`);
	return { endpoint, key, own };
}

/**
 * 规整一份原始配置为合法 hub (不写盘): **只做形状校验, 不解析路由语义**。
 * - 非法/重复设备静默丢弃;
 * - `routes` 的 key 必须是 §2.2 表内 type (未知 type 丢弃);
 * - **v0.7.0: 显式空数组的 route 键必须原样保留** ⇒ 语义 = 该 type 显式关闭 (零请求, 不回落默认);
 *   仅**非数组**的脏值 (手工编辑出错) 才丢弃该键 ⇒ 回落默认路由 (避免脏数据把通知静默静音);
 * - **非空数组原样保留路由里的 id, 不在读盘期按设备表过滤** ——
 *   否则 `routes[type] = ["已删设备"]` 会被压成 `[]` 再被当"显式关闭"⇒ 语义漂移;
 *   现在的语义是: 该 type **有**显式路由, 但解析后无可用设备 ⇒ **零请求** (§2.1 "结果为空 ⇒ 不发送")。
 *   语义判定统一放在 resolveRouteIds()。
 * - v0.7.0: `options` 缺失 (旧文件/version 1) ⇒ 内存里用默认值, **不写盘** (首次保存才落盘)。
 */
export function normalizeHub(raw) {
	const devices = [];
	const seen = new Set();
	for (const d of asArray(raw?.devices)) {
		if (!d || typeof d !== "object") continue;
		const id = String(d.id ?? "");
		if (!DEVICE_ID_RE.test(id) || seen.has(id)) continue;
		const kind = DEVICE_KINDS.includes(d.kind) ? d.kind : "";
		const url = typeof d.url === "string" ? d.url.trim() : "";
		if (!kind || !url) continue;
		seen.add(id);
		devices.push({ id, name: String(d.name ?? id).slice(0, 64) || id, kind, url, enabled: d.enabled !== false });
	}
	const normList = (v) => [...new Set(asArray(v).map((x) => String(x)).filter(Boolean))];
	const routes = {};
	if (raw?.routes && typeof raw.routes === "object") {
		for (const [k, v] of Object.entries(raw.routes)) {
			if (!TYPE_MAP.has(k)) continue;
			if (!Array.isArray(v)) continue; // 脏值丢弃 ⇒ 回落默认 (见上方注释)
			routes[k] = normList(v); // v0.7.0: 空数组原样保留 = 显式关闭 (§1 语义变更)
		}
	}
	return { version: HUB_VERSION, devices, routeDefault: normList(raw?.routeDefault), routes, options: normalizeOptions(raw?.options) };
}

/** 首次读取无该文件时的迁移 (§2.1): 现有 patch 配置 barkKeys + synologyWebhookUrl。 */
export function migrateHub(source = {}) {
	const devices = [];
	const barkKeys = [...new Set([...asArray(source.barkKeys), ...asArray(source.envBarkKeys)]
		.map((s) => String(s).trim()).filter(Boolean))];
	barkKeys.forEach((key, i) => {
		devices.push({ id: `bark${i + 1}`, name: `Bark ${i + 1}`, kind: "bark", url: `https://api.day.app/${key}`, enabled: true });
	});
	const chat = String(source.synologyWebhookUrl || source.envSynologyUrl || "").trim();
	if (chat) devices.push({ id: "chat", name: "群晖 Chat", kind: "synology", url: chat, enabled: true });
	// routeDefault 空数组 ⇒ 语义 = 发全部 enabled 设备 = 与迁移前行为一致 (§2.1)
	return { version: HUB_VERSION, devices, routeDefault: [], routes: {}, options: optionDefaults() };
}

/**
 * 类型路由 (§2.1): routes[type] 存在 ⇒ 只用它 (可为空 ⇒ 不发);
 * 否则 routeDefault 非空 ⇒ 用它; 否则全部 enabled 设备。
 * 停用设备与未知 id 一律静默忽略。
 */
export function resolveRouteIds(hub, type) {
	const enabled = asArray(hub?.devices).filter((d) => d.enabled !== false);
	const enabledIds = new Set(enabled.map((d) => d.id));
	const pick = (list) => [...new Set(asArray(list).map((x) => String(x)))].filter((id) => enabledIds.has(id));
	if (Object.prototype.hasOwnProperty.call(hub?.routes ?? {}, String(type))) return pick(hub.routes[String(type)]);
	if (asArray(hub?.routeDefault).length) return pick(hub.routeDefault);
	return enabled.map((d) => d.id);
}

/** 广播用: 全部 enabled 设备 (banner/诊断命令)。 */
export function allEnabledIds(hub) {
	return asArray(hub?.devices).filter((d) => d.enabled !== false).map((d) => d.id);
}

function refreshHubFlags(hub) {
	hubHasChannel = asArray(hub?.devices).some((d) => d.enabled !== false);
	// v0.7.0: 同步 options 快照 ⇒ 事件路径 (turn/end, reconcile) 可同步取到最新阈值/开关
	hubOptions = normalizeOptions(hub?.options);
	return hub;
}

/** 读配置文件: 无文件 → null (走迁移); **损坏 → 记 warn 后也返回 null** (降级为迁移配置,
 *  通知功能绝不因配置损坏而中断 —— 契约 §1)。两种情况用 `corrupt` 标记区分, 便于日志定位。 */
async function readHubFile() {
	let text;
	try { text = await readFile(HUB_FILE, "utf8"); } catch { return null; } // 文件不存在
	try { return JSON.parse(text); }
	catch (e) {
		logger?.warn?.(`dsh-notify: ${HUB_FILE} 解析失败 (已降级为迁移配置, 原文件未改动): ${sanitize(e?.message ?? e)}`);
		debug(`notify-hub: 解析失败, 降级为迁移配置: ${sanitize(e?.message ?? e)}`);
		return null;
	}
}

async function writeHubFile(hub) {
	await writeFile(HUB_FILE, `${JSON.stringify(hub, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	// 已存在的文件 mode 不会因 writeFile 改变 ⇒ 显式收紧到 0600 (§3 验收)
	try { await chmod(HUB_FILE, 0o600); } catch { /* 文件系统不支持时忽略 */ }
}

/** 确保配置文件权限为 0600 (§3 验收: 明文 key 只落在 0600 文件里)。 */
async function enforceOwnerOnly() {
	try { if (((await stat(HUB_FILE)).mode & 0o777) !== 0o600) await chmod(HUB_FILE, 0o600); }
	catch { /* 文件系统不支持 chmod 时忽略 (/workspace 挂载即如此) */ }
}

/** 读 hub (带缓存); 无文件 ⇒ 迁移 + 落盘 0600; JSON 损坏 ⇒ 降级为迁移结果, 绝不抛错断通知。
 *  缓存按 **mtime** 失效: 外部直接改文件 (手工编辑/测试脚本/未来的 auth-proxy 写侧) 也能即时生效,
 *  不必等重启或显式 force。 */
export async function loadHub({ force = false } = {}) {
	if (hubCache && !force) {
		try { if ((await stat(HUB_FILE)).mtimeMs === hubCacheMtime) return hubCache; }
		catch { return hubCache; } // stat 失败(文件被删) 交给下面走迁移
	}
	const raw = await readHubFile();
	if (raw) {
		hubCache = normalizeHub(raw);
		try { hubCacheMtime = (await stat(HUB_FILE)).mtimeMs; } catch { hubCacheMtime = 0; }
		// 手工创建/备份还原可能带来宽松权限 ⇒ 读到就收紧
		await enforceOwnerOnly();
		return refreshHubFlags(hubCache);
	}
	const migrated = migrateHub(hubMigrationSource);
	hubCache = migrated;
	try {
		await writeHubFile(migrated);
		debug(`notify-hub: 首次迁移生成 ${HUB_FILE} (devices=${migrated.devices.length}, routeDefault=[])`);
	} catch (e) {
		logger?.warn?.(`dsh-notify: notify-hub.json 写盘失败 (继续用内存配置): ${sanitize(e?.message ?? e)}`);
		debug(`notify-hub: 迁移写盘失败: ${sanitize(e?.message ?? e)}`);
	}
	return refreshHubFlags(hubCache);
}

/** 写 hub (0600) + 刷新缓存。 */
export async function saveHub(hub) {
	const next = normalizeHub(hub);
	await writeHubFile(next);
	hubCache = next;
	try { hubCacheMtime = (await stat(HUB_FILE)).mtimeMs; } catch { hubCacheMtime = 0; }
	return refreshHubFlags(next);
}

/** 单台 Bark 发送 (§4): POST + device_key; URL 自带 query 参数优先于我们附加的。 */
async function sendBarkDevice(device, title, body, spec) {
	const { endpoint, key, own } = resolveBark(device.url);
	if (!key) throw new Error("Bark 设备 URL 未解析出 device_key");
	const payload = {
		device_key: key,
		title: barkTitle(title),
		body,
		group: spec.group,
		level: spec.level,
		isArchive: 1,
		...own // ← URL 自带同名参数最后合并 ⇒ 用户手填 group/level 不被覆盖 (§2.2)
	};
	const resp = await fetch(endpoint, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
	});
	if (!resp.ok) throw new Error(`Bark HTTP ${resp.status}`);
	const data = await resp.json().catch(() => null);
	if (data?.code !== 200) throw new Error(`Bark code ${data?.code}: ${sanitize(data?.message ?? "")}`);
	return true;
}

/** 单台 Synology Chat 发送 (§5): form-urlencoded payload; 必须检查 success (入口失败也回 200)。 */
async function sendSynologyDevice(device, text) {
	const payload = JSON.stringify({ text });
	const resp = await fetch(device.url, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: `payload=${encodeURIComponent(payload)}`,
		signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
	});
	const data = await resp.json().catch(() => null);
	if (!resp.ok) throw new Error(`Synology HTTP ${resp.status}`);
	if (data?.success !== true) throw new Error(`Synology success:false: ${sanitize(JSON.stringify(data?.error ?? data))}`);
	return true;
}

/**
 * 发送核心: 全局 FIFO 串行 (v0.5.3 语义保留), 单设备失败不阻断其它设备。
 * @returns {{ok:boolean, sent:number, failed:number, results:Array<{deviceId:string,status:string,error?:string}>}}
 */
async function sendToDevices(devices, type, title, pages) {
	const run = sendQueue.then(async () => {
		const spec = typeSpec(type);
		const list = asArray(pages).map((p) => String(p)).filter((p) => p !== "");
		const results = [];
		if (!devices.length) {
			debug(`send ${type}: 无目标设备 ⇒ 零请求`);
			return results;
		}
		if (!list.length) {
			debug(`send ${type}: 内容为空 ⇒ 零请求`);
			return results;
		}
		const barkBody = list.join("\n\n");
		// Bark 单条全文; Synology 逐页串行 + 1.5s 间隔 (避开 entry.cgi 限流)
		for (const d of devices) {
			if (d.kind !== "bark") continue;
			try { await sendBarkDevice(d, title, barkBody, spec); results.push({ deviceId: d.id, status: "fulfilled" }); }
			catch (reason) { results.push({ deviceId: d.id, status: "rejected", error: sanitize(reason?.message ?? reason) }); }
		}
		for (const d of devices) {
			if (d.kind !== "synology") continue;
			for (const p of list) {
				try { await sendSynologyDevice(d, p); results.push({ deviceId: d.id, status: "fulfilled" }); }
				catch (reason) { results.push({ deviceId: d.id, status: "rejected", error: sanitize(reason?.message ?? reason) }); }
				await new Promise((r) => setTimeout(r, SEND_PAGE_INTERVAL_MS));
			}
		}
		for (const r of results) {
			debug(`send ${r.status} type=${type} device=${r.deviceId}${r.status === "rejected" ? `: ${r.error}` : ""}`);
			if (r.status === "rejected") logger?.warn?.(`dsh-notify: 推送失败 [${type} → ${r.deviceId}]: ${r.error}`);
		}
		return results;
	});
	// 队列吞掉异常, 保证后续通知不被卡死 (v0.5.3 同款)
	sendQueue = run.then(() => {}, () => {});
	const results = await run;
	const sent = results.filter((r) => r.status === "fulfilled").length;
	const failed = results.length - sent;
	return { ok: failed === 0, sent, failed, results };
}

/** 按 type 路由发送 (§2.1 路由语义)。 */
export async function sendByType(type, title, pages) {
	const hub = await loadHub();
	const byId = new Map(asArray(hub.devices).map((d) => [d.id, d]));
	const devices = resolveRouteIds(hub, type).map((id) => byId.get(id)).filter(Boolean);
	return sendToDevices(devices, type, title, pages);
}

/** body → 页数组 (Synology 2000 硬上限; 供外部调用方的简易入口)。 */
function bodyPages(body) {
	const t = String(body ?? "");
	if (!t) return [];
	if (t.length <= SYNOLOGY_PAGE_LIMIT) return [t];
	return chunkText(t, SYNOLOGY_PAGE_LIMIT - 8);
}

/**
 * 对外接口 (§2.3, Stage 3 抽成 dsh-notify-hub 时签名保持不变)。
 * @param {string} type 见 NOTIFY_TYPES
 * @param {{title?:string, body?:string, pages?:string[]}} payload
 * @returns {Promise<{ok:boolean, sent:number, failed:number, results:Array}>}
 */
export async function sendNotification(type, payload = {}) {
	const title = String(payload?.title ?? "");
	const pages = Array.isArray(payload?.pages) && payload.pages.length
		? payload.pages.map((p) => String(p))
		: bodyPages(payload?.body);
	if (!pages.length) return { ok: true, sent: 0, failed: 0, results: [] };
	return sendByType(type, title, pages);
}

// ---- RPC 层 (§3.3 / §7) ----------------------------------------------------

class HubError extends Error {
	constructor(code, message) { super(message); this.code = code; }
}

function publicDevice(d) {
	return { id: d.id, name: d.name, kind: d.kind, urlTail: urlTail(d.url), enabled: d.enabled !== false };
}

function assertDeviceUrl(url, kind) {
	let u;
	try { u = new URL(url); } catch { throw new HubError("bad-request", "URL 格式非法"); }
	if (u.protocol !== "http:" && u.protocol !== "https:") throw new HubError("bad-request", "URL 必须是 http/https");
	if (kind === "bark" && !resolveBark(url).key) throw new HubError("bad-request", "Bark URL 未含设备 key (形如 api.day.app/<KEY>)");
}

/** 新建设备时生成唯一 id (§7): bark → bark1/bark2/…; synology → chat/chat2/… */
export function nextDeviceId(hub, kind) {
	const used = new Set(asArray(hub?.devices).map((d) => d.id));
	if (kind !== "synology") {
		for (let i = 1; i < 1000; i++) if (!used.has(`bark${i}`)) return `bark${i}`;
		throw new HubError("bad-request", "设备数量已达上限");
	}
	if (!used.has("chat")) return "chat";
	for (let i = 2; i < 1000; i++) if (!used.has(`chat${i}`)) return `chat${i}`;
	throw new HubError("bad-request", "设备数量已达上限");
}

/** 设置卡快照 (get) —— v0.7.0 增补 `options` / `effective` / `types[].hasProducer` (§4)。 */
export async function snapshotHub() {
	const hub = await loadHub();
	// effective[type] = resolveRouteIds 的结果 (客户端"实际发往谁"以此为准, 不得自行重算)
	const effective = {};
	for (const t of NOTIFY_TYPES) effective[t.type] = resolveRouteIds(hub, t.type);
	return {
		version: hub.version,
		devices: asArray(hub.devices).map(publicDevice),
		routeDefault: hub.routeDefault,
		routes: hub.routes,
		options: normalizeOptions(hub.options),
		types: NOTIFY_TYPES.map((t) => ({ type: t.type, label: t.label, group: t.group, level: t.level, hasProducer: t.hasProducer === true })),
		effective,
		allDeviceIds: asArray(hub.devices).map((d) => d.id)
	};
}

/** saveDevice (§7): 新建/编辑; 编辑时 url 留空 = 保留原值 (卡上只显示尾号)。 */
export async function saveDevice(payload) {
	const hub = await loadHub();
	const name = String(payload?.name ?? "").trim();
	const kind = String(payload?.kind ?? "").trim();
	const url = typeof payload?.url === "string" ? payload.url.trim() : "";
	const idIn = payload?.id == null ? "" : String(payload.id);
	if (!DEVICE_KINDS.includes(kind)) throw new HubError("bad-request", `kind 必须是 ${DEVICE_KINDS.join(" / ")}`);
	if (!name) throw new HubError("bad-request", "名称不能为空");
	if (name.length > 64) throw new HubError("bad-request", "名称过长 (≤64 字符)");
	let id;
	let finalUrl;
	let enabled;
	if (idIn) {
		if (!DEVICE_ID_RE.test(idIn)) throw new HubError("bad-request", "设备 id 非法");
		const prev = asArray(hub.devices).find((d) => d.id === idIn);
		if (!prev) throw new HubError("not-found", `设备 "${idIn}" 不存在`);
		id = idIn;
		finalUrl = url || prev.url;
		enabled = payload?.enabled === undefined ? prev.enabled !== false : payload.enabled === true;
	} else {
		id = nextDeviceId(hub, kind);
		if (!url) throw new HubError("bad-request", "新增设备必须填完整 URL");
		finalUrl = url;
		enabled = payload?.enabled === undefined ? true : payload.enabled === true;
	}
	assertDeviceUrl(finalUrl, kind);
	const device = { id, name, kind, url: finalUrl, enabled };
	const devices = idIn ? asArray(hub.devices).map((d) => (d.id === id ? device : d)) : [...asArray(hub.devices), device];
	const next = await saveHub({ ...hub, devices });
	debug(`notify-hub: saveDevice id=${id} kind=${kind} url=${urlTail(finalUrl)} enabled=${enabled} (url 明文不落日志)`);
	return { id, devices: next.devices.map(publicDevice) };
}

/**
 * deleteDevice (§7): 同时从 routeDefault 与各 routes 中剔除。
 * v0.7.0 删设备规则 (§4): 原数组**非空**且过滤后为空 ⇒ **删键** (回落默认路由, 与旧行为一致,
 * 避免意外静音); 原数组**本来就是空** (显式关闭) ⇒ **保持空键**。
 */
export async function deleteDevice(payload) {
	const hub = await loadHub();
	const id = String(payload?.id ?? "");
	if (!asArray(hub.devices).some((d) => d.id === id)) throw new HubError("not-found", `设备 "${id}" 不存在`);
	const devices = asArray(hub.devices).filter((d) => d.id !== id);
	const routes = {};
	for (const [k, v] of Object.entries(hub.routes ?? {})) {
		const orig = asArray(v);
		const list = orig.filter((x) => x !== id);
		if (list.length) routes[k] = list; // 过滤后仍非空 ⇒ 保留
		else if (!orig.length) routes[k] = []; // 本就是显式关闭 ⇒ 保持空键
		// 原非空且过滤后为空 ⇒ 删键 (回落默认)
	}
	const next = await saveHub({ ...hub, devices, routes, routeDefault: asArray(hub.routeDefault).filter((x) => x !== id) });
	debug(`notify-hub: deleteDevice id=${id}`);
	return { devices: next.devices.map(publicDevice), routeDefault: next.routeDefault, routes: next.routes };
}

/**
 * setRoutes (§7): 未知 id 过滤; 未知 type 报 bad-request; routeDefault 只接受字符串数组。
 * v0.7.0 语义变更 (§1/§4): **空数组键原样保留** ⇒ 该 type 显式关闭 (零请求, 不回落默认);
 * 非数组的 route 值 ⇒ bad-request (避免脏值变成"静默关闭")。
 */
export async function setRoutes(payload) {
	const hub = await loadHub();
	const ids = new Set(asArray(hub.devices).map((d) => d.id));
	const clean = (v) => [...new Set(asArray(v).map((x) => String(x)))].filter((x) => ids.has(x));
	let routes = hub.routes ?? {};
	if (payload?.routes !== undefined) {
		if (!payload.routes || typeof payload.routes !== "object" || Array.isArray(payload.routes)) {
			throw new HubError("bad-request", "routes 必须是对象");
		}
		routes = {};
		for (const [k, v] of Object.entries(payload.routes)) {
			if (!TYPE_MAP.has(k)) throw new HubError("bad-request", `未知通知类型 "${k}"`);
			if (!Array.isArray(v)) throw new HubError("bad-request", `routes["${k}"] 必须是字符串数组`);
			routes[k] = clean(v); // 空数组保留 = 显式关闭 (§1); 未知 id 已过滤
		}
	}
	if (payload?.routeDefault !== undefined && !Array.isArray(payload.routeDefault)) {
		throw new HubError("bad-request", "routeDefault 必须是字符串数组"); // 契约 §7「只接受字符串数组」
	}
	const routeDefault = payload?.routeDefault === undefined ? asArray(hub.routeDefault) : clean(payload.routeDefault);
	const next = await saveHub({ ...hub, routes, routeDefault });
	debug(`notify-hub: setRoutes typeGroups=${Object.keys(next.routes).length} routeDefault=${next.routeDefault.length}`);
	return { routeDefault: next.routeDefault, routes: next.routes };
}

/**
 * setOptions (§4, v0.7.0 新增): 仅接受 minTurnMs / bannerSummary / reconcile;
 * 未给出的键保持原值; 非法值按 §3 规整 (**不报错**, 回写规整后的值)。
 */
export async function setOptions(payload) {
	const hub = await loadHub();
	const cur = normalizeOptions(hub.options);
	const raw = payload && typeof payload === "object" ? payload : {};
	// 逐键规整: 未给出 ⇒ 原值; 非法 ⇒ 原值 (§3 "非布尔 → 用默认", 此处默认即当前生效值)
	const next = normalizeOptions({
		...(raw.minTurnMs !== undefined ? { minTurnMs: raw.minTurnMs } : { minTurnMs: cur.minTurnMs }),
		...(raw.bannerSummary !== undefined ? { bannerSummary: raw.bannerSummary } : { bannerSummary: cur.bannerSummary }),
		...(raw.reconcile !== undefined ? { reconcile: raw.reconcile } : { reconcile: cur.reconcile })
	}, cur);
	const saved = await saveHub({ ...hub, options: next });
	debug(`notify-hub: setOptions minTurnMs=${saved.options.minTurnMs} bannerSummary=${saved.options.bannerSummary} reconcile=${saved.options.reconcile}`);
	return { options: saved.options };
}

/** test (§7): 只打被点的那台设备 (不受 enabled / 路由影响)。 */
export async function testDevice(payload) {
	const hub = await loadHub();
	const id = String(payload?.id ?? "");
	const device = asArray(hub.devices).find((d) => d.id === id);
	if (!device) throw new HubError("not-found", `设备 "${id}" 不存在`);
	const title = `测试推送 · ${device.name}`;
	const body = `通道测试 ${new Date().toLocaleString("zh-CN", { hour12: false })}\n设备: ${device.id} (${device.kind})\n这是一条来自 DSH 通知中枢的测试消息。`;
	const res = await sendToDevices([device], "test", title, [body]);
	const r = res.results[0];
	return { id, status: r?.status === "fulfilled" ? "ok" : "fail", ...(r?.status === "fulfilled" ? {} : { error: r?.error ?? "未发送" }) };
}

/** 组装 /notify-hub handler (apply 与单测共用, 同 /model-console 先例)。 */
export function createRpcHandler() {
	return async function handle(endpoint, payload) {
		try {
			switch (endpoint) {
			case "get": return { ok: true, value: await snapshotHub() };
			case "saveDevice": return { ok: true, value: await saveDevice(payload) };
			case "deleteDevice": return { ok: true, value: await deleteDevice(payload) };
			case "setRoutes": return { ok: true, value: await setRoutes(payload) };
			case "setOptions": return { ok: true, value: await setOptions(payload) };
			case "test": return { ok: true, value: await testDevice(payload) };
			default: return { ok: false, error: { code: "not-found", message: `未知端点 ${String(endpoint)}` } };
			}
		} catch (err) {
			const code = err instanceof HubError ? err.code : "internal";
			const msg = sanitize(err?.message ?? err);
			// 只打 endpoint 与脱敏后的消息, 绝不打 payload (可能含明文 url/key)
			logger?.warn?.(`dsh-notify: /notify-hub RPC ${String(endpoint)} 失败: ${msg}`);
			debug(`rpc ${String(endpoint)} 失败: ${msg}`);
			return { ok: false, error: { code, message: msg } };
		}
	};
}

/** 注入 apply 侧上下文 (迁移源/日志器/patch 阈值); 单测可直接设 env + 调 loadHub。 */
export function configureHub({ migration, log, minTurnMs } = {}) {
	if (migration) hubMigrationSource = migration;
	if (log) logger = log;
	// v0.7.0 (§3): options.minTurnMs 初值 = patch config.minTurnMs ?? 60000
	if (minTurnMs !== undefined) setOptionsDefaults(minTurnMs);
}

const fmtElapsed = (ms) => {

	const s = Math.round(ms / 1000);
	if (s < 60) return `${s} 秒`;
	return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
};

/**
 * 代码层去除 Markdown 格式符号, 输出纯文本 (不依赖模型另答纯文本)。
 * 处理: 代码块/行内代码/标题/粗体/斜体/删除线/链接/图片/引用/表格/列表/分隔线/行内HTML。
 */
export function stripMarkdown(text) {
	if (!text) return "";
	let t = String(text);
	// 1) 代码块 ```lang\n...\n``` → 保留内部代码 (去围栏与语言标注)
	t = t.replace(/```[^\n]*\n?([\s\S]*?)```/g, "$1");
	// 2) 图片 ![alt](url) → alt
	t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
	// 3) 链接 [text](url "title") → text (url)
	t = t.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g, (m, txt, url) => {
		const label = String(txt ?? "").trim();
		return label ? `${label} (${url})` : url;
	});
	// 3.5) 自动链接 <https://...> → 保留 URL (须在 HTML 标签去除之前)
	t = t.replace(/<(https?:\/\/[^\s>]+)>/g, "$1");
	// 4) 行内代码 `code` → code
	t = t.replace(/`([^`]+)`/g, "$1");
	// 5) 粗体/斜体/删除线: **x** __x__ ~~x~~ *x* _x_ → x
	t = t.replace(/(\*\*|__)(.*?)\1/g, "$2");
	t = t.replace(/~~(.*?)~~/g, "$1");
	t = t.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1$2");
	t = t.replace(/(^|[^_\w])_([^_\n]+)_/g, "$1$2");
	// 6) 标题 # → 去井号
	t = t.replace(/^#{1,6}\s+/gm, "");
	// 7) 引用 > → 去符号
	t = t.replace(/^\s*>\s?/gm, "");
	// 8) 表格: 分隔线行 (|--|) 删除(连行尾换行); 内容行去首尾竖线, 内竖线 → ·
	//    ⚠ 内容行必须用 [^\n]* 且不能以 \s*$ 跨界吞换行, 否则两行会粘成一行
	t = t.replace(/^\s*\|?[\s:|-]+\|?\s*(?:\n|$)/gm, "");
	t = t.replace(/^\s*\|([^\n]*)\|\s*$/gm, "$1");
	t = t.replace(/\s*\|\s*/g, " · ");
	// 9) 无序列表 - * + → - ; 有序列表保留数字
	t = t.replace(/^\s*[-*+]\s+/gm, "- ");
	// 10) 分隔线 --- *** ___ → 删除(连行尾换行)
	t = t.replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*(?:\n|$)/gm, "");
	// 11) 行内 HTML 标签 → 去标签
	t = t.replace(/<[^>]+>/g, "");
	// 12) 行首尾空白清理 + 压缩多余空行, 收尾
	t = t.replace(/^ +/gm, "").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
	return t;
}

/**
 * 按上限切块, 不切在 UTF-16 代理对中间 (emoji 等不产生乱码)。
 */
export function chunkText(text, limit) {
	if (!text) return [];
	const chunks = [];
	let rest = String(text);
	while (rest.length > limit) {
		let cut = limit;
		const c = rest.charCodeAt(cut - 1);
		if (c >= 0xd800 && c <= 0xdbff) cut -= 1;
		chunks.push(rest.slice(0, cut));
		rest = rest.slice(cut);
	}
	if (rest.length > 0) chunks.push(rest);
	return chunks;
}

/**
 * 按 Synology Chat 单条 2000 字符上限把通知拆成多条 (页), **纯文本格式** (v0.5.3):
 *   页 1:   ================================== (块首, 34 个 =)
 *           ✅ 标题 (✅完成/❌中断/⁉️提问 + 会话标题)
 *           ────────────────────────────── (问题↔回复分隔线, 30 个 ─)
 *           👀 问题
 *           <完整提问>
 *
 *           💡 回复
 *           <回答分块>
 *   续页:   <纯内容, 无页码无标签无装饰> (群晖 Chat 拼接短时间推送, 无缝续接)
 *   最后页: <内容结尾>
 *
 *           [回合/用时/原因/会话 页脚]
 *           ================================== (块尾)
 * 块首尾等号线区分不同通知块; 页脚只在最后页、结束等号前;
 * 回复中的 markdown 列表行自动转 ➡️ 选项; 提问极长 (>1500) 兜底截断。
 */
/** 纯文本分隔线 (Synology Chat 不渲染 markdown, 用全角字符做视觉分隔) */
const SEP = "=".repeat(34);
/** 问题↔回复 横向分隔线 (v0.5.3, 30 个 ─) */
const FIELD_SEP = "─".repeat(30);

/**
 * 检测 agent 回复是否以"提问"结尾 (v0.5.2, 用户要求: 回合结束在向用户提问时也要通知,
 * 否则用户不知道需要回应)。判定: 末尾或最后一行以 ?/？ 结尾, 或以中文问句短语结尾,
 * 或最后一行含强"等待回应"短语。启发式, 可能有个别误判, 但只影响通知文案不误伤功能。
 */
const QUESTION_SUFFIX = /[?？]\s*$/;
const QUESTION_PHRASE = /(可以吗|行吗|好吗|对吗|怎么样|如何|行不行|要不要|是否|确认吗|同意吗)\s*$/;
const WAITING_MARKS = ["请确认", "确认一下", "等你确认", "等你回应", "请回复", "请选择", "请回答", "需要你确认", "等待你的"];
export function isQuestionText(text) {
	if (!text) return false;
	let t = String(text).trim();
	// 去掉末尾的 markdown 装饰与闭合括号再判断 — 如 "你确认吗？**" (加粗结尾)、"（你确认吗？）"
	// 2026-08-29 实测: agent 常以 **...？** 提问, 不剥掉会漏判
	let prev;
	do {
		prev = t;
		t = t.replace(/[*_`~）)】》」』\s]+$/, "");
	} while (t !== prev && t.length > 0);
	if (!t) return false;
	if (QUESTION_SUFFIX.test(t) || QUESTION_PHRASE.test(t)) return true;
	const lastLine = t.split("\n").pop().trim();
	if (!lastLine) return false;
	if (QUESTION_SUFFIX.test(lastLine) || QUESTION_PHRASE.test(lastLine)) return true;
	return WAITING_MARKS.some((m) => lastLine.includes(m));
}

/**
 * 在预算内找最近的**段落/换行边界**切断 (v0.5.1 改进): 优先段落后 (\n\n),
 * 其次换行后 (\n), 都找不到 (超长单行) 才硬切; 窗口 = max(200, limit*50%)
 * 覆盖常见段落长度 (LLM 输出段落一般 <500 字, 50% 窗口足以命中其断点);
 * 同时不切碎 UTF-16 代理对 (emoji)。
 * @returns 实际切断位置 (切点之后的内容进入下一页)
 */
function cutAtBoundary(text, limit) {
	let cut = limit;
	const c = text.charCodeAt(cut - 1);
	if (c >= 0xd800 && c <= 0xdbff) cut -= 1;
	const window = Math.max(200, Math.floor(cut * 0.5));
	const head = text.slice(0, cut);
	// 段落断点 (\n\n) 优先
	const paraIdx = head.lastIndexOf("\n\n");
	if (paraIdx >= cut - window) return paraIdx + 2;
	// 单换行其次
	const nlIdx = head.lastIndexOf("\n");
	if (nlIdx >= cut - window) return nlIdx + 1;
	// 都没有 → 硬切
	return cut;
}

/**
 * 按 Synology Chat 单条 2000 字符上限把通知拆成多条 (页), **纯文本格式** (v0.5.3):
 *   title 已含状态 emoji (✅ 完成 / ❌ 中断 / ⁉️ 提问)。
 *   块首尾 34 个 = ; 问题↔回复 30 个 ─ ; 👀 问题 / 💡 回复;
 *   回复中 markdown 列表行自动转 ➡️ 选项; 无 [x/y] 页码;
 *   续页 = 纯内容 (无缝拼接); 页脚只在最后页、结束等号前。
 * 提问极长 (>1500) 兜底截断, 保证任何输入都不产生超限消息。
 */
export function composeSynologyPages(title, question, answer, footerText) {
	const q = String(question ?? "").trim();
	const qLine = q.length > 1500 ? `👀 问题\n${q.slice(0, 1500)}…` : (q ? `👀 问题\n${q}` : "");
	// 回复中 markdown 列表行 (- / * / + / 数字.) 自动转 ➡️ 选项 (v0.5.3, 用户确认)
	let rest = String(answer ?? "").trim()
		.replace(/^\s*[-*+]\s+/gm, "➡️ ")
		.replace(/^\s*\d+[.、]\s+/gm, "➡️ ");
	const pages = [];
	if (!rest) {
		const lines = [SEP, title, FIELD_SEP];
		if (qLine) lines.push(qLine);
		lines.push(footerText, SEP);
		pages.push(lines.join("\n"));
		return pages;
	}
	// 页预算 = 上限 - 该页固定头尾 (标题/分隔线/提问/回复标签/页脚), 答案本体按预算切块;
	// 第 1 页按"单页含全部头尾"最坏情况算 (多页时第 1 页会略短, 安全);
	// 最后页 = 内容 + 页脚 + 块尾等号线; 中间续页 = 纯内容 (预算最大)。
	const overhead1 = SEP.length + 1 + title.length + 1 + FIELD_SEP.length + 1
		+ qLine.length + 1 + FIELD_SEP.length + 1 + "💡 回复".length + 1
		+ footerText.length + 1 + SEP.length + 1;
	const b1 = Math.max(120, SYNOLOGY_PAGE_LIMIT - overhead1);
	const bl = Math.max(120, SYNOLOGY_PAGE_LIMIT - (footerText.length + 1 + SEP.length + 1));
	const chunks = [];
	let r = rest;
	let first = true;
	while (r.length > (first ? b1 : bl)) {
		chunks.push(r.slice(0, cutAtBoundary(r, first ? b1 : bl)));
		r = r.slice(chunks[chunks.length - 1].length);
		first = false;
	}
	if (r) chunks.push(r);
	const total = chunks.length;
	if (total === 1) {
		const lines = [SEP, title, FIELD_SEP];
		if (qLine) lines.push(qLine, "");
		lines.push(`💡 回复\n${chunks[0]}`, "", footerText, SEP);
		pages.push(lines.join("\n"));
		return pages;
	}
	chunks.forEach((chunk, i) => {
		if (i === 0) {
			const lines = [SEP, title, FIELD_SEP];
			if (qLine) lines.push(qLine, "");
			lines.push(`💡 回复\n${chunk}`);
			pages.push(lines.join("\n"));
		} else if (i === total - 1) {
			// 最后页: 内容 + 页脚 + 块尾等号线
			pages.push(`${chunk}\n\n${footerText}\n${SEP}`);
		} else {
			// 续页: 纯内容, 无页码无标签无装饰
			pages.push(chunk);
		}
	});
	// 兜底: 极端输入仍超限时硬切 (宁丢格式不丢消息)
	return pages.flatMap((p) => (p.length > SYNOLOGY_PAGE_LIMIT ? chunkText(p, SYNOLOGY_PAGE_LIMIT) : [p]));
}

// ---- 2026-09-10 (0.1.2 适配): agent.session.events 已不可用 ----
// 旧实现在这里直接 `session.events.findLast(...)` / `session.events` 反扫 → 0.1.2 抛
// "Cannot read properties of undefined" 且被上层静默吞掉 → **推送自 09-09 05:19 起完全停摆**
// (日志证据: 最后一次 send fulfilled = 05:19:54, 之后 turn/end 只到 hasChannel=true 就没了)。
// 改为: 观察者逐事件维护"各会话最近标题/用户问题/回答"缓存 (有界), 旧版仍回退扫 events。
const sessionEventCache = new Map(); // sid -> { title, userQ, assistantA }
const SESSION_CACHE_MAX = 300;
function cacheSessionEvent(session, event) {
	try {
		const sid = String(session?.id ?? "");
		if (!sid || !event?.type) return;
		let e = sessionEventCache.get(sid);
		if (!e) {
			e = { title: "", userQ: "", assistantA: "" };
			sessionEventCache.set(sid, e);
			if (sessionEventCache.size > SESSION_CACHE_MAX) {
				const oldest = sessionEventCache.keys().next().value;
				sessionEventCache.delete(oldest);
			}
		}
		if (event.type === "session/title" && typeof event.data?.title === "string") e.title = event.data.title;
		if (event.type === "user/message" && event.data?.source?.kind === "user") {
			const b = event.data?.content?.[0];
			if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) e.userQ = b.text.trim();
		}
		if (event.type === "assistant/message") {
			const msg = event.data?.message ?? event.data;
			const blocks = Array.isArray(msg?.content) ? msg.content : [];
			const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
			if (text) e.assistantA = text;
		}
	} catch { /* 缓存失败不影响主流程 */ }
}

/** 最近一次会话标题 (session/title 事件), 无则空串 */
function sessionTitle(session) {
	const cached = sessionEventCache.get(String(session?.id ?? ""));
	if (cached?.title) return cached.title;
	const events = session?.events ?? [];
	const ev = Array.isArray(events) ? events.findLast((e) => e.type === "session/title" && typeof e.data?.title === "string") : null;
	return ev?.data?.title ?? "";
}

/** 本轮最后一个真实用户消息 (source.kind="user") 的文本 */
function lastUserQuestion(session) {
	const cached = sessionEventCache.get(String(session?.id ?? ""));
	if (cached?.userQ) return cached.userQ;
	const events = session?.events ?? [];
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i];
		if (e.type !== "user/message") continue;
		if (e.data?.source?.kind !== "user") continue;
		const block = e.data?.content?.[0];
		if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) return block.text.trim();
	}
	return "";
}

/** 本轮最后一个 assistant 文本答复 (content 在 data.message.content, 兼容 data.content) */
function lastAssistantAnswer(session) {
	const cached = sessionEventCache.get(String(session?.id ?? ""));
	if (cached?.assistantA) return cached.assistantA;
	const events = session?.events ?? [];
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i];
		if (e.type !== "assistant/message") continue;
		const msg = e.data?.message ?? e.data;
		const blocks = Array.isArray(msg?.content) ? msg.content : [];
		const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
		if (text) return text;
	}
	return "";
}

/**
 * 启发式提取回复文本中的"总结信息"段落, 无则返回 ""。
 * 匹配: 总结/小结/汇总/完成情况/任务总结/续接提示词 等标记开头的段落
 * (支持 "总结：", "## 总结", "【续接提示词】" 等常见形式)。
 * 提取自标记行起至回复尾部, 截断 400 字符 (横幅展示上限)。
 * 注: 横幅展示用原始文本 (保留 markdown), 与外部推送的去 markdown 纯文本互不影响。
 */
const SUMMARY_MARKS = ["总结", "小结", "汇总", "完成情况", "任务总结", "续接提示词"];
function extractSummary(text) {
	if (!text) return "";
	const lines = String(text).split("\n");
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line) continue;
		const isMark = SUMMARY_MARKS.some((m) =>
			line === m
			|| line.startsWith(`${m}：`) || line.startsWith(`${m}:`)
			|| (line.startsWith("#") && line.includes(m))
			|| line.includes(`【${m}】`) || line.includes(`[${m}]`)
		);
		if (isMark) { start = i; break; }
	}
	if (start < 0) return "";
	const out = lines.slice(start).join("\n").trim();
	return out.length > 400 ? `${out.slice(0, 400)}…` : out;
}

const DEBUG_LOG = "/workspace/log/notify/notify-debug.log";
try { mkdirSync("/workspace/log/notify", { recursive: true }); } catch {}
function debug(msg) {
	try { appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch { /* ignore */ }
}

// 对账去重标记: 已补推过的中断回合 "会话id:回合号"
const RECONCILE_FILE = "/data/dsh/notify-reconcile.json";

export async function apply(ctx, config) {
	// 注册自定义会话事件类型 notice/banner (dsh-notice-banner client 插件渲染横幅):
	// 非 surface 事件, 不进入模型历史; 加入 KNOWN_SESSION_EVENT_TYPES 使持久化
	// 读取路径 (dsh-session-persistence assertEventsSupported) 接受该类型,
	// 否则会话日志重建会拒绝未知类型事件。Set.add 幂等, 可重复执行。
	KNOWN_SESSION_EVENT_TYPES.add("notice/banner");
	// ---- 通知中枢接线 (Stage 1, 2026-09-12) ----
	// 迁移源 = 现有 patch 配置 + env 兜底 (§2.1 迁移); 无 notify-hub.json 时自动生成
	logger = ctx.logger;
	configureHub({
		migration: {
			barkKeys: config?.barkKeys ?? [],
			synologyWebhookUrl: config?.synologyWebhookUrl ?? "",
			envBarkKeys: process.env.DSH_BARK_KEYS ? process.env.DSH_BARK_KEYS.split(",").map((s) => s.trim()).filter(Boolean) : [],
			envSynologyUrl: process.env.DSH_SYNOLOGY_WEBHOOK_URL ?? ""
		},
		log: ctx.logger,
		// v0.7.0 (§3): patch config.minTurnMs 只作 options.minTurnMs 的初值
		minTurnMs: config?.minTurnMs
	});
	const minTurnMs = config?.minTurnMs ?? 60000;
	const hub = await loadHub();
	// v0.7.0: 运行时阈值/开关一律取 options 快照 (refreshHubFlags 随 loadHub 刷新)
	const opts0 = currentOptions();
	debug(`apply: patchMinTurnMs=${minTurnMs} options.minTurnMs=${opts0.minTurnMs} bannerSummary=${opts0.bannerSummary} reconcile=${opts0.reconcile} hub=${HUB_FILE} devices=${hub.devices.length} enabled=${allEnabledIds(hub).length} (url 明文不落日志)`);

	// /notify-hub RPC 通道 (§3.3; 已认证 = dsh 既有浏览器登录会话 RPC 面, 不新增免登录端点)。
	// 第三参 `{}` 必传, 否则 register 读 options.authority 会 TypeError (速查 §2.5 已记录)。
	try {
		ctx.get?.("connection")?.rpc?.handle?.(CHANNEL, createRpcHandler(), {});
		debug("apply: /notify-hub RPC 已注册");
	} catch (e) {
		ctx.logger?.warn?.(`dsh-notify: /notify-hub RPC 注册失败: ${sanitize(e?.message ?? e)}`);
	}
	// 服务名 notifyHub (§2.3): 其它插件用 ctx.get("notifyHub").send(type, payload)
	try { ctx.provide?.("notifyHub", { send: sendNotification }); }
	catch (e) { ctx.logger?.warn?.(`dsh-notify: notifyHub 服务注册失败: ${sanitize(e?.message ?? e)}`); }

	// 回合计时: sessionId -> { turn, startTs }
	const turnStarts = new Map();

	ctx.on("session/event", (session, event) => {
		cacheSessionEvent(session, event); // 2026-09-10: 0.1.2 无 session.events → 观察者侧自建缓存
		if (event.type === "turn/start" || event.type === "turn/end") debug(`event ${event.type} turn=${event.data?.turn} sid=${String(session?.id ?? "").slice(0, 12)}`);
		if (!session?.id || !event?.type) return;
		if (event.type === "turn/start" && typeof event.data?.turn === "number") {
			turnStarts.set(session.id, { turn: event.data.turn, startTs: Date.now() });
			// v0.7.0: 回合开始时刷新一次 hub/options 快照 (loadHub 按 mtime 失效) ⇒
			// 设置卡里刚改的 minTurnMs / bannerSummary 在本回合结束时即生效, 无需重启
			void loadHub().catch(() => {});
			return;
		}
		// v0.5.4 (用户要求): **仅真实 asking 状态触发"需要你回应"** —
		// agent 调用 ask_user_question 工具 (前端渲染选择组件等用户回答) 才推送,
		// 不再用文本问句启发式 (isQuestionText) 判定, 避免普通问句误触发。
		// 推送时机: tool/call 事件到达时 (回合仍在进行中, 用户在等前端选择),
		// 问题/选项从工具参数 arguments (JSON) 解析, 列表转 ➡️ 选项行。
		if (event.type === "tool/call" && event.data?.name === "ask_user_question") {
			const turn = event.data?.turn;
			if (typeof turn !== "number") return;
			const sid = String(session.id ?? "");
			const sidShort = sid.startsWith("session-") ? sid.slice(8, 16) : sid.slice(0, 8);
			debug(`ask_user_question: turn=${turn} → 推送"需要你回应"`);
			let qText = "";
			let optionLines = [];
			try {
				const args = JSON.parse(String(event.data?.arguments ?? "{}"));
				const qs = Array.isArray(args?.questions) ? args.questions : [];
				qText = qs.map((q) => String(q?.question ?? "")).filter(Boolean).join("\n");
				optionLines = qs.flatMap((q) => Array.isArray(q?.options)
					? q.options.map((o) => String(o?.label ?? o ?? "")).filter(Boolean)
					: []);
			} catch { /* arguments 解析失败则回退到会话历史 */ }
			const rawQ = qText || lastUserQuestion(session);
			const rawA = optionLines.length
				? `请选择：\n${optionLines.map((o) => `➡️ ${o}`).join("\n")}`
				: lastAssistantAnswer(session);
			// v0.6.0: 标题里冗余的 "DSH" 字样移除 — 改由 Bark 统一 "[DSH] " 前缀承载 (§2.2),
			// 避免出现 "[DSH] ⁉️ DSH 需要你回应" 的双 DSH 字样 (2026-09-12 用户确认)。
			const qTitle = `⁉️ 需要你回应 · ${sessionTitle(session) || "会话"}`;
			const qFooter = `回合 #${turn} 在等你回应 · 会话 ${sidShort}`;
			const qPages = composeSynologyPages(qTitle, stripMarkdown(rawQ), stripMarkdown(rawA), qFooter);
			// v0.7.0 (§2 映射): 提问推送走独立 type task.asking (不受 options.minTurnMs 限制)
			void sendByType("task.asking", qTitle, qPages);
			return;
		}
		if (event.type !== "turn/end") return;
		const start = turnStarts.get(session.id);
		turnStarts.delete(session.id);
		if (!start) return;
		const elapsed = Date.now() - start.startTs;
		if (!hubHasChannel) return;
		// v0.7.0 (§3): 门槛取 options.minTurnMs (设置卡可改, 立即生效); patch 配置只提供初值
		const thresholdMs = currentOptions().minTurnMs;
		debug(`turn/end: elapsed=${elapsed}ms threshold=${thresholdMs}ms hubHasChannel=${hubHasChannel}`);
		const turn = event.data?.turn ?? start.turn;
		const rawReason = event.data?.reason;
		const reasonText = typeof rawReason === "string"
			? rawReason
			: rawReason && typeof rawReason === "object"
				? (rawReason.kind ?? JSON.stringify(rawReason))
				: "unknown";
		const sid = String(session.id ?? "");
		const sidShort = sid.startsWith("session-") ? sid.slice(8, 16) : sid.slice(0, 8);
		// v0.5.0: 外部推送用去 markdown 的完整问答; 横幅总结仍用原始文本
		const rawQ = lastUserQuestion(session);
		const rawA = lastAssistantAnswer(session);
		if (elapsed < thresholdMs) return;
		const summary = extractSummary(rawA);
		const title = `✅ 任务完成 · ${sessionTitle(session) || "会话"}`;
		const footer = `回合 #${turn} 完成 (用时 ${fmtElapsed(elapsed)}) · 原因: ${reasonText} · 会话 ${sidShort}`;
		const pages = composeSynologyPages(title, stripMarkdown(rawQ), stripMarkdown(rawA), footer);
		// v0.7.0 (§2 映射): 回合结束推送走独立 type task.done
		void sendByType("task.done", title, pages);
		// 本地横幅 (v0.3.0, 用户要求): 普通完成通知内容与外部推送相同,
		// 不再在 GUI 重复弹"任务完成"浮窗; 仅当回复含"新的总结信息"
		// (总结段落, extractSummary 启发式) 时注入, 以【总结】展示
		// 通知里没有的新内容。注入需 setTimeout 延迟到 turn/end 事件
		// 派发之外, 避免 session.append 重入被吞 (与 cost-guard 同法)。
		// v0.7.0 (§3): options.bannerSummary=false ⇒ 完全不注入 notice/banner (外部推送不受影响)
		if (!currentOptions().bannerSummary) {
			debug(`注入跳过: options.bannerSummary=false (turn=${turn} elapsed=${elapsed}ms)`);
			return;
		}
		if (!summary) {
			debug(`注入跳过: 无总结信息 (turn=${turn} elapsed=${elapsed}ms)`);
			return;
		}
		setTimeout(() => {
			try {
				session.append("notice/banner", {
					kind: "notify",
					title,
					lines: [`【总结】${summary}`, `回合 #${turn} 完成 (用时 ${fmtElapsed(elapsed)}) · 会话 ${sidShort}`],
					turn,
					elapsedMs: elapsed,
					reason: reasonText,
					sessionShort: sidShort,
					hasSummary: true,
					time: Date.now()
				});
				debug(`注入会话成功 (notice/banner kind=notify 含总结 turn=${turn})`);
			} catch (err) {
				ctx.logger.warn(`dsh-notify: 注入会话失败: ${String(err?.message ?? err)}`);
				debug(`注入会话失败: ${String(err?.message ?? err)}`);
			}
		}, 100);
	});

	// ---- 幂等对账 (v0.4.0): 重启掐断的回合, 其 turn/end (reason=interrupted)
	// 由会话重载修复机制合成但观察者收不到 → 会话恢复 (session/created) 时补推
	// 一条"回合被中断"外部通知。中断回合不注入本地总结横幅 (避免与"任务完成"
	// 语义混淆, GUI 里用户本就能看到会话被中断)。去重: 状态文件记录已补推的
	// "会话id:回合号", 重启后同一会话只补推一次。----
	let reconcileWriteChain = Promise.resolve();
	async function readReconcileState() {
		try { return JSON.parse(await readFile(RECONCILE_FILE, "utf8")); } catch { return { pushed: {} }; }
	}
	async function markPushed(key) {
		try {
			reconcileWriteChain = reconcileWriteChain.then(async () => {
				const state = await readReconcileState();
				state.pushed[key] = new Date().toISOString();
				await writeFile(RECONCILE_FILE, JSON.stringify(state, null, 2), "utf8");
			});
			await reconcileWriteChain;
		} catch (e) {
			ctx.logger.warn(`dsh-notify: 对账标记写盘失败: ${String(e?.message ?? e)}`);
		}
	}
	attachReconcile(ctx, {
		name: "notify",
		shouldReconcile: async (session) => {
			// v0.7.0 (§3): options.reconcile=false ⇒ 恒 false (不补推、不写去重标记)
			if (!currentOptions().reconcile) return false;
			if (!hubHasChannel) return false;
			const end = lastTurnEnd(session);
			if (!end || end.reason !== "interrupted" || !Number.isInteger(end.turn)) return false;
			const state = await readReconcileState();
			return !state.pushed?.[`${session.id}:${end.turn}`];
		},
		reconcile: async (session) => {
			const end = lastTurnEnd(session);
			if (!end) return;
			const key = `${session.id}:${end.turn}`;
			const elapsed = turnElapsedMs(session, end);
			const thresholdMs = currentOptions().minTurnMs; // v0.7.0: options.minTurnMs
			debug(`reconcile: 中断回合 #${end.turn} elapsed=${elapsed}ms threshold=${thresholdMs}ms hubHasChannel=${hubHasChannel}`);
			if (elapsed === null || elapsed < thresholdMs) {
				// 短回合被打断不值得打扰; 标记避免每次启动重算
				await markPushed(key);
				return;
			}
			const sid = String(session.id ?? "");
			const sidShort = sid.startsWith("session-") ? sid.slice(8, 16) : sid.slice(0, 8);
			const rawQ = lastUserQuestion(session);
			const rawA = lastAssistantAnswer(session);
			const title = `❌ 回合被中断 · ${sessionTitle(session) || "会话"}`;
			const footer = `回合 #${end.turn} 被中断 (用时 ${fmtElapsed(elapsed)}) · 会话 ${sidShort}`;
			const pages = composeSynologyPages(title, stripMarkdown(rawQ), stripMarkdown(rawA), footer);
			// v0.7.0 (§2 映射): 中断补推走独立 type task.interrupted
			const res = await sendByType("task.interrupted", title, pages);
			await markPushed(key);
			debug(`reconcile: 中断回合 #${end.turn} 推送完成 ${res.sent}/${res.results.length}`);
		}
	});

	// 验证命令: 走通知中枢路由 (type=test), 目标设备由 notify-hub.json 决定
	ctx.commands.register({
		name: "notify-test",
		description: "发送测试通知 (走通知中枢路由: Bark 多设备 / Synology Chat)",
		handler: async () => {
			const h = await loadHub();
			const ids = resolveRouteIds(h, "test");
			if (!ids.length) {
				return {
					kind: "error",
					text: `没有可发送的设备 (共 ${h.devices.length} 台, 启用 ${allEnabledIds(h).length} 台) — 检查设置 > 本地插件 > 通知, 或 /data/dsh/notify-hub.json`
				};
			}
			const body = `通道测试 ${new Date().toLocaleString("zh-CN", { hour12: false })}\n目标设备: ${ids.join(", ")}`;
			const res = await sendByType("test", "DSH 测试通知", [body]);
			return {
				kind: res.failed ? "error" : "success",
				text: `已发送: ${res.sent} 成功, ${res.failed} 失败${res.failed > 0 ? " (详见服务日志)" : ""}`
			};
		}
	});
}
