import { appendFileSync, mkdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";

/**
 * @deepseek-ai/dsh-auth-mfa (本地辅助插件, 非官方包) —— host 半侧
 *
 * 登录二次验证 (MFA/TOTP) 管理的**本地 IPC 通道**：把 dsh 内的设置卡接到 auth-proxy
 * 自己的 `/mfa/api/*` 上（浏览器永远拿不到本地令牌；dsh 进程内插件同容器同文件系统 ⇒ 可以）。
 *
 * 契约 (冻结, 不得擅自改):
 *   docs/任务记录/2026-09-12-通知中枢Stage3-契约与决策.md §1.1(令牌) / §2(动作矩阵) / §5(设置卡)
 *   docs/任务记录/2026-09-13-通知中枢Stage5-契约与决策.md §1(状态字段) / §2(setOtp) / §4(设置卡开关)
 *   docs/任务记录/2026-09-12-本地插件折叠卡-契约.md (设置卡形态)
 *
 * 设计要点:
 *   - 通道 `/auth-mfa`（ctx.connection.rpc.handle，已认证；同 /notify-hub 先例），
 *     方法 1:1 映射契约 §2: status|seed|enable|regenerate|disable|purge|revokeDevice|revokeAll|unlock；
 *     **Stage 5 追加 `setOtp`**（手机一次性码开关，契约 §2：请求 {otpEnabled?, autoSend?}，
 *     响应 {ok,otp:{enabled,autoSend,codes,mfa},changed:{}}；仅当两个字段都缺 ⇒ 400 bad-request）。
 *   - 实现 = `POST ${DSH_AUTH_PROXY_URL || http://127.0.0.1:3080}/mfa/api/<method>`，
 *     JSON 透传（请求/响应都是 auth-proxy 的形状，本层不加工、不发明字段），
 *     请求头 `X-DSH-MFA-Token: <本地 IPC 令牌>`。
 *   - 令牌读 `DSH_AUTH_MFA_TOKEN_FILE || /data/dsh/.auth-mfa-admin-token`：
 *     **只读**（绝不创建/改权限/改内容）、**mtime 缓存**（auth-proxy 重启换了令牌自动跟随）、
 *     **值绝不出现在响应、日志、错误信息里**（响应做 scrub 兜底：万一上游回显令牌也打码）。
 *   - 超时 8s（AbortSignal.timeout）；**任何失败都转成 `{ok:false, error:'<简述>'}`，绝不 throw 到 RPC 层**。
 *   - 只依赖 node 内置模块（无 schemastery / 无第三方依赖）。
 */

export const name = "dsh-auth-mfa";
export const inject = ["connection"];

/** RPC 通道名（契约 §5）。 */
export const CHANNEL = "/auth-mfa";

/**
 * 白名单方法（契约 §2 动作矩阵，逐字）。**白名单同时是路径注入防线**：
 * 未列出的 method 一律本地拒绝并返回 `{ok:false}`，不发出任何 HTTP 请求。
 */
export const MFA_METHODS = [
	"status", "seed", "enable", "regenerate", "disable", "purge", "revokeDevice", "revokeAll", "unlock",
	// Stage 5 (2026-09-13): 手机一次性码开关（总开关 otpEnabled + 自动发 autoSend）——
	// 契约 docs/任务记录/2026-09-13-通知中枢Stage5-契约与决策.md §2。纯透传到 auth-proxy 的
	// `/mfa/api/setOtp`（本层不加工形状：响应 {ok,otp:{enabled,autoSend,codes,mfa},changed:{}}）。
	"setOtp"
];

/** 上游超时（契约 §5：8s）。 */
export const PROXY_TIMEOUT_MS = 8000;

/** 令牌文件默认路径（契约 §1.1；env 覆盖仅供测试隔离）。 */
export const DEFAULT_TOKEN_FILE = "/data/dsh/.auth-mfa-admin-token";
/** auth-proxy 默认地址（容器内本机 3080；env 覆盖仅供测试隔离）。 */
export const DEFAULT_PROXY_BASE = "http://127.0.0.1:3080";

/** 进程内日志器（apply 时注入）。 */
let logger = null;
/** 令牌缺失是否已记过一次日志（避免每次调用刷屏；契约 §1.1 同款"只记一次"）。 */
let tokenMissingLogged = false;
/** 令牌 mtime 缓存：{ file, mtimeMs, value } —— mtime 变了才重读。 */
let tokenCache = { file: "", mtimeMs: -1, value: "" };

function tokenFile() {
	return process.env.DSH_AUTH_MFA_TOKEN_FILE || DEFAULT_TOKEN_FILE;
}

function proxyBase() {
	return String(process.env.DSH_AUTH_PROXY_URL || DEFAULT_PROXY_BASE).replace(/\/+$/, "");
}

/** 简述错误：截断 + 打码（绝不把令牌带进日志/响应）。 */
function brief(err, token) {
	let msg = String((err && err.message) || err || "未知错误").replace(/\s+/g, " ").trim();
	if (msg.length > 160) msg = `${msg.slice(0, 160)}…`;
	return scrubText(msg, token);
}

/** 把令牌值从任意字符串里打码（响应体兜底；auth-proxy 本就不该回显令牌）。 */
function scrubText(text, token) {
	const t = String(text ?? "");
	if (!token) return t;
	return t.split(token).join("…");
}

/** 把响应对象里万一出现的令牌值打码（JSON 往返；解析失败则退回原值）。 */
function scrubValue(value, token) {
	if (!token || value === null || value === undefined) return value;
	try {
		const raw = JSON.stringify(value);
		if (raw.indexOf(token) < 0) return value;
		return JSON.parse(raw.split(token).join("…"));
	} catch {
		return value;
	}
}

/**
 * 读本地 IPC 令牌（**只读**；mtime 缓存）。
 * - 文件缺失/不可读/空 ⇒ 返回 ""（调用方转 `{ok:false}`，**不抛错、不创建文件、不改权限**）。
 * @returns {Promise<string>}
 */
export async function readAdminToken() {
	const file = tokenFile();
	let mtimeMs;
	try {
		mtimeMs = (await stat(file)).mtimeMs;
	} catch (e) {
		tokenCache = { file, mtimeMs: -1, value: "" };
		if (!tokenMissingLogged) {
			tokenMissingLogged = true;
			logger?.warn?.(`dsh-auth-mfa: 本地管理令牌不可读 (${file})，设置卡只能只读降级: ${brief(e)}`);
		}
		return "";
	}
	if (tokenCache.file === file && tokenCache.mtimeMs === mtimeMs) return tokenCache.value;
	let value = "";
	try {
		value = String(await readFile(file, "utf8")).trim();
	} catch (e) {
		tokenMissingLogged = true;
		logger?.warn?.(`dsh-auth-mfa: 本地管理令牌读取失败 (${file}): ${brief(e)}`);
		tokenCache = { file, mtimeMs: -1, value: "" };
		return "";
	}
	tokenCache = { file, mtimeMs, value };
	tokenMissingLogged = false;
	// 只记"是否可用 + mtime"，绝不记值（契约 §1.1）
	debug(`token: file=${file} mtimeMs=${mtimeMs} len=${value.length}`);
	if (!value) logger?.warn?.(`dsh-auth-mfa: 本地管理令牌为空 (${file})，需 auth-proxy 生成`);
	return value;
}

/** HTTP 状态 → 用户可读简述（不回上游响应体，避免带入未知敏感内容）。 */
function httpError(status) {
	if (status === 401) return "本地管理令牌被拒绝（HTTP 401）—— 令牌已轮换? 请重试或核对 auth-proxy 日志";
	if (status === 403) return "auth-proxy 拒绝该请求（HTTP 403）";
	if (status === 404) return "auth-proxy 未提供该接口（HTTP 404）—— 镜像可能仍是 MFA 之前版本";
	if (status === 429) return "auth-proxy 限速中（HTTP 429）";
	if (status >= 500) return `auth-proxy 内部错误（HTTP ${status}）`;
	return `auth-proxy 返回 HTTP ${status}`;
}

/**
 * 调 auth-proxy 的 `/mfa/api/<method>`（**任何失败都返回 `{ok:false, error}`，绝不抛**）。
 * @param {string} method 白名单内方法
 * @param {object} [payload] JSON 透传（如 revokeDevice 的 `{id}`、unlock 的 `{scope:'all'|'ip', ip?}`）
 * @returns {Promise<{ok:true, value:any}|{ok:false, error:string}>}
 */
export async function callAuthProxy(method, payload) {
	const m = String(method ?? "");
	if (MFA_METHODS.indexOf(m) < 0) return { ok: false, error: `未知方法 ${m || "(空)"}（仅支持 ${MFA_METHODS.join("|")}）` };
	const token = await readAdminToken();
	if (!token) return { ok: false, error: `本地管理令牌不可用（${tokenFile()}）—— 需 auth-proxy 启动时生成（0600），本插件只读` };
	const body = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
	let resp;
	try {
		resp = await fetch(`${proxyBase()}/mfa/api/${m}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-DSH-MFA-Token": token },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(PROXY_TIMEOUT_MS)
		});
	} catch (e) {
		const kind = String((e && e.name) || "");
		if (kind === "TimeoutError" || kind === "AbortError") return { ok: false, error: `auth-proxy 请求超时（${PROXY_TIMEOUT_MS / 1000}s）` };
		return { ok: false, error: `无法连接 auth-proxy（${proxyBase()}）：${brief(e, token)}` };
	}
	const text = await resp.text().catch(() => "");
	if (!resp.ok) return { ok: false, error: httpError(resp.status) };
	if (!text.trim()) return { ok: true, value: null };
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		return { ok: false, error: "auth-proxy 返回了非 JSON 响应（接口版本不匹配?）" };
	}
	return { ok: true, value: scrubValue(value, token) };
}

/** 组装 /auth-mfa handler（apply 与单测共用，同 /notify-hub、/model-console 先例）。 */
export function createRpcHandler() {
	return async function handle(method, payload) {
		try {
			const res = await callAuthProxy(method, payload);
			if (!res.ok) {
				logger?.warn?.(`dsh-auth-mfa: /auth-mfa RPC ${String(method)} 失败: ${res.error}`);
				debug(`rpc ${String(method)} 失败: ${res.error}`);
			}
			return res;
		} catch (err) {
			// 兜底：调用链上任何未预期异常也不得抛到 RPC 层（契约 §5）
			const msg = brief(err);
			logger?.warn?.(`dsh-auth-mfa: /auth-mfa RPC ${String(method)} 异常: ${msg}`);
			debug(`rpc ${String(method)} 异常: ${msg}`);
			return { ok: false, error: msg };
		}
	};
}

/** 注入 apply 侧上下文（日志器）；单测可直接设 env 后调 callAuthProxy。 */
export function configure({ log } = {}) {
	if (log) logger = log;
}

const DEBUG_LOG = "/workspace/log/auth-mfa/auth-mfa-debug.log";
try { mkdirSync("/workspace/log/auth-mfa", { recursive: true }); } catch { /* ignore */ }
/** debug 落盘失败绝不影响功能（同 dsh-notify 写法；只记方法名/状态，绝不记令牌值）。 */
function debug(msg) {
	try { appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch { /* ignore */ }
}

export async function apply(ctx) {
	logger = ctx?.logger ?? null;
	// /auth-mfa RPC 通道（已认证 = dsh 既有登录会话 RPC 面；不新增免登录端点）。
	// 第三参 `{}` 必传，否则 register 读 options.authority 会 TypeError（速查 §2.5 已记录）。
	try {
		ctx.get?.("connection")?.rpc?.handle?.(CHANNEL, createRpcHandler(), {});
		debug(`apply: ${CHANNEL} RPC 已注册 (methods=${MFA_METHODS.length}, proxy=${proxyBase()}, tokenFile=${tokenFile()})`);
	} catch (e) {
		ctx?.logger?.warn?.(`dsh-auth-mfa: ${CHANNEL} RPC 注册失败: ${brief(e)}`);
		debug(`apply: RPC 注册失败: ${brief(e)}`);
	}
}
