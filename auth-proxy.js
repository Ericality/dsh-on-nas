#!/usr/bin/env node
// ============================================================
// 轻量登录认证反代 (零依赖, 纯 Node 标准库)
//
//   对外双端口 (登录页 + 会话)  ->  127.0.0.1:3081 (dsh web)
//     :3080  HTTP   给 Cloudflare Tunnel 回源 / SSH 隧道 / localhost
//     :8443  HTTPS  给局域网直连 (自签名证书, 浏览器首次访问点一次信任)
//
// 特性:
//   - 前端登录页面 (替代浏览器 basic auth 弹窗)
//   - HttpOnly + SameSite 签名会话 Cookie (HMAC, 无状态, 默认 7 天)
//   - 改写 Host/Origin 通过 dsh 的 /api 浏览器信任围栏
//   - 防爆破 (2026-09-12 Stage 2 升级为多档): 同一 IP 累计失败 3 次锁 5min / 6 次锁 1h / 9 次锁 24h /
//     12 次永久 (删 /data/dsh/auth-lock.json 解除, 含永久锁); 全站闸 20 次失败/1h 锁全站 1h
//     (隧道场景用 Cf-Connecting-Ip 按真实 IP)
//   - 登录页智能提示: 明文 HTTP 且非 localhost 且非隧道访问时, 提示改用 HTTPS
//   - 未设置 DSH_AUTH_USERNAME/PASSWORD 时: 纯转发模式 (无认证, 仅限可信局域网)
//   - (2026-09-11) dsh 浏览器会话 cookie 自动换取 + 上游注入: dsh >= 0.1.2 要求浏览器先
//     GET /?token=<launch token> 换 dsh-auth-* cookie, 而 token 只在容器内 (本地插件
//     dsh-remote-settings 写入 /data/dsh/.dsh-launch-token) → 这里在容器内完成交换并注入,
//     用户只需输一次登录页密码, 不必再上控制台/日志取 token; 失败时退回旧行为 (401 透传)
//   - (2026-09-11) 访问审计日志: 登录成功/失败/锁定/登出 + 真实 IP + UA 摘要 →
//     /workspace/log/auth-proxy/access-YYYYMMDD.log (默认保留 30 天), 绝不记录密码/token/cookie 值
// ============================================================
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');

// TLS (自签名): DSH_TLS=1 且证书存在时额外监听 HTTPS 端口
const TLS_CERT = process.env.DSH_TLS_CERT || '/etc/dsh-tls/cert.pem';
const TLS_KEY = process.env.DSH_TLS_KEY || '/etc/dsh-tls/key.pem';
const useTls = process.env.DSH_TLS === '1' && fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY);

const HTTP_PORT = parseInt(process.env.DSH_HTTP_PORT || '3080', 10);
const HTTPS_PORT = parseInt(process.env.DSH_HTTPS_PORT || '8443', 10);
const LISTEN_HOST = process.env.DSH_LISTEN_HOST || '0.0.0.0';
const UPSTREAM = process.env.DSH_UPSTREAM || 'http://127.0.0.1:3081';
const USER = process.env.DSH_AUTH_USERNAME || '';
const PASS = process.env.DSH_AUTH_PASSWORD || '';
const COOKIE_NAME = 'dsh_session';
const SESSION_DAYS = parseInt(process.env.DSH_SESSION_DAYS || '7', 10);
const BODY_LIMIT = 64 * 1024; // 登录请求体上限

// ---------- 安全内核常量 (2026-09-12, Stage 2) ----------
// 回滚开关 (务必最先理解): 种子文件 `TOTP_FILE` 不存在, 或其中 enabled !== true ⇒ **MFA 完全不启用**,
// 登录流程/页面与"加 MFA 之前"逐字一致 (只输密码即登录)。绝不半途锁死。
const TOTP_FILE = process.env.DSH_AUTH_TOTP_FILE || '/data/dsh/.auth-totp.json';
const DEVICES_FILE = process.env.DSH_AUTH_DEVICES_FILE || '/data/dsh/auth-devices.json';
const LOCK_FILE = process.env.DSH_AUTH_LOCK_FILE || '/data/dsh/auth-lock.json';
const NOTIFY_HUB_FILE = process.env.DSH_NOTIFY_HUB_FILE || '/data/dsh/notify-hub.json';
const DEVICE_COOKIE = 'dsh_device';     // 设备信任 (过 TOTP 后签发, 90 天)
const PREAUTH_COOKIE = 'dsh_preauth';   // 密码已通过 → 待输验证码 (5 分钟)
// Stage 3 (2026-09-12) 新增: 本地 IPC 令牌 (供同容器内的插件 dsh-auth-mfa 调管理 API) + 二维码库
const MFA_TOKEN_FILE = process.env.DSH_AUTH_MFA_TOKEN_FILE || '/data/dsh/.auth-mfa-admin-token';
const QR_LIB = process.env.DSH_QR_LIB || '/data/dsh/vendor/qrcode-generator.js';
const DEVICE_DAYS = parseInt(process.env.DSH_AUTH_DEVICE_DAYS || '90', 10);
const PREAUTH_MS = 5 * 60 * 1000;
// ---------- 登录一次性码 (2026-09-12, Stage 4: 「发到手机」) ----------
// 回滚开关 (同 TOTP 风格): OTP_FILE 不存在, 或其中 `otpEnabled !== true` ⇒ **OTP 完全关闭**
// (登录页不渲染发码按钮, `/login?step=code&action=send-otp` 返回 403 otp_disabled, 且**不创建该文件**)。
// 运行期回滚: 把 otpEnabled 置 false 或删掉文件 ⇒ 下一请求即生效, 无需重启。
// 契约: docs/任务记录/2026-09-12-通知中枢Stage4-契约与决策.md §1–§6 (唯一来源)
const OTP_FILE = process.env.DSH_AUTH_OTP_FILE || '/data/dsh/.auth-otp.json';
const OTP_TTL_MS = parseInt(process.env.DSH_AUTH_OTP_TTL_MS || String(PREAUTH_MS), 10);
const OTP_MAX_TRIES = parseInt(process.env.DSH_AUTH_OTP_MAX_TRIES || '5', 10);
const OTP_COOLDOWN_MS = parseInt(process.env.DSH_AUTH_OTP_COOLDOWN_MS || '60000', 10);
const OTP_WINDOW_MS = parseInt(process.env.DSH_AUTH_OTP_WINDOW_MS || '300000', 10);
const OTP_MAX_SENDS = parseInt(process.env.DSH_AUTH_OTP_MAX_SENDS || '3', 10);
const OTP_TIMEOUT_MS = parseInt(process.env.DSH_AUTH_OTP_TIMEOUT_MS || '12000', 10);
const OTP_ICON_URL = process.env.DSH_NOTIFY_ICON_URL || 'https://harness.ericality.com/dsh-icon-512.png';
// 单 IP 累计失败档位 (用户要求"从 3 次开始、要狠"): 跨重启/跨锁期累加, 只在**跨档**时上锁
const LOCK_TIERS = [
  { at: 3, ms: 5 * 60 * 1000, label: '5 分钟' },
  { at: 6, ms: 60 * 60 * 1000, label: '1 小时' },
  { at: 9, ms: 24 * 60 * 60 * 1000, label: '24 小时' },
  { at: 12, ms: 0, label: '永久' },
];
const GLOBAL_WINDOW_MS = 60 * 60 * 1000;   // 全站闸统计窗口
const GLOBAL_MAX_FAILS = 20;               // 窗口内失败数阈值
const GLOBAL_LOCK_MS = 60 * 60 * 1000;     // 全站锁定时长
// 告警超时: 默认 **10s**（与 dsh-notify 的 SEND_TIMEOUT_MS 对齐；可用 DSH_AUTH_ALERT_TIMEOUT_MS 覆盖）
// ⚠ 2026-09-12 生产实测: 容器内到 https://api.day.app/ 单次请求就要 ~4.2s ⇒ 原定的 3s 会把告警**静默掐断**
//   （审计 `ALERT_FAIL error="timeout"`，用户收不到）。告警是 fire-and-forget，加长超时**不影响登录延迟**。
const ALERT_TIMEOUT_MS = parseInt(process.env.DSH_AUTH_ALERT_TIMEOUT_MS || '10000', 10);

// ---------- 审计日志 (2026-09-11, 入侵回溯用) ----------
// 此前 auth-proxy 无任何访问审计 (2026-09-10 泄漏调查缺口之一)。只记事件/用户名/IP/UA 摘要,
// **严禁**写入密码、dsh token、任何 cookie 值。
const AUDIT_DIR = process.env.DSH_AUTH_AUDIT_DIR || '/workspace/log/auth-proxy';
const AUDIT_KEEP_DAYS = parseInt(process.env.DSH_AUTH_AUDIT_KEEP_DAYS || '30', 10);
function auditStamp() {
  // 固定北京时间 (+08:00), 不依赖容器 TZ (容器为 UTC)
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('Z', '+08:00').replace('T', ' ');
}
function auditDay() { return auditStamp().slice(0, 10).replace(/-/g, ''); }
let auditPrunedDay = '';
function auditPrune() {
  const day = auditDay();
  if (auditPrunedDay === day) return;
  auditPrunedDay = day;
  try {
    const cutoff = Date.now() - AUDIT_KEEP_DAYS * 86400 * 1000;
    for (const f of fs.readdirSync(AUDIT_DIR)) {
      const m = /^access-(\d{4})(\d{2})(\d{2})\.log$/.exec(f);
      if (!m) continue;
      const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00+08:00`);
      if (Number.isFinite(t) && t < cutoff) fs.unlinkSync(`${AUDIT_DIR}/${f}`);
    }
  } catch { /* 目录不存在/不可写 → 忽略, 不影响代理 */ }
}
function audit(event, fields) {
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true, mode: 0o700 });
    auditPrune();
    const parts = [auditStamp(), event];
    for (const [k, v] of Object.entries(fields || {})) {
      if (v === undefined || v === null || v === '') continue;
      parts.push(`${k}=${JSON.stringify(String(v).slice(0, 200))}`);
    }
    fs.appendFileSync(`${AUDIT_DIR}/access-${auditDay()}.log`, `${parts.join(' ')}\n`, { mode: 0o600 });
  } catch (e) {
    console.error('[auth] 审计日志写入失败:', e.message);
  }
}
function uaSummary(req) {
  const ua = String(req.headers['user-agent'] || '');
  const m = /(iPhone|iPad|Android|Windows|Macintosh|Linux|curl|okhttp|python|Wget)/i.exec(ua);
  return m ? m[1] : (ua.slice(0, 40) || 'unknown');
}

// ---------- dsh 浏览器会话 cookie: 容器内自动交换 + 上游注入 (2026-09-11) ----------
// 背景: dsh >= 0.1.2 的 client-connection 引入浏览器会话认证 —— 浏览器必须先
// `GET /?token=<进程 launch token>` 换出 dsh-auth-<authority> 签名 cookie, 否则 / 与 /api
// 一律 401; 而 launch token 只存在于容器内 (由本地插件 dsh-remote-settings 经公开 API
// ctx.connection.authenticatedUrl 写入 TOKEN_FILE), 外部 (隧道/手机/另一台电脑) 无从获知。
// 做法: 代理在容器内用该 token 完成交换, 并把 cookie 注入转发给 dsh 的请求 (含 WebSocket 升级)。
// 效果: 用户只需输一次登录页密码; token 与 dsh cookie 都不进浏览器 / 不进 URL / 不进日志。
// 兜底: 读不到 token 或交换失败 → 不注入, 保持旧行为 (dsh 401 原样透传), 不会锁死。
const TOKEN_FILE = process.env.DSH_LAUNCH_TOKEN_FILE || '/data/dsh/.dsh-launch-token';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
const DSH_COOKIE_TTL_MS = parseInt(process.env.DSH_COOKIE_TTL_MS || String(6 * 3600 * 1000), 10);
const DSH_COOKIE_FAIL_BACKOFF_MS = 30 * 1000;
let dshCookie = null;        // "dsh-auth-xxxx=yyyy" (仅 name=value, 不含属性)
let dshCookieAt = 0;
let dshCookieFailedAt = 0;
let dshCookieInflight = null;

function readLaunchToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    return TOKEN_PATTERN.test(t) ? t : null;
  } catch { return null; }
}

function exchangeDshCookie(token) {
  return new Promise((resolve, reject) => {
    const u = new URL(UPSTREAM);
    const preq = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      method: 'GET',
      path: `/?token=${encodeURIComponent(token)}`,
      headers: { host: u.host, origin: u.origin, 'user-agent': 'dsh-auth-proxy/session-bridge' },
      timeout: 5000,
    }, (pres) => {
      const raw = pres.headers['set-cookie'] || [];
      pres.resume();
      const pair = raw.map((c) => String(c).split(';')[0].trim())
        .find((c) => c.startsWith('dsh-auth-') && c.includes('='));
      if (pair === undefined) { reject(new Error(`交换未返回 dsh-auth-* cookie (HTTP ${String(pres.statusCode)})`)); return; }
      resolve(pair);
    });
    preq.on('timeout', () => preq.destroy(new Error('交换超时')));
    preq.on('error', reject);
    preq.end();
  });
}

// force=true: 忽略缓存与退避 (上游 401 自愈时用)
function ensureDshCookie(force) {
  const now = Date.now();
  if (force !== true) {
    if (dshCookie !== null && now - dshCookieAt < DSH_COOKIE_TTL_MS) return Promise.resolve(dshCookie);
    if (dshCookie === null && now - dshCookieFailedAt < DSH_COOKIE_FAIL_BACKOFF_MS) return Promise.resolve(null);
  }
  if (dshCookieInflight !== null) return dshCookieInflight;
  const token = readLaunchToken();
  if (token === null) {
    // ⚠ 这里**不能**缓存 inflight: 代理可能先于插件启动 (首次读不到 token), 必须让下一次调用
    // 立刻重读文件, 否则会永久停在一次失败结果上再也换不到 cookie (2026-09-11 VM 实测踩到)。
    dshCookieFailedAt = Date.now();
    if (dshCookie === null) {
      console.error(`[auth] 未读到 dsh launch token (${TOKEN_FILE}) → 暂不注入会话 cookie; `
        + '手动兜底: 用 dsh web 打印的带 ?token= 的 URL 打开一次即可登录');
    }
    return Promise.resolve(dshCookie);
  }
  // 用 .then/.finally 收尾而不是 async IIFE: async 函数体若同步走完, 其内部 finally 会先于
  // 外层 `dshCookieInflight = …` 赋值执行, 清空标志失效 → 后续调用读到陈旧 promise。
  const task = exchangeDshCookie(token).then((pair) => {
    dshCookie = pair;
    dshCookieAt = Date.now();
    dshCookieFailedAt = 0;
    console.log('[auth] 已自动换取 dsh 浏览器会话 cookie (用户无需控制台 token)');
    audit('DSH_SESSION_REFRESH', { ok: 'true' });
    return dshCookie;
  }, (e) => {
    dshCookieFailedAt = Date.now();
    console.error('[auth] 自动换取 dsh 会话 cookie 失败:', e.message);
    audit('DSH_SESSION_REFRESH', { ok: 'false', error: e.message });
    return dshCookie;
  }).finally(() => {
    dshCookieInflight = null;
  });
  dshCookieInflight = task;
  return task;
}

// 注入上游: 保留浏览器其它 cookie, 只替换 dsh-auth-* (旧值可能已过期)
function injectDshCookie(headers) {
  if (dshCookie === null) return false;
  const name = dshCookie.slice(0, dshCookie.indexOf('='));
  const kept = String(headers.cookie || '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s !== '' && !s.startsWith(`${name}=`));
  kept.push(dshCookie);
  headers.cookie = kept.join('; ');
  return true;
}

// ---------- 会话签名密钥 (持久化) ----------
// 2026-08-30 修复: 原实现每次进程启动随机生成密钥 → 容器一重启(崩溃自动拉起/部署优雅重启)
// 所有已签发 Cookie 验签全失败, 所有用户被迫重新登录。改为持久化密钥文件:
//   优先级: 环境变量 DSH_AUTH_SECRET > 密钥文件 /data/dsh/.auth-secret (首次生成, chmod 600) > 内存随机兜底。
const SECRET_FILE = process.env.DSH_AUTH_SECRET_FILE || '/data/dsh/.auth-secret';
function loadOrCreateSecret() {
  if (process.env.DSH_AUTH_SECRET) return process.env.DSH_AUTH_SECRET;
  try {
    if (fs.existsSync(SECRET_FILE)) {
      const s = fs.readFileSync(SECRET_FILE, 'utf8').trim();
      if (s.length >= 32) return s;
    }
    const s = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
    return s;
  } catch (e) {
    // 无法读写密钥文件 (只读环境等) 时退回内存随机: 功能可用但重启后会掉登录
    console.error('[auth] 无法持久化会话密钥 (回退内存随机, 重启后将要求重新登录):', e.message);
    return crypto.randomBytes(32).toString('hex');
  }
}
const secret = loadOrCreateSecret();
const authOn = USER !== '' && PASS !== '';

// ---------- 会话 ----------
// 注意: Cookie 不加 Secure —— 双端口共用同一会话 (HTTPS 登录后切 HTTP 端口仍有效)
function sign(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}
function verify(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  const expect = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (typeof p.exp !== 'number' || p.exp < Date.now()) return null;
    return p;
  } catch { return null; }
}
// 通用 cookie 取值 (2026-09-12: 新增 dsh_device / dsh_preauth 后抽出)
function cookieValue(req, name) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : null;
}
function readNamedCookie(req, name) {
  const v = cookieValue(req, name);
  return v === null ? null : verify(v);
}
function readCookie(req) {
  const v = cookieValue(req, COOKIE_NAME);
  return v === null ? null : verify(v);
}
function sessionCookie(token) {
  // SameSite=Lax: 顶层导航(书签/外部链接/切回标签)会带 Cookie, 跨站子请求仍拦截
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}
function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// ---------- 登录校验 (常数时间比较) ----------
function checkCreds(u, p) {
  const hu = crypto.createHash('sha256').update(u).digest();
  const hp = crypto.createHash('sha256').update(p).digest();
  const eu = crypto.createHash('sha256').update(USER).digest();
  const ep = crypto.createHash('sha256').update(PASS).digest();
  return crypto.timingSafeEqual(hu, eu) && crypto.timingSafeEqual(hp, ep);
}

// ---------- 调试开关 ----------
// 多档限速/全站闸状态机在「安全内核」段 (recordFail / lockStatus / clearFails, 已落盘持久化)
const DEBUG = process.env.DSH_AUTH_DEBUG === '1';
function dlog(...a) { if (DEBUG) console.log('[auth]', ...a); }

// ============================================================
// 安全内核 (2026-09-12, Stage 2): TOTP 二次验证 / 设备信任 / 恢复码 / 多档限速 / 告警
// ------------------------------------------------------------
// 设计原则:
//   1. **回滚开关**: TOTP_FILE 不存在 (或 enabled !== true) ⇒ MFA 完全不启用, 行为与加 MFA 之前一致;
//   2. 任何安全内核路径的异常都不得影响登录 (全部 try/catch + 审计); 告警 fire-and-forget;
//   3. 锁定只惩罚"未可信设备的登录尝试", 已登录会话与已信任设备不受影响 (防永久锁把自己锁在门外);
//   4. 审计禁写密码/验证码/恢复码/种子/任何 cookie 值。
// 契约文档: /workspace/docs/任务记录/2026-09-12-通知中枢Stage2-契约与决策.md
// ============================================================

// ---------- 状态文件读写 (0600, 原子写) ----------
function statSafe(file) { try { return fs.statSync(file); } catch { return null; } }
function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function writeJsonFile(file, obj) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* 文件系统不支持则忽略 */ }
}
function tighten(file) {
  try { if ((fs.statSync(file).mode & 0o777) !== 0o600) fs.chmodSync(file, 0o600); } catch { /* ignore */ }
}

// ---------- MFA 配置 (TOTP 种子 + 恢复码 + 设备 epoch) ----------
let mfaCfg = null;
let mfaMtime = -1;
let mfaStamp = '';   // `启用:种子前8位:设备epoch` 指纹 → 变化即告警 auth.mfa_changed
// 原始 JSON → 归一化内存态 (loadMfa 与 Stage 3 的管理写盘共用, 保证两条路径得到同一形状)
function mfaCfgFromRaw(raw) {
  const cfg = {
    enabled: raw.enabled === true,
    secret: typeof raw.secret === 'string' ? raw.secret.toUpperCase().replace(/[^A-Z2-7]/g, '') : '',
    digits: raw.digits === 8 ? 8 : 6,
    period: Number.isFinite(raw.period) && raw.period >= 10 ? Math.floor(raw.period) : 30,
    deviceEpoch: Number.isFinite(raw.deviceEpoch) ? Math.floor(raw.deviceEpoch) : 1,
    recoveryCodes: Array.isArray(raw.recoveryCodes) ? raw.recoveryCodes : [],
    // 最近用过的 TOTP 时间窗 (跨重启防重放; 无该字段 = 从未用过)
    usedCounters: Array.isArray(raw.usedTotpCounters) ? raw.usedTotpCounters.filter((n) => Number.isFinite(n)) : [],
  };
  if (cfg.secret.length < 16) cfg.enabled = false;   // 种子无效 ⇒ 等同未启用 (绝不半途锁死)
  return cfg;
}
// Stage 3: 管理动作写盘后**同步刷新内存缓存**——否则下一次 loadMfa() 会因 mtime/stamp 变化
// 再发一条 auth.mfa_changed (重复告警), 或读到旧缓存。
function refreshMfaCache(raw) {
  writeJsonFile(TOTP_FILE, raw);
  const cfg = mfaCfgFromRaw(raw);
  mfaCfg = cfg;
  mfaMtime = statSafe(TOTP_FILE)?.mtimeMs ?? -1;
  mfaStamp = `${cfg.enabled ? 1 : 0}:${cfg.secret.slice(0, 8)}:${cfg.deviceEpoch}`;
  return cfg;
}
function mfaCacheOff() {   // 种子文件被删/停用后同步内存态 (避免 loadMfa 再发一条"已停用"告警)
  mfaCfg = null; mfaMtime = -1; mfaStamp = 'off';
}
function loadMfa() {
  const st = statSafe(TOTP_FILE);
  if (st === null) {
    // 种子文件不存在/被删 = MFA 停用: 若此前是启用态, 这次要告警 (启用↔停用都要留痕)
    if (mfaStamp !== '' && mfaStamp !== 'off') {
      audit('MFA_CHANGED', { enabled: 'false', reason: 'totp-file-removed' });
      sendAuthAlert('auth.mfa_changed', '🔐 MFA 已停用',
        `种子文件 ${TOTP_FILE} 不存在 ⇒ 二次验证已停用, 登录回到"仅密码" · ${auditStamp()}`);
    }
    mfaCfg = null; mfaMtime = -1; mfaStamp = 'off'; return null;
  }
  // ⚠ tighten 必须在缓存短路**之前**: chmod 只改 ctime 不改 mtime,
  //   否则运行期被放宽权限(误操作/攻击者)就永不收紧 (2026-09-12 VM 套件实测暴露)。
  tighten(TOTP_FILE);
  if (mfaCfg !== null && st.mtimeMs === mfaMtime) return mfaCfg;
  const raw = readJsonFile(TOTP_FILE);
  if (raw === null || typeof raw !== 'object') {
    console.error(`[auth] MFA 配置解析失败 (${TOTP_FILE}) → 按未启用的安全降级处理`);
    mfaCfg = null; mfaMtime = st.mtimeMs; return null;
  }
  const cfg = mfaCfgFromRaw(raw);
  for (const c of cfg.usedCounters) if (!usedTotp.has(String(c))) usedTotp.set(String(c), Date.now());
  mfaCfg = cfg; mfaMtime = st.mtimeMs;
  const stamp = `${cfg.enabled ? 1 : 0}:${cfg.secret.slice(0, 8)}:${cfg.deviceEpoch}`;
  if (mfaStamp !== '' && stamp !== mfaStamp) {
    audit('MFA_CHANGED', { enabled: String(cfg.enabled), epoch: String(cfg.deviceEpoch) });
    sendAuthAlert('auth.mfa_changed', '🔐 MFA 配置变更',
      `二次验证已${cfg.enabled ? '启用' : '停用'} (设备 epoch=${cfg.deviceEpoch}) · ${auditStamp()}`);
  }
  mfaStamp = stamp;
  return cfg;
}
function mfaOn() { const c = loadMfa(); return c !== null && c.enabled; }

// ---------- TOTP (RFC 6238 / SHA1 / 6 位 / 30s / 允许 ±1 窗口 / 防重放) ----------
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(s) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of String(s).toUpperCase()) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
function totpCode(secretBuf, counter, digits) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac('sha1', secretBuf).update(buf).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}
function safeEqualStr(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
const usedTotp = new Map();   // counter -> 首次使用时间 (同一时间窗内的码不可重放)
function verifyTotp(cfg, code) {
  const clean = String(code || '').replace(/[\s-]/g, '');
  if (!/^\d{6,8}$/.test(clean)) return false;
  const secretBuf = base32Decode(cfg.secret);
  const counter = Math.floor(Date.now() / 1000 / cfg.period);
  for (const off of [0, -1, 1]) {          // ±1 窗口 (时钟漂移容忍)
    const c = counter + off;
    if (c < 0) continue;
    if (!safeEqualStr(totpCode(secretBuf, c, cfg.digits), clean)) continue;
    const key = String(c);
    if (usedTotp.has(key)) return false;    // 重放拒绝: 同一窗口用过的码不再接受
    usedTotp.set(key, Date.now());
    for (const [k, t] of usedTotp) if (Date.now() - t > 5 * 60 * 1000) usedTotp.delete(k);
    // 跨重启防重放: 把"最近用过的窗口"落盘 (best-effort, 失败只影响跨重启防重放, 不影响本次放行)
    try {
      const raw = readJsonFile(TOTP_FILE);
      if (raw !== null && typeof raw === 'object') {
        const prev = Array.isArray(raw.usedTotpCounters) ? raw.usedTotpCounters.filter((n) => Number.isFinite(n)) : [];
        const next = [...new Set([...prev, c])].slice(-8);
        raw.usedTotpCounters = next;
        raw.updatedAt = Date.now();
        writeJsonFile(TOTP_FILE, raw);
        cfg.usedCounters = next;
      }
    } catch (e) { console.error('[auth] TOTP 使用窗口落盘失败:', e.message); }
    return true;
  }
  return false;
}

// ---------- 恢复码 (8 个, 一次性, 哈希存盘) ----------
// Crockford base32 字符集 (去掉易混淆的 I/L/O/U); 校验前统一归一化 ⇒ 用户输错大小写/漏横线也能用
const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function normalizeRecovery(s) {
  return String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}
function hashRecovery(salt, code) {
  return crypto.createHash('sha256').update(`${salt}${code}`).digest('hex');
}
function verifyRecovery(cfg, code) {
  const norm = normalizeRecovery(code);
  if (norm.length < 6) return false;
  let hit = -1;
  cfg.recoveryCodes.forEach((rc, i) => {
    if (hit !== -1 || rc === null || typeof rc !== 'object' || rc.usedAt) return;
    const h = String(rc.hash || '');
    if (h === '') return;
    if (safeEqualStr(h, hashRecovery(String(rc.salt || ''), norm))) hit = i;
  });
  if (hit === -1) return false;
  try {   // 用掉即作废: 回写文件 (失败也让本次放行, 只是该码可能被再用一次)
    const raw = readJsonFile(TOTP_FILE);
    if (raw !== null && Array.isArray(raw.recoveryCodes) && raw.recoveryCodes[hit]) {
      raw.recoveryCodes[hit].usedAt = Date.now();
      raw.updatedAt = Date.now();
      writeJsonFile(TOTP_FILE, raw);
    }
  } catch (e) { console.error('[auth] 恢复码作废写盘失败:', e.message); }
  cfg.recoveryCodes[hit].usedAt = Date.now();
  return true;
}
// 返回 'totp' | 'recovery' | null
function verifyMfaCode(cfg, code) {
  try {
    if (verifyTotp(cfg, code)) return 'totp';
    if (verifyRecovery(cfg, code)) return 'recovery';
  } catch (e) { console.error('[auth] 验证码校验异常:', e.message); }
  return null;
}

// ---------- 设备信任登记表 ----------
let devCache = null;
let devMtime = -1;
function loadDevices() {
  const st = statSafe(DEVICES_FILE);
  if (st === null) { devCache = { devices: {} }; devMtime = -1; return devCache; }
  tighten(DEVICES_FILE);   // 同 loadMfa: 收紧必须在缓存短路之前
  if (devCache !== null && st.mtimeMs === devMtime) return devCache;
  const raw = readJsonFile(DEVICES_FILE);
  const devices = (raw !== null && typeof raw === 'object' && raw.devices !== null
    && typeof raw.devices === 'object') ? raw.devices : {};
  devCache = { devices };
  devMtime = st.mtimeMs;
  return devCache;
}
function saveDevices() {
  try {
    // ⚠ 必须用内存态直接落盘: 若在这里调 loadDevices(), 文件尚不存在时它会**重置缓存**,
    //   把刚登记的设备丢掉 (首次登记必丢 — 2026-09-12 冒烟实测踩到)。
    const cur = devCache !== null ? devCache : loadDevices();
    writeJsonFile(DEVICES_FILE, { version: 1, devices: cur.devices });
    devMtime = statSafe(DEVICES_FILE)?.mtimeMs ?? -1;
  } catch (e) { console.error('[auth] 设备表写盘失败:', e.message); }
}
// 可信判定三条件: 签名有效 → epoch 匹配 → 设备表存在且未吊销 (任一不满足即不可信)
function deviceTrusted(req, cfg) {
  const token = cookieValue(req, DEVICE_COOKIE);
  if (token === null) return null;
  const p = verify(token);
  if (p === null || p.t !== 'dev' || typeof p.d !== 'string') return null;
  if (p.e !== cfg.deviceEpoch) { audit('DEVICE_TRUST_REJECT', { reason: 'epoch' }); return null; }
  const rec = loadDevices().devices[p.d];
  if (rec === undefined || rec.revokedAt) {
    audit('DEVICE_TRUST_REJECT', { reason: rec === undefined ? 'unknown' : 'revoked' });
    return null;
  }
  return { id: p.d, rec };
}
function registerDevice(req, ip) {
  const id = crypto.randomBytes(8).toString('hex');
  const devices = loadDevices().devices;
  const name = `${uaSummary(req)} · ${ip}`;
  devices[id] = {
    name, ua: uaSummary(req), ip,
    createdAt: Date.now(), lastSeenAt: Date.now(), revokedAt: null,
  };
  saveDevices();
  return { id, name };
}
function deviceCookieHeader(id, epoch) {
  const token = sign({ t: 'dev', d: id, e: epoch, exp: Date.now() + DEVICE_DAYS * 86400 * 1000 });
  return `${DEVICE_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DEVICE_DAYS * 86400}`;
}
function preauthCookieHeader(ip) {
  const token = sign({ t: 'pre', ip, exp: Date.now() + PREAUTH_MS });
  return `${PREAUTH_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(PREAUTH_MS / 1000)}`;
}
function clearNamedCookie(name) {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
// 预认证 cookie: 密码已通过 → 只允许"同一 IP 在 5 分钟内"提交验证码
function preauthOk(req, ip) {
  const token = cookieValue(req, PREAUTH_COOKIE);
  if (token === null) return false;
  const p = verify(token);
  return p !== null && p.t === 'pre' && p.ip === ip;
}

// ---------- 多档限速 + 全站闸 (状态持久化, 删 LOCK_FILE 立即解除含永久锁) ----------
let lockState = null;
let lockMtime = -1;
function emptyLocks() { return { version: 1, ips: {}, global: { fails: [], lockUntil: 0 } }; }
function loadLocks() {
  const st = statSafe(LOCK_FILE);
  if (st === null) {
    // ⚠ 运维解除通道: NAS 删掉该文件 ⇒ 内存态立即清空 (永久锁/全站闸一并解除)
    if (lockState !== null && Object.keys(lockState.ips).length > 0) {
      audit('AUTH_UNLOCKED', { reason: 'lock-file-removed' });
    }
    lockState = emptyLocks(); lockMtime = -1; return lockState;
  }
  tighten(LOCK_FILE);   // 同 loadMfa: 收紧必须在缓存短路之前
  if (lockState !== null && st.mtimeMs === lockMtime) return lockState;
  const raw = readJsonFile(LOCK_FILE);
  if (raw === null || typeof raw !== 'object') { lockState = emptyLocks(); lockMtime = st.mtimeMs; return lockState; }
  const ips = (raw.ips !== null && typeof raw.ips === 'object') ? raw.ips : {};
  const g = (raw.global !== null && typeof raw.global === 'object') ? raw.global : {};
  lockState = {
    version: 1,
    ips,
    global: {
      fails: Array.isArray(g.fails) ? g.fails.filter((t) => Number.isFinite(t)) : [],
      lockUntil: Number.isFinite(g.lockUntil) ? g.lockUntil : 0,
    },
  };
  lockMtime = st.mtimeMs;
  return lockState;
}
function saveLocks() {
  try {
    // ⚠ 同 saveDevices: 必须落内存态本身 (调 loadLocks() 会在"文件尚不存在"时重置状态,
    //   把本次刚累加的失败次数吞掉 — 首个失败必丢, 2026-09-12 冒烟实测踩到)。
    const cur = lockState !== null ? lockState : loadLocks();
    writeJsonFile(LOCK_FILE, cur);
    lockMtime = statSafe(LOCK_FILE)?.mtimeMs ?? -1;
  } catch (e) { console.error('[auth] 锁定状态写盘失败:', e.message); }
}
function tierLabel(level) {
  const t = LOCK_TIERS[level - 1];
  return t === undefined ? '未知' : t.label;
}
// 当前锁定状态 (IP 优先, 其次全站); 顺带惰性处理"锁定期满 → 解除告警"
function lockStatus(ip, now) {
  const s = loadLocks();
  const rec = s.ips[ip];
  let out = null;
  if (rec !== undefined) {
    if (rec.permanent === true) out = { scope: 'ip', level: 4, permanent: true, until: 0, ms: 0, label: '永久' };
    else if (rec.lockUntil > now) out = { scope: 'ip', level: rec.level || 0, permanent: false, until: rec.lockUntil, ms: rec.lockUntil - now, label: tierLabel(rec.level) };
    else if (rec.level > 0 && rec.unlockNotified !== true) {
      rec.unlockNotified = true;
      saveLocks();
      audit('AUTH_UNLOCKED', { ip, level: String(rec.level) });
      sendAuthAlert('auth.unlocked', '🔓 锁定已解除',
        `IP ${ip} 的临时锁定已到期 (原档位 ${tierLabel(rec.level)}, 累计失败 ${rec.fails} 次) · ${auditStamp()}`);
    }
  }
  if (out !== null) return out;
  if (s.global.lockUntil > now) return { scope: 'global', level: 0, permanent: false, until: s.global.lockUntil, ms: s.global.lockUntil - now, label: '全站闸 1 小时' };
  return null;
}
// 记一次失败: 跨档升级即上锁 + 告警; 全站窗口达阈值即全站锁
function recordFail(ip, reason) {
  const now = Date.now();
  const s = loadLocks();
  const rec = s.ips[ip] || { fails: 0, level: 0, lockUntil: 0, permanent: false, unlockNotified: true, updatedAt: 0 };
  rec.fails += 1;
  rec.updatedAt = now;
  let tier = 0;
  for (let i = 0; i < LOCK_TIERS.length; i += 1) if (rec.fails >= LOCK_TIERS[i].at) tier = i + 1;
  let escalated = null;
  if (tier > (rec.level || 0)) {
    const t = LOCK_TIERS[tier - 1];
    rec.level = tier;
    rec.permanent = t.ms === 0;
    rec.lockUntil = t.ms === 0 ? 0 : now + t.ms;
    rec.unlockNotified = false;
    escalated = { level: tier, label: t.label, permanent: rec.permanent, until: rec.lockUntil };
  }
  // 注意: 同一档位内**不重复上锁** —— 只有跨过 3/6/9/12 才锁 (第 4-5 次失败不再锁, 第 6 次锁 1h);
  // 锁定期内的尝试在 handler 里被直接拒收 (未验凭据 ⇒ 不算失败、不累加), 属于有意行为。
  s.ips[ip] = rec;
  // 全站闸: 最近 1h 失败时间戳
  s.global.fails = s.global.fails.filter((t) => now - t < GLOBAL_WINDOW_MS);
  s.global.fails.push(now);
  if (s.global.fails.length > 500) s.global.fails = s.global.fails.slice(-500);
  let gEscalated = null;
  if (s.global.fails.length >= GLOBAL_MAX_FAILS && !(s.global.lockUntil > now)) {
    s.global.lockUntil = now + GLOBAL_LOCK_MS;
    s.global.fails = [];
    gEscalated = { until: s.global.lockUntil };
  }
  saveLocks();
  if (escalated !== null) {
    audit('AUTH_LOCKED', { ip, level: String(escalated.level), permanent: String(escalated.permanent), until: String(escalated.until) });
    sendAuthAlert('auth.locked', '🔒 已触发登录锁定',
      `IP ${ip} 累计失败 ${rec.fails} 次 (${reason || '未知原因'}) → 锁定 ${escalated.label}`
      + `${escalated.permanent ? '。解除: 在 NAS 上删除 /data/dsh/auth-lock.json' : ''} · ${auditStamp()}`);
  }
  if (gEscalated !== null) {
    audit('AUTH_LOCKED', { scope: 'global', until: String(gEscalated.until) });
    sendAuthAlert('auth.locked', '🔒 全站登录已锁定',
      `全站 1 小时内失败达 ${GLOBAL_MAX_FAILS} 次 → 全站锁定 1 小时 (已登录会话与已信任设备不受影响) · ${auditStamp()}`);
  }
  return { escalated, gEscalated, fails: rec.fails };
}
function clearFails(ip) {   // 整链认证成功 → 清该 IP 的失败累计与档位
  const s = loadLocks();
  if (s.ips[ip] !== undefined) { delete s.ips[ip]; saveLocks(); }
}

// ---------- 通知中枢告警 (fire-and-forget, 绝不阻塞登录) ----------
// auth-proxy 是独立进程: 直接读跨进程契约文件 NOTIFY_HUB_FILE, 不走插件接口。
// ⚠ 下面的 resolveBark / resolveRouteIds / sendBarkDevice / sendSynologyDevice 是
//   projects/dsh-plugins/dsh-notify/lib/index.js 的**逐字复刻**; Stage 3 会抽成独立插件
//   dsh-notify-hub 并把两处收敛为同一实现 —— 改这里必须同步那边 (复刻规格见
//   docs/任务记录/2026-09-12-通知中枢Stage2-子agent.md)。
const ALERT_SPEC = {
  'auth.login_failed': { group: 'DSH-安全', level: 'timeSensitive' },
  'auth.locked': { group: 'DSH-安全', level: 'timeSensitive' },
  'auth.unlocked': { group: 'DSH-安全', level: 'active' },
  'auth.new_device': { group: 'DSH-安全', level: 'timeSensitive' },
  'auth.mfa_changed': { group: 'DSH-安全', level: 'timeSensitive' },
  // Stage 4 (2026-09-12): 登录一次性码。**只有本类型带 icon** (用户裁定⑤) ⇒ 其它 5 类 payload 逐字不变。
  'auth.otp': { group: 'DSH-安全', level: 'timeSensitive', icon: OTP_ICON_URL },
};
function barkTitle(title) {   // `[DSH] ` 前缀幂等 (逐字复刻 R148-151: 判据是 `[DSH]` 含尾空格前的部分)
  const t = String(title ?? '').trim();
  return t.startsWith('[DSH]') ? t : `[DSH] ${t}`;
}
let hubCache = null;
let hubMtime = -1;
function normalizeHub(raw) {
  const devices = [];
  const seen = new Set();
  if (Array.isArray(raw.devices)) {
    for (const d of raw.devices) {
      if (d === null || typeof d !== 'object') continue;
      const id = typeof d.id === 'string' ? d.id : '';
      if (!/^[a-z0-9_-]{1,32}$/.test(id) || seen.has(id)) continue;
      if (d.kind !== 'bark' && d.kind !== 'synology') continue;
      if (typeof d.url !== 'string' || d.url === '') continue;
      seen.add(id);
      devices.push({
        id, name: typeof d.name === 'string' ? d.name : id, kind: d.kind,
        url: d.url, enabled: d.enabled !== false,
      });
    }
  }
  const routes = {};
  if (raw.routes !== null && typeof raw.routes === 'object') {
    for (const [type, ids] of Object.entries(raw.routes)) {
      // ⚠ 键存在即生效 (逐字复刻 R228-235 的 hasOwnProperty 判定): 空数组/null/非数组 ⇒ 零请求不回落。
      //   (Stage 1 的 normalizeHub 把 routes[type]=[] 删键 ⇒ 正常文件里不会出现空数组;
      //    但手改文件可能出现, A 侧必须按"键存在"处理, 所以这里**保留空键**。)
      routes[type] = Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : [];
    }
  }
  const routeDefault = Array.isArray(raw.routeDefault)
    ? raw.routeDefault.filter((x) => typeof x === 'string') : [];
  return { devices, routes, routeDefault, byId: new Map(devices.map((d) => [d.id, d])) };
}
function loadHub() {
  const st = statSafe(NOTIFY_HUB_FILE);
  if (st === null) { hubCache = null; hubMtime = -1; return null; }
  tighten(NOTIFY_HUB_FILE);   // 同 loadMfa: 收紧必须在缓存短路之前 (该文件由 dsh-notify 写, 这里只收紧不改内容)
  if (hubCache !== null && st.mtimeMs === hubMtime) return hubCache;
  const raw = readJsonFile(NOTIFY_HUB_FILE);
  if (raw === null || typeof raw !== 'object') { hubCache = null; hubMtime = st.mtimeMs; return null; }
  hubCache = normalizeHub(raw);
  hubMtime = st.mtimeMs;
  return hubCache;
}
// 路由语义 (逐字复刻): 键存在 ⇒ 只用它 (解析后为空 = 零请求, 不回落); 否则 routeDefault 非空 ⇒ 用它;
// 否则全部 enabled !== false 设备; 停用/不存在 id 静默忽略。
function resolveRouteIds(hub, type) {
  const pick = (ids) => ids.filter((id) => {
    const d = hub.byId.get(id);
    return d !== undefined && d.enabled !== false;
  });
  if (Object.prototype.hasOwnProperty.call(hub.routes, type)) return pick(hub.routes[type]);
  if (hub.routeDefault.length > 0) return pick(hub.routeDefault);
  return hub.devices.filter((d) => d.enabled !== false).map((d) => d.id);
}
// 由设备 URL 推导 Bark 端点与 key (逐字复刻 R159-171; 含"query 给了 device_key 就不 pop path"的怪癖)
function resolveBark(deviceUrl) {
  let u;
  try { u = new URL(String(deviceUrl)); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;   // A 侧防御: 非法协议直接跳过
  const own = {};
  u.searchParams.forEach((v, k) => { own[k] = v; });   // 同名 query: 后者覆盖前者
  const segments = u.pathname.split('/').filter(Boolean);   // 原样, 不 decode
  let key = typeof own.device_key === 'string' ? own.device_key : '';
  if (!key && segments.length > 0 && segments[segments.length - 1] !== 'push') key = segments.pop();
  const path = `/${segments.join('/')}`;
  const isPushPath = segments.length > 0 && segments[segments.length - 1] === 'push';
  const endpoint = u.origin + (isPushPath ? path : (path === '/' ? '' : path) + '/push');
  return { endpoint, key, own };
}
function postJson(urlStr, payload, timeoutMs, done) {
  let u;
  try { u = new URL(urlStr); } catch { done(new Error('bad-url')); return; }
  const lib = u.protocol === 'https:' ? require('https') : http;
  const data = Buffer.from(JSON.stringify(payload));
  const preq = lib.request({
    hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: `${u.pathname}${u.search}`, method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': data.length },
    timeout: timeoutMs,
  }, (pres) => {
    let body = '';
    pres.on('data', (c) => { body += c; if (body.length > 16384) pres.destroy(); });
    pres.on('end', () => {
      // 逐字复刻 R328-330 的判定顺序: 先 HTTP ok (未读 body) → 再要求 code 是数字 200
      const ok = pres.statusCode >= 200 && pres.statusCode < 300;
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* 非 JSON ⇒ parsed null ⇒ code undefined ⇒ 视为失败 */ }
      if (!ok) { done(new Error(`bark http=${String(pres.statusCode)}`)); return; }
      if (parsed === null || parsed.code !== 200) {
        done(new Error(`bark code=${parsed === null ? 'null' : String(parsed.code)}`)); return;
      }
      done(null);
    });
    pres.on('error', (e) => done(e));
  });
  preq.on('timeout', () => preq.destroy(new Error('timeout')));
  preq.on('error', (e) => done(e));
  preq.end(data);
}
// 群晖 Chat: body 是 form-urlencoded 的 payload=<JSON.stringify({text})> (逐字复刻 R335-347)
function postSynology(urlStr, text, timeoutMs, done) {
  let u;
  try { u = new URL(urlStr); } catch { done(new Error('bad-url')); return; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') { done(new Error('bad-protocol')); return; }
  const lib = u.protocol === 'https:' ? require('https') : http;
  const data = Buffer.from(`payload=${encodeURIComponent(JSON.stringify({ text }))}`);
  const preq = lib.request({
    hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: `${u.pathname}${u.search}`, method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': data.length },
    timeout: timeoutMs,
  }, (pres) => {
    let body = '';
    pres.on('data', (c) => { body += c; if (body.length > 16384) pres.destroy(); });
    pres.on('end', () => {
      // ⚠ 顺序与 Bark 相反 (逐字复刻 R343-345): 先读 body, 再判 HTTP, 最后要求 success === true
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* ignore */ }
      const ok = pres.statusCode >= 200 && pres.statusCode < 300;
      if (!ok) { done(new Error(`synology http=${String(pres.statusCode)}`)); return; }
      // entry.cgi 失败也回 HTTP 200 ⇒ 必须查 success === true (严格布尔)
      if (parsed === null || parsed.success !== true) {
        done(new Error(`synology success=${parsed === null ? 'null' : JSON.stringify(parsed.success)}`)); return;
      }
      done(null);
    });
    pres.on('error', (e) => done(e));
  });
  preq.on('timeout', () => preq.destroy(new Error('timeout')));
  preq.on('error', (e) => done(e));
  preq.end(data);
}
function sendBarkDevice(device, alert, done) {
  let r = null;
  try { r = resolveBark(device.url); } catch { r = null; }
  if (r === null || r.key === '') { done(new Error('bark-url-unresolvable')); return; }
  // 字段顺序即字面量顺序 (逐字复刻 R313-321); `...own` 放最后 ⇒ URL 自带同名参数优先
  // Stage 4: `icon` **只在 alert.icon 存在时**加 (即仅 auth.otp) ⇒ 既有 5 类 payload 逐字不变
  const payload = {
    device_key: r.key,
    title: alert.title,
    body: alert.body,
    group: alert.group,
    level: alert.level,
    isArchive: 1,
  };
  if (typeof alert.icon === 'string' && alert.icon !== '') payload.icon = alert.icon;
  Object.assign(payload, r.own);
  postJson(r.endpoint, payload, ALERT_TIMEOUT_MS, done);
}
function sendSynologyDevice(device, alert, done) {
  // 群晖无 title/group/level 字段 ⇒ 标题写进正文首行 (告警都短, 不做 2000 字符分页)
  postSynology(device.url, `${alert.title}\n${alert.body}`, ALERT_TIMEOUT_MS, done);
}
// fire-and-forget: 立即返回, 3s 超时, 失败只写审计 ALERT_FAIL, 绝不影响登录响应
function sendAuthAlert(type, title, body) {
  try {
    const spec = ALERT_SPEC[type];
    if (spec === undefined) return;
    const hub = loadHub();
    if (hub === null) {   // 缺失/损坏 ⇒ 零请求 + 一条审计 (不猜、不回落 env、绝不写盘, 保持单写者)
      audit('ALERT_FAIL', { type, error: 'notify-hub-unavailable' });
      return;
    }
    const ids = resolveRouteIds(hub, type);
    const alert = { title: barkTitle(title), body, group: spec.group, level: spec.level };
    for (const id of ids) {
      const device = hub.byId.get(id);
      if (device === undefined) continue;
      const done = (err) => {
        if (err !== null && err !== undefined) audit('ALERT_FAIL', { type, device: id, error: err.message });
      };
      try {
        if (device.kind === 'bark') sendBarkDevice(device, alert, done);
        else sendSynologyDevice(device, alert, done);
      } catch (e) { done(e); }
    }
  } catch (e) {
    audit('ALERT_FAIL', { type, error: e.message });
  }
}

// ---------- 一次性码内核 (2026-09-12, Stage 4) ----------
// 状态文件 `.auth-otp.json` (新文件, env DSH_AUTH_OTP_FILE): 0600 + 原子写 + 按 mtime 热加载。
// 文件形状 (契约 §2): { version, otpEnabled, codes[], sent{ip:[ts]}, updatedAt }
// 边界语义 (契约 §2.1, 逐条): 文件不存在/损坏 ⇒ 关闭且**不自动创建**; otpEnabled 非严格 true ⇒ 关闭;
//   codes 逐元素过滤丢弃非法项; expiresAt 非有限数 ⇒ 视为已过期(0); sent[ip] 非法 ⇒ [];
//   tighten() 必须在缓存短路**之前**; saver 直接落内存态 (禁止再调 loader)。
let otpState = null;
let otpMtime = -1;
let otpCorruptAt = -1;
let otpCorruptLogged = false;
function emptyOtp() { return { version: 1, otpEnabled: false, codes: [], sent: {}, updatedAt: 0 }; }
function loadOtp() {
  const st = statSafe(OTP_FILE);
  if (st === null) { otpState = emptyOtp(); otpMtime = -1; otpCorruptAt = -1; return otpState; }
  tighten(OTP_FILE);   // 同 loadMfa/loadDevices: 收紧必须在缓存短路之前
  if (otpState !== null && st.mtimeMs === otpMtime) return otpState;
  const raw = readJsonFile(OTP_FILE);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    // 损坏/非对象 ⇒ 同"不存在"(降级关闭); console.error 每进程只记一次, 审计每次损坏只记一次
    if (st.mtimeMs !== otpCorruptAt) {
      otpCorruptAt = st.mtimeMs;
      if (!otpCorruptLogged) { otpCorruptLogged = true; console.error(`[auth] 一次性码状态文件损坏 (${OTP_FILE}) ⇒ OTP 降级为关闭`); }
      audit('OTP_FAIL', { error: 'state-corrupt' });
    }
    otpState = emptyOtp(); otpMtime = st.mtimeMs; return otpState;
  }
  const codes = [];
  if (Array.isArray(raw.codes)) {
    for (const c of raw.codes) {
      if (c === null || typeof c !== 'object' || Array.isArray(c)) continue;   // 非法元素静默丢弃
      const hash = typeof c.hash === 'string' ? c.hash : '';
      if (hash === '') continue;
      codes.push({
        hash,
        salt: typeof c.salt === 'string' ? c.salt : '',
        createdAt: Number.isFinite(c.createdAt) ? c.createdAt : 0,
        expiresAt: Number.isFinite(c.expiresAt) ? c.expiresAt : 0,   // 非法 ⇒ 0 ⇒ 视为已过期 (安全侧)
        usedAt: Number.isFinite(c.usedAt) ? c.usedAt : 0,
        tries: Number.isFinite(c.tries) && c.tries > 0 ? Math.floor(c.tries) : 0,
        ip: typeof c.ip === 'string' ? c.ip : '',
        ua: typeof c.ua === 'string' ? c.ua : '',
      });
    }
  }
  const sent = {};
  if (raw.sent !== null && typeof raw.sent === 'object' && !Array.isArray(raw.sent)) {
    for (const [k, v] of Object.entries(raw.sent)) {
      sent[k] = Array.isArray(v) ? v.filter((t) => Number.isFinite(t)) : [];   // 非法 ⇒ [] (由 60s 冷却兜底)
    }
  }
  otpState = {
    version: 1,
    otpEnabled: raw.otpEnabled === true,   // 只有严格 true 才算开 (与 enabled 同风格)
    codes,
    sent,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
  };
  otpMtime = st.mtimeMs;
  return otpState;
}
function saveOtp() {
  try {
    // ⚠ 同 saveDevices/saveLocks: 必须落**内存态本身** (在 saver 里调 loadOtp() 会在"文件尚不存在"
    //   时重置缓存, 把本次刚生成的码吞掉 — Stage 2 缺陷 1 的教训)。
    const cur = otpState !== null ? otpState : loadOtp();
    writeJsonFile(OTP_FILE, cur);
    otpMtime = statSafe(OTP_FILE)?.mtimeMs ?? -1;
  } catch (e) { console.error('[auth] 一次性码状态写盘失败:', e.message); }
}
function otpOn() { return loadOtp().otpEnabled === true; }

// 同步等待式告警 (契约 §3): 与既有 sendAuthAlert(fire-and-forget) **并存**, 既有 5 类调用点不变。
// cb(err, okCount): 全成功或**部分成功**(okCount ≥ 1) ⇒ err=null; 全失败/零目标/超时 ⇒ err。
function sendAuthAlertAwait(type, title, body, cb, timeoutMs) {
  const limit = Number.isFinite(timeoutMs) ? timeoutMs : OTP_TIMEOUT_MS;
  let finished = false;
  const finish = (err, okCount) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    try { cb(err === undefined ? null : err, okCount === undefined ? 0 : okCount); }
    catch (e) { console.error('[auth] 等待式告警回调异常:', e.message); }
  };
  const timer = setTimeout(() => finish(new Error('timeout')), limit);
  try {
    const spec = ALERT_SPEC[type];
    if (spec === undefined) { finish(new Error('unknown-type')); return; }
    const hub = loadHub();
    if (hub === null) { finish(new Error('no_notify_hub')); return; }   // 缺失/损坏 ⇒ 零请求, 不算失败
    const ids = resolveRouteIds(hub, type);
    const alert = { title: barkTitle(title), body, group: spec.group, level: spec.level, icon: spec.icon };
    let pending = 0;
    let ok = 0;
    let firstErr = null;
    const one = (id) => (err) => {
      if (err !== null && err !== undefined) {
        if (firstErr === null) firstErr = err;
        audit('ALERT_FAIL', { type, device: id, error: err.message });   // 失败设备写审计 (契约 §3)
      } else ok += 1;
      pending -= 1;
      if (pending <= 0) finish(ok >= 1 ? null : new Error(firstErr === null ? 'no_targets' : firstErr.message), ok);
    };
    for (const id of ids) {
      const device = hub.byId.get(id);
      if (device === undefined) continue;   // 停用/不存在 id 静默忽略 (与 fire-and-forget 同语义)
      pending += 1;
      const doneOne = one(id);
      try {
        if (device.kind === 'bark') sendBarkDevice(device, alert, doneOne);
        else sendSynologyDevice(device, alert, doneOne);
      } catch (e) { doneOne(e); }
    }
    if (pending === 0) finish(new Error('no_targets'));
  } catch (e) { finish(e); }
}

// 一次性码校验 (登录提交侧, 契约 §4.3): 返回 { triesUsed } 或 null。
// ⚠ **不在此处计失败次数**: 失败计数由调用方既有 failLogin ⇒ recordFail **恰一次** 完成 (F9: 防双计数)。
// 码内状态变化: 失败 ⇒ tries+1, 达上限 ⇒ usedAt=now 作废 + OTP_TRIES_EXCEEDED 审计;
//                成功 ⇒ usedAt=now 且作废该 IP 其余未用码。
function verifyOtpCode(ip, ua, code) {
  try {
    const otp = loadOtp();
    if (otp.otpEnabled !== true) return null;
    const now = Date.now();
    // 同 IP 至多保留 1 个未用码 (F10: 每次发码先作废旧码) ⇒ 取最后一个未过期未用码
    const cand = otp.codes.filter((c) => c.ip === ip && c.usedAt === 0 && c.expiresAt > now);
    if (cand.length === 0) return null;   // 无码/已过期/已用尽 ⇒ 直接拒 (不新建记录)
    const rec = cand[cand.length - 1];
    const norm = String(code || '').replace(/\D/g, '');
    const hit = norm.length === 6 && safeEqualStr(rec.hash, hashRecovery(rec.salt, norm));
    if (!hit) {
      rec.tries += 1;   // 每次提交(含格式不符的错码)算一次尝试
      if (rec.tries >= OTP_MAX_TRIES) {   // 达 5 次上限 ⇒ 立即作废
        rec.usedAt = now;
        otp.updatedAt = now;
        saveOtp();
        audit('OTP_TRIES_EXCEEDED', { ip, ua });
      } else {
        otp.updatedAt = now;
        saveOtp();
      }
      return null;
    }
    const triesUsed = rec.tries + 1;
    for (const c of otp.codes) if (c.ip === ip && c.usedAt === 0) c.usedAt = now;   // 用掉即废 + 作废该 IP 其余未用码
    otp.updatedAt = now;
    saveOtp();
    return { triesUsed };
  } catch (e) {
    console.error('[auth] 一次性码校验异常:', e.message);
    return null;
  }
}

// 发码端点 (契约 §4.1 门禁顺序 ①–⑩ + §4.2 响应形状, 逐字)
function handleSendOtp(req, res, ip) {
  const ua = uaSummary(req);
  const deny = (status, error, extra) => {
    audit('OTP_FAIL', { ip, ua, error });
    mfaReply(res, status, Object.assign({ ok: false, error }, extra || {}));
  };
  try {
    // CSRF (同 /mfa/api): 浏览器路径若带 Origin, 其 host 必须与 Host 一致
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin !== '') {
      let oh = '';
      try { oh = new URL(origin).host; } catch { oh = ''; }
      if (oh === '' || oh !== String(req.headers.host || '')) { deny(403, 'bad_origin'); return; }
    }
    const cfg = loadMfa();
    if (cfg === null || cfg.enabled !== true) { deny(403, 'mfa_off'); return; }
    if (!preauthOk(req, ip)) { deny(401, 'no_preauth'); return; }
    const otp = loadOtp();
    if (otp.otpEnabled !== true) { deny(403, 'otp_disabled'); return; }   // 关闭态: 不生成码/不写文件
    const now = Date.now();
    if (lockStatus(ip, now) !== null) { deny(423, 'locked'); return; }    // 锁定态: 不发码 (用户裁定④)
    const sents = (Array.isArray(otp.sent[ip]) ? otp.sent[ip] : []).filter((t) => now - t < OTP_WINDOW_MS);
    const last = sents.length > 0 ? Math.max(...sents) : 0;
    if (last > 0 && now - last < OTP_COOLDOWN_MS) {   // ⑥ 冷却 (1 次/60s)
      deny(429, 'cooldown', { retryInSec: Math.max(1, Math.ceil((OTP_COOLDOWN_MS - (now - last)) / 1000)) });
      return;
    }
    if (sents.length >= OTP_MAX_SENDS) {   // ⑦ 窗口配额 (≤3 次/5 分钟)
      const oldest = Math.min(...sents);
      deny(429, 'rate_limited', { retryInSec: Math.max(1, Math.ceil((OTP_WINDOW_MS - (now - oldest)) / 1000)) });
      return;
    }
    // ⑦.5 通道预检 (决策登记 D-OTP-6): hub 缺失/损坏 ⇒ **不生成码、不写状态文件、不占配额**,
    //   直接 409 (契约 §4.2 "no_notify_hub ⇒ 不发"; 放在生成之前才能真正"不发")。
    if (loadHub() === null) { deny(409, 'no_notify_hub'); return; }
    // ⑧ 生成码 + 落盘 (文件里**只有哈希**; 明文仅在内存与下发通知里)
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const salt = crypto.randomBytes(16).toString('hex');
    const rec = {
      hash: hashRecovery(salt, code), salt,
      createdAt: now, expiresAt: now + OTP_TTL_MS, usedAt: 0, tries: 0, ip, ua,
    };
    for (const c of otp.codes) if (c.ip === ip && c.usedAt === 0) c.usedAt = now;   // 旧码立即作废 (F10)
    otp.codes = otp.codes.filter((c) => c.usedAt === 0 || now - c.usedAt < OTP_WINDOW_MS);
    otp.codes.push(rec);
    otp.sent[ip] = sents.concat([now]);
    otp.updatedAt = now;
    saveOtp();
    // ⑨ 同步下发 (≤ OTP_TIMEOUT_MS; 用户必须知道"到底发出去没有")
    const text = `登录一次性码：${code}\n5 分钟内有效，仅用于本次登录，用掉即失效。\nIP ${ip} · ${ua} · ${auditStamp()}`;
    sendAuthAlertAwait('auth.otp', '🔐 登录验证码', text, (err, okCount) => {
      if (err !== null) {
        const msg = String(err.message || '');
        if (msg === 'no_notify_hub' || msg === 'unknown-type') { deny(409, 'no_notify_hub'); return; }
        deny(502, 'delivery_failed');   // 全设备失败或超时 (不计锁表失败次数)
        return;
      }
      audit('OTP_SENT', { ip, ua, devices: String(okCount), ttlSec: String(Math.round(OTP_TTL_MS / 1000)) });
      // ⑩ 成功响应
      mfaReply(res, 200, {
        ok: true,
        sent: okCount,
        ttlSec: Math.max(0, Math.round((rec.expiresAt - Date.now()) / 1000)),
        nextInSec: Math.round(OTP_COOLDOWN_MS / 1000),
        remainInWindow: Math.max(0, OTP_MAX_SENDS - otp.sent[ip].length),
      });
    });
  } catch (e) {
    // 零回归铁律: 任何异常都不得影响登录 ⇒ 只审计 + 502, 不抛出
    audit('OTP_FAIL', { ip, ua, error: 'delivery_failed' });
    try { mfaReply(res, 502, { ok: false, error: 'delivery_failed' }); } catch { /* 响应已发出 */ }
  }
}

// ---------- 登录页 ----------
// 装修 (2026-08-27): 背景跟随聊天背景 (dsh-bg-image 同一 localStorage 设置, 同域共享),
// 卡片白色 → 毛玻璃 (backdrop-filter)。无设置/无痕时回退默认每日壁纸 /bing-wallpaper。
const LOGIN_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DeepSeek Harness 登录</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: linear-gradient(160deg,#0f1420,#1a2332); font-family: -apple-system,"PingFang SC","Microsoft YaHei",sans-serif; }
  #bg { position: fixed; inset: 0; z-index: -1; background-size: cover; background-position: center; background-repeat: no-repeat; }
  .card { width: 340px; padding: 36px 32px; border-radius: 16px;
          background: rgba(255,255,255,.62); border: 1px solid rgba(255,255,255,.45);
          -webkit-backdrop-filter: blur(18px) saturate(1.4); backdrop-filter: blur(18px) saturate(1.4);
          box-shadow: 0 12px 40px rgba(0,0,0,.35); }
  h1 { font-size: 20px; color: #111; margin-bottom: 6px; }
  p.sub { font-size: 13px; color: #666; margin-bottom: 22px; }
  label { display: block; font-size: 13px; color: #444; margin: 14px 0 6px; }
  input { width: 100%; padding: 10px 12px; border: 1px solid rgba(0,0,0,.12); border-radius: 8px; font-size: 15px; outline: none;
          background: rgba(255,255,255,.75); }
  input:focus { border-color: #4d6bfe; }
  button { width: 100%; margin-top: 22px; padding: 11px; border: 0; border-radius: 8px; background: #4d6bfe; color: #fff; font-size: 15px; cursor: pointer; }
  button:hover { background: #3d59e0; }
  .err { display: none; margin-top: 14px; padding: 8px 10px; border-radius: 8px; background: #fdeaea; color: #c0392b; font-size: 13px; }
  /* 以下为 2026-09-12 新增态 (TOTP 二次验证), 值取自用户确认的预览 public/banner-styles.html 区块 17 */
  .ok { margin: 0 0 22px; padding: 9px 11px; border-radius: 8px; background: rgba(232,246,238,.95);
        border: 1px solid #8fcea8; color: #1f7a45; font-size: 13px; line-height: 1.5; }
  .code { box-sizing: border-box; width: 100%; padding: 12px; border: 1px solid rgba(0,0,0,.12); border-radius: 8px;
          outline: none; background: rgba(255,255,255,.75); text-align: center;
          font-family: ui-monospace,"SF Mono",Consolas,monospace; font-size: 19px;
          letter-spacing: .32em; text-indent: .32em; }
  .code:focus { border-color: #4d6bfe; }
  .code::placeholder { color: #b8b8b8; letter-spacing: .32em; }
  .warn { margin-top: 8px; font-size: 12px; line-height: 1.6; color: #666; }
  .timer { margin-top: 8px; text-align: center; font-size: 12px; color: #666; font-variant-numeric: tabular-nums; }
  .timer b { color: #444; font-weight: 600; }
  .link { display: block; margin-top: 14px; text-align: center; font-size: 12.5px; color: #4d6bfe; text-decoration: none; }
  .link:hover { text-decoration: underline; }
  .lock { margin: 6px 0 2px; text-align: center; }
  .lock-lb { font-size: 13px; color: #666; margin-bottom: 4px; }
  .lock-num { font-size: 30px; font-weight: 700; color: #c0392b; font-variant-numeric: tabular-nums;
              letter-spacing: .02em; font-family: ui-monospace,"SF Mono",Consolas,monospace; }
  .note { margin-top: 12px; text-align: center; font-size: 12px; line-height: 1.6; color: #666; }
  button[disabled] { background: #4d6bfe; opacity: .45; cursor: not-allowed; }
  .hint { display: none; margin-bottom: 16px; padding: 9px 11px; border-radius: 8px; background: rgba(255,248,230,.92); border: 1px solid #f0d48a; color: #8a6d1a; font-size: 13px; line-height: 1.5; }
</style></head><body>
<div id="bg"></div>
<div class="card">
  <div class="hint" id="hint">当前是明文 HTTP 访问。局域网请使用 <b>https://NAS_IP:8443</b> 访问, 否则界面无法正常工作。</div>
__CARD__
</div>
<script>
if (__INSECURE_LAN__) document.getElementById('hint').style.display='block';
__PAGE_SCRIPT__
// 背景与聊天背景一致: 读 dsh-bg-image 同一份设置 (同域 localStorage), 复刻其模式→URL 逻辑
(function () {
  var KEY = "dsh.bg-image.v2", DEF = "/bing-wallpaper", sec = {};
  try { var raw = localStorage.getItem(KEY); if (raw) sec = JSON.parse(raw) || {}; } catch (e) {}
  var mode = sec.mode;
  if (!mode && sec.image && sec.image !== DEF) mode = "custom";
  if (!mode) mode = "daily";
  var img;
  if (mode === "folder") {
    // 跟随聊天背景: mode=current 返回服务端最近一次随机选中的图并锁定 lockSec 秒
    // (设置里可配, localStorage dsh.bg-image.v2.lockSec; 默认 120 秒), 锁期内聊天页
    // 跟随同一张; 服务端无记录时回退随机一张
    var lock = sec.lockSec ? "&lockSec=" + encodeURIComponent(String(sec.lockSec)) : "";
    img = "/wallpaper-folder?mode=current" + lock;
  } else if (mode === "custom" && sec.image) {
    img = sec.image;
  } else {
    img = DEF;
  }
  var bg = document.getElementById("bg");
  if (bg) {
    bg.style.background = 'linear-gradient(rgba(0,0,0,.28),rgba(0,0,0,.28)),url("' + img.replace(/["\\\\]/g, "\\\\$&") + '") center/cover no-repeat';
  }
})();
</script>
</body></html>`;

// 登录页三态 (2026-09-12, Stage 2): 密码态 / 验证码态 (step=code) / 锁定态。
// ⚠ 视觉样式待用户确认 public/banner-styles.html 区块 17 后定稿 (ENV「界面元素变动先预览确认」);
//   冻结的 HTML 钩子 (契约 §3.1, 不得改): `name="code"` 验证码框 /
//   `id="locked"` 锁定容器 / `id="lock-left"` 的 `data-ms` 剩余毫秒 / `id="err"` 错误条。
function errBox(text) {
  return text === '' ? '' : `<div class="err" id="err" style="display:block">${text}</div>`;
}
function passwordCard(mfa, err, next) {
  const nq = next === '/mfa' ? '?next=/mfa' : '';   // Stage 3: /mfa 入口跳转参数随表单一起走
  return `<h1>DeepSeek Harness</h1>
  <p class="sub">请输入访问凭据${mfa ? '（本设备还需二次验证码）' : ''}</p>
  <form method="post" action="/login${nq}">
    <label for="u">用户名</label>
    <input id="u" name="username" autocomplete="username" required autofocus>
    <label for="p">密码</label>
    <input id="p" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">登 录</button>
  </form>
  ${errBox(err)}`;
}
function codeCard(err, next, otpReady) {
  const nq = next === '/mfa' ? '&next=/mfa' : '';   // 验证码态同样保留 next
  const cfg = loadMfa();
  const period = cfg === null ? 30 : cfg.period;
  const left = period - (Math.floor(Date.now() / 1000) % period);   // 当前 30s 窗口剩余秒数 (示意用)
  // Stage 4 (契约 §5): `#otp-msg` 容器**必须始终存在** (关闭态为空且 hidden);
  //   `#btn-send-otp` / `#otp-count` / `#otp-warn` **仅在** otpEnabled && !locked && mfa 时渲染。
  const otpUi = otpReady === true
    ? `<div class="ok" id="otp-msg" hidden></div>
    <button type="button" id="btn-send-otp">📲 发送验证码到手机<span id="otp-count"></span></button>
    <div class="warn" id="otp-warn">一次性码只在下发通知里显示，本页与日志都不会出现；用掉即失效</div>`
    : `<div id="otp-msg" hidden></div>`;
  return `<h1>DeepSeek Harness</h1>
  <div class="ok" id="ok">✓ 密码已通过，请输入验证码</div>
  <form method="post" action="/login?step=code${nq}">
    <label for="c">验证码</label>
    <input id="c" name="code" class="code" type="text" inputmode="numeric" autocomplete="one-time-code"
           maxlength="12" placeholder="******" autofocus required>
    ${errBox(err)}
    ${err === '' ? '' : '<div class="warn">再次验证失败会临时锁定登录，请确认验证器时间后再试</div>'}
    ${otpUi}
    <div class="timer">验证码有效剩余 <b id="ttl" data-period="${period}" data-left="${left}">${left}</b> 秒</div>
    <div class="hint" style="margin:10px 0 0;display:block">输入验证器 6 位验证码，或一次性恢复码</div>
    <button type="submit">验 证</button>
  </form>
  <a class="link" href="/login${next === '/mfa' ? '?next=/mfa' : ''}">← 返回重新输入密码</a>`;
}
function lockCard(lock) {
  const perm = lock.permanent === true;
  return `<div id="locked">
  <h1>已暂时锁定</h1>
  <p class="sub">验证失败次数过多, 已暂时停止接收登录与验证请求</p>
  <div class="lock">
    <div class="lock-lb">还需等待</div>
    <div class="lock-num" id="lock-left" data-ms="${perm ? 0 : lock.ms}"${perm ? ' data-permanent="1"' : ''}
      >${perm ? '永久' : '--:--'}</div>
  </div>
  <div class="note">已登录的会话与已信任设备不受影响</div>
  <button type="button" disabled>稍后重试</button>
</div>`;
}
// 锁定态倒计时 (放进页面既有 <script> 内, 每秒刷新; 永久锁不跳转)
const LOCK_JS = `
(function () {
  var el = document.getElementById('lock-left');
  if (!el) return;
  if (el.getAttribute('data-permanent') === '1') return;
  var end = Date.now() + parseInt(el.getAttribute('data-ms') || '0', 10);
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function tick() {
    var left = end - Date.now();
    if (left <= 0) { el.textContent = '00:00'; location.href = '/login'; return; }
    var s = Math.floor(left / 1000), m = Math.floor(s / 60);
    el.textContent = m >= 60 ? (Math.floor(m / 60) + ' 小时 ' + pad(m % 60) + ' 分') : (m + ':' + pad(s % 60));
    setTimeout(tick, 1000);
  }
  tick();
})();`;
// 验证码态的有效期倒计时 (TOTP 30s 窗口滚动, 示意)
const TTL_JS = `
(function () {
  var el = document.getElementById('ttl');
  if (!el) return;
  var period = parseInt(el.getAttribute('data-period') || '30', 10);
  var left = parseInt(el.getAttribute('data-left') || String(period), 10);
  function tick() {
    left -= 1;
    if (left <= 0) left = period;
    el.textContent = String(left);
    setTimeout(tick, 1000);
  }
  setTimeout(tick, 1000);
})();`;
// 一次性码页内脚本 (Stage 4, 契约 §5): 仅在 otpEnabled && !locked && mfa 时才注入 (关闭态零新增节点/脚本)。
// 文案用 textContent 赋值 (禁 innerHTML); 结果条沿用既有 .ok/.err 语义色; 倒计时 data-left 与文本同源。
const OTP_JS = `
(function () {
  var btn = document.getElementById('btn-send-otp');
  if (!btn) return;
  var msg = document.getElementById('otp-msg');
  var cnt = document.getElementById('otp-count');
  var timer = null, until = 0;
  function paint() {
    var left = Math.ceil((until - Date.now()) / 1000);
    if (left < 0) left = 0;
    if (cnt) { cnt.textContent = left > 0 ? ' (' + left + 's)' : ''; cnt.setAttribute('data-left', String(left)); }
    if (left <= 0) { if (timer) { clearInterval(timer); timer = null; } btn.disabled = false; }
  }
  function cooldown(sec) {
    until = Date.now() + Math.max(1, sec) * 1000;
    btn.disabled = true;
    if (timer) clearInterval(timer);
    paint();
    timer = setInterval(paint, 100);   // 契约: 每 100ms 刷新
  }
  function show(cls, text) {
    msg.className = cls;
    msg.style.display = 'block';
    msg.style.margin = '10px 0 0';
    msg.textContent = text;
  }
  btn.addEventListener('click', function () {
    if (btn.disabled) return;
    btn.disabled = true;
    var form = document.querySelector('form');
    var url = (form ? form.getAttribute('action') : '/login?step=code') + '&action=send-otp';
    fetch(url, { method: 'POST', credentials: 'same-origin' }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { return d || {}; });
    }).then(function (d) {
      if (d.ok === true) { show('ok', '✅ 验证码已发送到你的设备，5 分钟内有效'); cooldown(parseInt(d.nextInSec || 60, 10)); return; }
      btn.disabled = false;
      var e = String(d.error || '');
      if (e === 'cooldown' || e === 'rate_limited') { show('err', '⚠️ 发送过于频繁，请稍后重试'); cooldown(parseInt(d.retryInSec || 60, 10)); return; }
      if (e === 'no_preauth') { show('err', '⚠️ 登录已超时，请返回重新输入密码'); return; }
      if (e === 'locked') { show('err', '⚠️ 当前已锁定，暂不能发送验证码'); return; }
      if (e === 'otp_disabled') { show('err', '⚠️ 一次性码已关闭，请用验证器或恢复码'); return; }
      if (e === 'no_notify_hub') { show('err', '⚠️ 通知通道未配置，无法发送验证码'); return; }
      if (e === 'delivery_failed') { show('err', '⚠️ 验证码发送失败，请重试或改用验证器'); return; }
      show('err', '⚠️ 发送失败，请稍后重试');
    }).catch(function () { btn.disabled = false; show('err', '⚠️ 网络异常，请稍后重试'); });
  });
})();`;
// opts: { insecureLan, mfa, step:''|'code', err:0|1|2, lock:null|{ms,permanent}, next:''|'/mfa', otp:bool }
function sendLogin(res, opts) {
  const o = opts || {};
  const locked = o.lock !== null && o.lock !== undefined;
  let card = '';
  let pageScript = '';
  if (locked) { card = lockCard(o.lock); pageScript = LOCK_JS; }
  else if (o.step === 'code') { card = codeCard(o.err === 2 ? '验证码不正确，请重试' : '', o.next, o.otp === true); pageScript = TTL_JS + (o.otp === true ? OTP_JS : ''); }
  else card = passwordCard(o.mfa === true, o.err === 1 ? '用户名或密码错误, 请重试' : '', o.next);
  const html = LOGIN_HTML
    .replace('__CARD__', card)
    .replace('__PAGE_SCRIPT__', pageScript)
    .replace('__INSECURE_LAN__', o.insecureLan ? 'true' : 'false');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

// ============================================================
// MFA 管理界面 (2026-09-12, Stage 3): GET /mfa 页面 + POST /mfa/api/* 动作面
// ------------------------------------------------------------
// 契约: docs/任务记录/2026-09-12-通知中枢Stage3-契约与决策.md §1–§4（唯一来源）
// 铁律:
//   1. 页面与 API 由 auth-proxy 自己渲染/响应, **绝不依赖 dsh**（dsh 停掉也能扫码/自救）;
//   2. 鉴权 = 有效 dsh_session cookie 或 `X-DSH-MFA-Token` == 本地 IPC 令牌（0600, 32 hex）;
//   3. 令牌/种子/恢复码明文绝不进审计、页面、错误信息;
//   4. 任何异常都不得影响登录与代理（全部 try/catch 吞掉 + 审计）。
// ============================================================

// ---------- 本地 IPC 令牌 (0600; 启动时不存在则生成; 运行期按 mtime 热加载) ----------
// 契约 §1.1 (E22, 协调人 2026-09-12 裁决): 令牌 = MFA 管理权 ⇒ 泄漏后必须能靠一次 `rm`/换值**立即吊销**:
//   · 文件被删除 ⇒ 令牌路径立即失效 (cookie 路径照常), 并按需就地重建 (0600 / 32 hex);
//   · 文件内容变化 ⇒ 无需重启即轮换生效 (旧值立刻失效);
//   · 令牌值绝不进响应体/页面/审计/错误信息 (日志只写"文件被删/已轮换", 不写值)。
const MFA_TOKEN_REBUILD_THROTTLE_MS = 2000;
let mfaToken = null;            // 当前有效令牌 (null = 令牌路径不可用); 值绝不外泄
let mfaTokenMtime = -2;         // 上次加载时的 mtime (-2 = 从未加载)
let mfaTokenRebuildAt = 0;      // 重建节流 (文件不可写时不要每请求重试)
let mfaTokenWarned = false;
const MFA_TOKEN_RE = /^[0-9a-fA-F]{32}$/;
function mfaTokenDir() {
  const dir = MFA_TOKEN_FILE.slice(0, MFA_TOKEN_FILE.lastIndexOf('/'));
  if (dir !== '') fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}
function mfaTokenWriteNew() {   // 生成并落盘一个新令牌 (0600 / 32 hex); 返回值只留在内存
  const t = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(MFA_TOKEN_FILE, `${t}\n`, { mode: 0o600 });
  try { fs.chmodSync(MFA_TOKEN_FILE, 0o600); } catch { /* ignore */ }
  mfaToken = t.toLowerCase();
  mfaTokenMtime = statSafe(MFA_TOKEN_FILE)?.mtimeMs ?? -2;
  return mfaToken;
}
function mfaTokenWarn(e) {
  mfaToken = null; mfaTokenMtime = -2;
  if (!mfaTokenWarned) {
    mfaTokenWarned = true;
    console.error(`[auth] MFA 本地 IPC 令牌不可用 (${MFA_TOKEN_FILE}): ${e.message} → 令牌路径已禁用, cookie 路径照常`);
  }
}
function loadOrCreateMfaToken() {   // 启动路径: 不存在/内容非法则生成
  try {
    mfaTokenDir();
    let cur = null;
    try { cur = fs.readFileSync(MFA_TOKEN_FILE, 'utf8').trim(); } catch { cur = null; }
    if (cur === null || !MFA_TOKEN_RE.test(cur)) {
      mfaTokenWriteNew();
      console.log(`auth-proxy: MFA 本地 IPC 令牌已生成 (${MFA_TOKEN_FILE}, 0600)`);
    } else {
      tighten(MFA_TOKEN_FILE);
      mfaToken = cur.toLowerCase();
      mfaTokenMtime = statSafe(MFA_TOKEN_FILE)?.mtimeMs ?? -2;
    }
  } catch (e) { mfaTokenWarn(e); }
}
// 运行期热加载 (每次使用令牌路径时调用一次): 一次 stat + 一次 33B 读取, 成本可忽略
// (协调人明确许可读令牌文件); mtime 用于识别"是否真的轮换"以决定是否打一行日志,
// 判定本身始终以**文件当前内容**为准 ⇒ 同一毫秒内重写也不会漏掉轮换。
function mfaTokenSync() {
  try {
    const st = statSafe(MFA_TOKEN_FILE);
    if (st === null) {
      const wasUsable = mfaToken !== null || mfaTokenMtime !== -2;
      mfaToken = null; mfaTokenMtime = -2;
      const now = Date.now();
      if (now - mfaTokenRebuildAt > MFA_TOKEN_REBUILD_THROTTLE_MS) {
        mfaTokenRebuildAt = now;
        if (wasUsable) console.log(`auth-proxy: MFA 本地 IPC 令牌文件已被删除 → 旧令牌立即失效, 就地重建 (${MFA_TOKEN_FILE})`);
        mfaTokenDir();
        mfaTokenWriteNew();
      }
      return mfaToken;
    }
    tighten(MFA_TOKEN_FILE);
    let cur = null;
    try { cur = fs.readFileSync(MFA_TOKEN_FILE, 'utf8').trim(); } catch { cur = null; }
    if (cur === null || !MFA_TOKEN_RE.test(cur)) {   // 内容非法 ⇒ 同启动逻辑重建
      if (mfaToken !== null) console.log(`auth-proxy: MFA 本地 IPC 令牌内容非法 → 旧令牌已作废并重建 (${MFA_TOKEN_FILE})`);
      mfaTokenDir();
      mfaTokenWriteNew();
      return mfaToken;
    }
    const value = cur.toLowerCase();
    if (mfaToken !== value) {
      if (mfaToken !== null) console.log(`auth-proxy: MFA 本地 IPC 令牌已轮换 (文件内容变化, mtime 热加载) → 旧值立即失效 (${MFA_TOKEN_FILE})`);
      mfaToken = value;
    }
    if (mfaTokenMtime !== st.mtimeMs) mfaTokenMtime = st.mtimeMs;
    return mfaToken;
  } catch (e) { mfaTokenWarn(e); return null; }
}
// 令牌比对用常数时间; 令牌值不出现在任何响应/审计里 (只记"用了哪条路径")
function mfaTokenOk(req) {
  const v = req.headers['x-dsh-mfa-token'];
  if (typeof v !== 'string' || v === '') return false;
  const cur = mfaTokenSync();          // 先热加载 (删/改/重建立刻生效), 再比对
  return cur !== null && safeEqualStr(v.toLowerCase(), cur);
}
function mfaApiAuthed(req) { return readCookie(req) !== null || mfaTokenOk(req); }

// ---------- 种子/恢复码生成 ----------
let plainCache = { secret: '', codes: [] };   // 仅内存: 最近一次生成的恢复码明文 (重启即失; 哈希不可逆)
function genSecret() {
  let s = '';
  for (let i = 0; i < 32; i += 1) s += B32_ALPHABET[crypto.randomBytes(1)[0] % B32_ALPHABET.length];
  return s;
}
// 恢复码: Crockford base32 / 8 位 / 显示为 XXXX-XXXX / 存哈希 (Stage 2 §1.1 约定逐字沿用)
function genRecoveryCodes(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    let s = '';
    for (let j = 0; j < 8; j += 1) s += RECOVERY_ALPHABET[crypto.randomBytes(1)[0] % RECOVERY_ALPHABET.length];
    const salt = crypto.randomBytes(16).toString('hex');
    out.push({ disp: `${s.slice(0, 4)}-${s.slice(4)}`, rec: { hash: hashRecovery(salt, s), salt, usedAt: 0 } });
  }
  return out;
}
function otpauthUri(secret) {
  // Stage 4 (2026-09-13, 用户要求「扫码后 otp 应用里也要有图标」): Key URI Format 的**可选** `image=`
  //   参数 —— 属扩展而非强制件: Aegis / 2FAS / Ente Auth 等会显示该图标, Google / Microsoft /
  //   Apple 验证器与 Authy 会忽略（不报错）。⚠️ **必须排在 `secret=` 之前**: 既有断言
  //   `…secret=…&issuer=DSH&algorithm=SHA1&digits=6&period=30$` 逐字锚定结尾, 追加在尾部会失配。
  //   取值用 PWA 同一张公开可取的图标（env DSH_NOTIFY_ICON_URL 可覆盖, 与推送 icon 同源）。
  const img = encodeURIComponent(OTP_ICON_URL);
  return `otpauth://totp/DSH:${USER}?image=${img}&secret=${secret}&issuer=DSH&algorithm=SHA1&digits=6&period=30`;
}
// seed/enable/regenerate 共同的返回形状 (契约 §2)
function seedPayload(cfg, enabled) {
  const otpauth = otpauthUri(cfg.secret);
  return {
    ok: true,
    secret: cfg.secret,
    otpauth,
    qrSvg: qrSvgFor(otpauth),
    recoveryCodes: unusedPlainCodes(cfg),
    enabled: enabled === undefined ? cfg.enabled : enabled,
  };
}
// 明文恢复码只可能来自**本进程**生成的那一次 (文件里只有哈希) ⇒ 重启/外部写入后为空数组
function unusedPlainCodes(cfg) {
  if (plainCache.secret !== cfg.secret) return [];
  const out = [];
  cfg.recoveryCodes.forEach((rc, i) => {
    if (rc !== null && typeof rc === 'object' && !rc.usedAt && typeof plainCache.codes[i] === 'string') out.push(plainCache.codes[i]);
  });
  return out;
}

// ---------- 二维码 (vendored qrcode-generator; 缺失/异常一律 qrSvg:null, 绝不抛错) ----------
let qrLib = null;
try {
  qrLib = require(QR_LIB);
  if (typeof qrLib !== 'function' && qrLib !== null && typeof qrLib.default === 'function') qrLib = qrLib.default;
  if (typeof qrLib !== 'function') { console.error(`[auth] 二维码库导出不是函数 (${QR_LIB}) → qrSvg 一律 null`); qrLib = null; }
} catch (e) {
  qrLib = null;
  console.error(`[auth] 二维码库不可用 (${QR_LIB}): ${e.message} → qrSvg=null, 页面降级为手动输入 base32`);
}
function qrSvgFor(uri) {
  if (qrLib === null) return null;
  try {
    const qr = qrLib(0, 'M');   // typeNumber=0 自动, 纠错级 M
    qr.addData(uri);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2 });
  } catch (e) {
    console.error('[auth] 二维码生成失败:', e.message);
    return null;
  }
}

// ---------- 状态汇总 (GET /mfa 与 POST status 共用) ----------
function fmtTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  return new Date(ms + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16);
}
function mfaStatusPayload() {
  const raw = readJsonFile(TOTP_FILE);
  const cfg = loadMfa();
  const enabled = cfg !== null && cfg.enabled;
  const src = (raw !== null && typeof raw === 'object') ? raw : {};
  const all = Array.isArray(src.recoveryCodes) ? src.recoveryCodes : [];
  // 契约 §2.1 (E21, 协调人 2026-09-12 裁决): 未用恢复码条数**与 enabled 无关** —— 停用时若显示 0/8,
  // 用户会以为码丢了而误点「重新生成种子」⇒ 作废验证器 (真实误操作风险)。
  const remaining = all.filter((r) => r !== null && typeof r === 'object' && !r.usedAt).length;
  const devices = Object.entries(loadDevices().devices).map(([id, d]) => ({
    id,
    name: typeof d.name === 'string' ? d.name : id,
    ua: typeof d.ua === 'string' ? d.ua : '',
    ip: typeof d.ip === 'string' ? d.ip : '',
    createdAt: Number.isFinite(d.createdAt) ? d.createdAt : 0,
    lastSeenAt: Number.isFinite(d.lastSeenAt) ? d.lastSeenAt : 0,
    revokedAt: Number.isFinite(d.revokedAt) && d.revokedAt > 0 ? d.revokedAt : null,
  })).sort((a, b) => b.createdAt - a.createdAt);
  const now = Date.now();
  const locks = loadLocks();
  const ips = Object.entries(locks.ips).map(([ip, r]) => ({
    ip,
    level: Number.isFinite(r.level) ? r.level : 0,
    lockUntil: Number.isFinite(r.lockUntil) ? r.lockUntil : 0,
    permanent: r.permanent === true,
    fails: Number.isFinite(r.fails) ? r.fails : 0,
  })).sort((a, b) => b.fails - a.fails);
  return {
    ok: true,
    mfa: {
      enabled,
      fingerprint: enabled ? crypto.createHash('sha256').update(cfg.secret).digest('hex').slice(0, 8) : null,
      createdAt: Number.isFinite(src.createdAt) ? src.createdAt : (enabled ? 0 : null),
      updatedAt: Number.isFinite(src.updatedAt) ? src.updatedAt : (enabled ? 0 : null),
      deviceEpoch: Number.isFinite(src.deviceEpoch) ? Math.floor(src.deviceEpoch) : 1,
      recoveryTotal: 8,
      recoveryRemaining: remaining,
    },
    devices,
    locks: {
      ips,
      global: {
        lockUntil: Number.isFinite(locks.global.lockUntil) ? locks.global.lockUntil : 0,
        fails: locks.global.fails.filter((t) => now - t < GLOBAL_WINDOW_MS).length,
      },
    },
  };
}

// ---------- 设备表操作 ----------
function markDeviceRevoked(id) {
  const devices = loadDevices().devices;
  if (devices[id] === undefined) return false;
  devices[id].revokedAt = Date.now();
  saveDevices();
  return true;
}
function markAllDevicesRevoked() {
  const devices = loadDevices().devices;
  const now = Date.now();
  let n = 0;
  for (const id of Object.keys(devices)) {
    if (!devices[id].revokedAt) { devices[id].revokedAt = now; n += 1; }
  }
  if (n > 0) saveDevices();
  return n;
}

// ---------- 审计 (禁写种子/恢复码/验证码/令牌/cookie 值) ----------
function mfaAudit(action, ip, ua, fields) {
  audit('MFA_ACTION', Object.assign({ action, ip, ua }, fields || {}));
}
function alertMfaChanged(what, ip, ua) {
  sendAuthAlert('auth.mfa_changed', `🔐 MFA ${what}`,
    `动作: ${what} · IP ${ip} · ${ua} · 设备 epoch=${(loadMfa() || { deviceEpoch: 0 }).deviceEpoch} · ${auditStamp()}`);
}

// ---------- 动作面 (契约 §2 动作矩阵) ----------
function mfaReply(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(s),
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(s);
}
// 生成新种子 (enable 的"无种子"分支 与 regenerate 共用; 唯一换种子入口)
function mfaGenerateSeed(alsoRevoke) {
  const prev = readJsonFile(TOTP_FILE);
  const prevEpoch = (prev !== null && typeof prev === 'object' && Number.isFinite(prev.deviceEpoch))
    ? Math.floor(prev.deviceEpoch) : 1;
  const secret = genSecret();
  const codes = genRecoveryCodes(8);
  const now = Date.now();
  const raw = {
    version: 1,
    enabled: true,
    secret,
    algo: 'SHA1',
    digits: 6,
    period: 30,
    deviceEpoch: alsoRevoke ? prevEpoch + 1 : prevEpoch,
    recoveryCodes: codes.map((c) => c.rec),
    usedTotpCounters: [],
    createdAt: now,          // 新种子 ⇒ 新的创建时间
    updatedAt: now,
  };
  const saved = refreshMfaCache(raw);
  plainCache = { secret, codes: codes.map((c) => c.disp) };
  if (alsoRevoke) markAllDevicesRevoked();
  return saved;
}
// 判定 .auth-totp.json 里是否已有可用种子 (enable 的"复用"分支前提)
function hasUsableSeed(raw) {
  return raw !== null && typeof raw === 'object'
    && typeof raw.secret === 'string' && raw.secret.toUpperCase().replace(/[^A-Z2-7]/g, '').length >= 16;
}
function mfaDoAction(action, body, ip, ua) {
  const b = (body !== null && typeof body === 'object') ? body : {};
  const cfg = loadMfa();
  switch (action) {
    case 'status': {
      const st = mfaStatusPayload();
      audit('MFA_VIEW', { ip, ua, enabled: String(st.mfa.enabled), devices: String(st.devices.filter((d) => !d.revokedAt).length) });
      return { code: 200, body: st };
    }
    case 'seed': {
      if (cfg === null || cfg.secret === '') {
        audit('MFA_SECRET_REVEAL', { ip, ua, mfa: 'off', note: 'no-secret' });
        return { code: 200, body: { ok: true, secret: null, otpauth: null, qrSvg: null, recoveryCodes: [], enabled: false } };
      }
      audit('MFA_SECRET_REVEAL', { ip, ua, mfa: cfg.enabled ? 'on' : 'off' });
      return { code: 200, body: seedPayload(cfg) };
    }
    case 'enable': {
      // 契约 §2 (协调人 2026-09-12 裁决): `disable` 保留种子 ⇒ `enable` **不得**换种子,
      // 否则"停用→启用"会让用户的验证器静默失效 (潜在自锁事故)。三分支:
      //   ① 无种子 ⇒ 生成新 secret + 8 新恢复码; ② 有种子且 enabled=false ⇒ 原地置 true (其余字段一律不动);
      //   ③ 已 enabled=true ⇒ 幂等: 不改字段、不写盘 (仍写审计+告警留痕)。
      const prev = readJsonFile(TOTP_FILE);
      if (!hasUsableSeed(prev)) {
        const savedNew = mfaGenerateSeed(false);
        audit('MFA_CHANGED', { enabled: 'true', epoch: String(savedNew.deviceEpoch) });
        mfaAudit(action, ip, ua, { ok: 'true', enabled: 'true', epoch: String(savedNew.deviceEpoch), note: 'new-seed' });
        alertMfaChanged('已启用', ip, ua);
        return { code: 200, body: seedPayload(savedNew, true) };
      }
      if (prev.enabled === true) {   // ③ 幂等: 不改字段、不写盘, 仅留痕
        mfaAudit(action, ip, ua, { ok: 'true', enabled: 'true', note: 'already-enabled' });
        alertMfaChanged('启用请求（已启用，未做改动）', ip, ua);
        const cur = cfg !== null ? cfg : mfaCfgFromRaw(prev);
        return { code: 200, body: seedPayload(cur, true) };
      }
      prev.enabled = true;           // ② 复用种子: 只改 enabled/updatedAt (secret/恢复码/epoch/createdAt/usedTotpCounters 不动)
      prev.updatedAt = Date.now();
      const saved = refreshMfaCache(prev);
      audit('MFA_CHANGED', { enabled: 'true', epoch: String(saved.deviceEpoch) });
      mfaAudit(action, ip, ua, { ok: 'true', enabled: 'true', epoch: String(saved.deviceEpoch), note: 'reuse-seed' });
      alertMfaChanged('已启用（沿用现有种子）', ip, ua);
      return { code: 200, body: seedPayload(saved, true) };
    }
    case 'regenerate': {
      // 唯一换种子入口 (始终换种子)
      const alsoRevoke = b.alsoRevokeDevices === true;
      const saved = mfaGenerateSeed(alsoRevoke);
      audit('MFA_CHANGED', { enabled: 'true', epoch: String(saved.deviceEpoch), reason: alsoRevoke ? 'regenerate+revoke-all' : 'regenerate' });
      mfaAudit(action, ip, ua, { ok: 'true', enabled: 'true', epoch: String(saved.deviceEpoch) });
      alertMfaChanged('重新生成种子', ip, ua);
      return { code: 200, body: seedPayload(saved, true) };
    }
    case 'disable': {
      const raw = readJsonFile(TOTP_FILE);
      if (raw === null || typeof raw !== 'object') {
        mfaAudit(action, ip, ua, { ok: 'true', enabled: 'false', note: 'no-file' });
        return { code: 200, body: { ok: true, enabled: false } };
      }
      raw.enabled = false;     // 保留 secret 与恢复码 (E5: 可再启用, 不换种子)
      raw.updatedAt = Date.now();
      refreshMfaCache(raw);
      audit('MFA_CHANGED', { enabled: 'false', epoch: String(raw.deviceEpoch) });
      mfaAudit(action, ip, ua, { ok: 'true', enabled: 'false' });
      alertMfaChanged('已停用', ip, ua);
      return { code: 200, body: { ok: true, enabled: false } };
    }
    case 'purge': {
      try { fs.unlinkSync(TOTP_FILE); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      mfaCacheOff();
      plainCache = { secret: '', codes: [] };
      const removed = statSafe(TOTP_FILE) === null;
      audit('MFA_CHANGED', { enabled: 'false', reason: 'purge' });
      mfaAudit(action, ip, ua, { ok: String(removed), removed: String(removed) });
      alertMfaChanged('种子文件已删除', ip, ua);
      return { code: 200, body: { ok: true, removed } };
    }
    case 'revokeDevice': {
      const id = typeof b.id === 'string' ? b.id : '';
      if (!/^[0-9a-f]{16}$/.test(id)) return { code: 400, body: { ok: false, error: 'bad-device-id' } };
      if (!markDeviceRevoked(id)) return { code: 404, body: { ok: false, error: 'device-not-found' } };
      audit('MFA_CHANGED', { epoch: String((loadMfa() || { deviceEpoch: 0 }).deviceEpoch), reason: 'revoke-device' });
      mfaAudit(action, ip, ua, { ok: 'true' });
      alertMfaChanged('已吊销设备', ip, ua);
      return { code: 200, body: { ok: true, revoked: id } };
    }
    case 'revokeAll': {
      const raw = readJsonFile(TOTP_FILE);
      if (raw === null || typeof raw !== 'object') {
        mfaAudit(action, ip, ua, { ok: 'false', error: 'mfa-not-configured' });
        return { code: 409, body: { ok: false, error: 'mfa-not-configured' } };
      }
      const epoch = (Number.isFinite(raw.deviceEpoch) ? Math.floor(raw.deviceEpoch) : 1) + 1;
      raw.deviceEpoch = epoch;
      raw.updatedAt = Date.now();
      refreshMfaCache(raw);          // 所有旧 dsh_device cookie 立即失效 (epoch 不匹配)
      markAllDevicesRevoked();       // 设备表同步标记, 页面显示与实际一致
      audit('MFA_CHANGED', { epoch: String(epoch), reason: 'revoke-all' });
      mfaAudit(action, ip, ua, { ok: 'true', epoch: String(epoch) });
      alertMfaChanged('已吊销全部设备', ip, ua);
      return { code: 200, body: { ok: true, deviceEpoch: epoch } };
    }
    case 'unlock': {
      const scope = b.scope === 'ip' ? 'ip' : 'all';
      if (scope === 'ip') {
        const target = (typeof b.ip === 'string' && b.ip !== '') ? b.ip : ip;
        const s = loadLocks();
        const had = s.ips[target] !== undefined;
        if (had) { delete s.ips[target]; saveLocks(); }
        audit('AUTH_UNLOCKED', { ip: target, scope: 'ip', note: 'mfa-admin' });
        mfaAudit(action, ip, ua, { ok: 'true', scope: 'ip' });
        if (had) sendAuthAlert('auth.unlocked', '🔓 锁定已解除', `IP ${target} 的锁定已被管理页解除 · ${auditStamp()}`);
        return { code: 200, body: { ok: true, scope: 'ip' } };
      }
      // scope=all: 删除整个锁定文件 (含永久锁), 内存态同步清空
      try { fs.unlinkSync(LOCK_FILE); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      lockState = emptyLocks(); lockMtime = -1;
      audit('AUTH_UNLOCKED', { scope: 'all', note: 'mfa-admin', ip });
      mfaAudit(action, ip, ua, { ok: 'true', scope: 'all' });
      sendAuthAlert('auth.unlocked', '🔓 锁定已解除', `全部登录锁定(含永久锁)已被管理页解除 · ${auditStamp()}`);
      return { code: 200, body: { ok: true, scope: 'all' } };
    }
    default:
      return { code: 404, body: { ok: false, error: 'unknown-action' } };
  }
}
const MFA_ACTIONS = new Set(['status', 'seed', 'enable', 'regenerate', 'disable', 'purge', 'revokeDevice', 'revokeAll', 'unlock']);
function handleMfaApi(req, res, url, ip) {
  if (req.method !== 'POST') { mfaReply(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
  // CSRF: 浏览器路径若带 Origin, 其 host 必须与 Host 一致 (SameSite=Lax 之外的显式兜底)
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== '') {
    let oh = '';
    try { oh = new URL(origin).host; } catch { oh = ''; }
    if (oh === '' || oh !== String(req.headers.host || '')) {
      audit('MFA_ACTION', { action: 'origin-reject', ip, ua: uaSummary(req) });
      mfaReply(res, 403, { ok: false, error: 'forbidden' });
      return;
    }
  }
  if (!mfaApiAuthed(req)) { mfaReply(res, 401, { ok: false, error: 'unauthorized' }); return; }
  const action = url.pathname.slice('/mfa/api/'.length).replace(/\/+$/, '');
  if (!MFA_ACTIONS.has(action)) { mfaReply(res, 404, { ok: false, error: 'unknown-action' }); return; }
  let raw = '';
  let tooBig = false;
  req.on('data', (c) => { raw += c; if (raw.length > BODY_LIMIT) { tooBig = true; req.destroy(); } });
  req.on('error', () => { /* 客户端断开: 忽略 */ });
  req.on('end', () => {
    if (tooBig) { mfaReply(res, 413, { ok: false, error: 'body-too-large' }); return; }
    let body = {};
    if (raw !== '') {
      try { body = JSON.parse(raw); } catch { mfaReply(res, 400, { ok: false, error: 'bad-json' }); return; }
    }
    const ip2 = clientIp(req);   // 同一次请求内取一次即可 (保持与外部一致)
    try {
      const out = mfaDoAction(action, body, ip2, uaSummary(req));
      mfaReply(res, out.code, out.body);
    } catch (e) {
      console.error(`[auth] /mfa/api/${action} 异常:`, e.message);
      mfaAudit(action, ip2, uaSummary(req), { ok: 'false', error: e.message.slice(0, 120) });
      mfaReply(res, 500, { ok: false, error: 'internal-error' });
    }
  });
}

// ---------- /mfa 页面 (自渲染, 内联 CSS/JS, 无外链/无 CDN, 不依赖 dsh) ----------
// 钩子与文案冻结于契约 §3; 首屏**不含**任何种子/恢复码明文 (只渲染空占位, 点击后才 fetch)。
const MFA_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { min-height: 100vh; padding: 30px 14px; background: linear-gradient(160deg,#0f1420,#1a2332);
         font-family: -apple-system,"PingFang SC","Microsoft YaHei",sans-serif; color: #111; }
  .card { max-width: 580px; margin: 0 auto; padding: 28px 26px; border-radius: 16px;
          background: rgba(255,255,255,.62); border: 1px solid rgba(255,255,255,.45);
          -webkit-backdrop-filter: blur(18px) saturate(1.4); backdrop-filter: blur(18px) saturate(1.4);
          box-shadow: 0 12px 40px rgba(0,0,0,.35); }
  h1 { font-size: 20px; margin-bottom: 6px; }
  h2 { font-size: 14px; color: #444; margin: 20px 0 6px; }
  p.sub { font-size: 13px; color: #666; line-height: 1.6; margin-bottom: 16px; }
  .stat { display: flex; flex-wrap: wrap; gap: 8px 20px; font-size: 13px; color: #444; }
  .stat b { font-weight: 600; color: #111; }
  .mono { font-family: ui-monospace,"SF Mono",Consolas,monospace; }
  button { padding: 9px 14px; border: 0; border-radius: 8px; background: #4d6bfe; color: #fff; font-size: 13.5px; cursor: pointer; }
  button:hover { background: #3d59e0; }
  button.ghost { background: rgba(255,255,255,.75); color: #444; border: 1px solid rgba(0,0,0,.12); }
  button.ghost:hover { background: rgba(255,255,255,.95); }
  button.danger { background: #fdeaea; color: #c0392b; border: 1px solid rgba(192,57,43,.35); }
  button.danger:hover { background: #fbdcdc; }
  button[disabled] { background: #4d6bfe; opacity: .45; cursor: not-allowed; }
  button.small { padding: 5px 10px; font-size: 12.5px; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  .risk { margin-top: 14px; padding: 9px 11px; border-radius: 8px; background: rgba(255,248,230,.92);
          border: 1px solid #f0d48a; color: #8a6d1a; font-size: 13px; line-height: 1.5; }
  #mfa-msg { display: none; margin-top: 14px; padding: 8px 10px; border-radius: 8px;
             background: #fdeaea; color: #c0392b; font-size: 13px; line-height: 1.5; }
  #mfa-msg.ok { background: rgba(232,246,238,.95); border: 1px solid #8fcea8; color: #1f7a45; }
  details { margin-top: 14px; padding: 10px 12px; border-radius: 8px; background: rgba(255,255,255,.5);
            border: 1px solid rgba(0,0,0,.12); }
  summary { cursor: pointer; font-size: 13.5px; color: #444; }
  .secret { display: block; margin: 10px 0 4px; padding: 10px 12px; border-radius: 8px; background: rgba(255,255,255,.75);
            border: 1px solid rgba(0,0,0,.12); font-size: 15px; user-select: all; word-break: break-all; }
  #seed-qr svg { width: 168px; height: 168px; background: #fff; padding: 4px; border-radius: 8px; margin-top: 8px; }
  /* Stage 4 (契约 §5 / 用户裁定⑤): 二维码卡片里的 DSH 品牌小图标; 图标缺失时 onerror 隐藏自身 (不破坏二维码降级路径) */
  #seed-qr-brand { display: block; width: 20px; height: 20px; margin-top: 8px; border-radius: 5px; opacity: .9; }
  #recovery-list { margin: 6px 0 0 20px; font-size: 14px; }
  #recovery-list li { margin: 3px 0; }
  .empty { font-size: 12.5px; color: #666; line-height: 1.6; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 12.5px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid rgba(0,0,0,.08); }
  th { color: #666; font-weight: 500; }
  .revoked { color: #c0392b; }
  .link { display: inline-block; margin-top: 18px; font-size: 12.5px; color: #4d6bfe; text-decoration: none; }
  .link:hover { text-decoration: underline; }`;
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function devCountText(st) {
  const live = st.devices.filter((d) => !d.revokedAt).length;
  return `${live} 台设备 · 恢复码 ${st.mfa.recoveryRemaining}/8`;
}
function deviceRowsHtml(devices) {
  if (devices.length === 0) return '<tr><td colspan="4" class="empty">暂无已信任设备</td></tr>';
  return devices.map((d) => `<tr data-device-id="${esc(d.id)}">`
    + `<td>${esc(d.name)}</td><td class="mono">${esc(d.ip)}</td>`
    + `<td>${d.revokedAt ? '<span class="revoked">已吊销</span>' : fmtTime(d.lastSeenAt)}</td>`
    + `<td>${d.revokedAt ? '' : `<button class="ghost small" data-revoke="${esc(d.id)}">吊销</button>`}</td></tr>`).join('');
}
function lockRowsHtml(locks) {
  const now = Date.now();
  const rows = locks.ips.filter((r) => r.fails > 0);
  if (rows.length === 0 && locks.global.lockUntil <= now) return '<tr><td colspan="4" class="empty">当前没有锁定记录</td></tr>';
  const out = rows.map((r) => {
    const active = r.permanent || r.lockUntil > now;
    const until = r.permanent ? '永久' : (r.lockUntil > now ? fmtTime(r.lockUntil) : '已到期');
    return `<tr data-lock-ip="${esc(r.ip)}"><td class="mono">${esc(r.ip)}</td>`
      + `<td>${r.fails} 次 / 档位 ${r.level}${active ? '' : '（未锁定）'}</td><td>${until}</td>`
      + `<td><button class="ghost small" data-unlock-ip="${esc(r.ip)}">解除</button></td></tr>`;
  }).join('');
  const g = locks.global.lockUntil > now
    ? `<tr data-lock-ip="__global__"><td>全站</td><td>1 小时窗口失败 ${locks.global.fails} 次</td><td>${fmtTime(locks.global.lockUntil)}</td><td></td></tr>` : '';
  return out + g;
}
const MFA_JS = `
(function () {
  var msg = document.getElementById('mfa-msg');
  function show(text, ok) {
    if (!msg) return;
    msg.textContent = text;
    msg.className = ok ? 'ok' : '';
    msg.style.display = 'block';
  }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function api(action, body) {
    return fetch('/mfa/api/' + action, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'bad-response' }; });
    }, function () { return { ok: false, error: 'network' }; });
  }
  function setText(id, text) { var el = document.getElementById(id); if (el) el.textContent = text; }
  function renderSecret(d) {
    var box = document.getElementById('seed-box');
    var sec = document.getElementById('seed-secret');
    var qr = document.getElementById('seed-qr');
    var list = document.getElementById('recovery-list');
    if (sec) sec.textContent = d.secret || '—';
    if (qr) {
      qr.innerHTML = d.qrSvg ? d.qrSvg : '<div class="empty">二维码不可用，请手动输入下方 base32</div>';
    }
    var codes = d.recoveryCodes || [];
    if (list) {
      var lis = list.getElementsByTagName('li');
      for (var i = 0; i < lis.length; i++) {
        if (codes[i]) lis[i].textContent = codes[i];
        else if (i === 0 && codes.length === 0) lis[i].textContent = '（明文仅在本进程生成时可用，请点「重新生成种子」）';
        else lis[i].textContent = '—';
      }
    }
    if (box) box.open = true;
  }
  function applyStatus(st) {
    var m = st.mfa || {};
    setText('mfa-state', m.enabled ? '已启用' : '未启用');
    setText('mfa-fp', m.fingerprint || '—');
    var live = (st.devices || []).filter(function (d) { return !d.revokedAt; });
    setText('mfa-devcount', live.length + ' 台设备 · 恢复码 ' + (m.recoveryRemaining || 0) + '/8');
    window.__MFA_HAS_SEED = (m.createdAt !== null && m.createdAt !== undefined);
    var en2 = document.getElementById('btn-enable');
    if (en2) {
      en2.disabled = m.enabled === true;
      en2.title = m.enabled === true ? '已启用；如需更换种子请用「重新生成种子」' : '';
    }
    var tb = document.getElementById('mfa-devices');
    if (tb) {
      var ds = st.devices || [];
      if (ds.length === 0) { tb.innerHTML = '<tr><td colspan="4" class="empty">暂无已信任设备</td></tr>'; }
      else {
        tb.innerHTML = ds.map(function (d) {
          var when = d.revokedAt ? '<span class="revoked">已吊销</span>' : fmt(d.lastSeenAt);
          var btn = d.revokedAt ? '' : '<button class="ghost small" data-revoke="' + esc(d.id) + '">吊销</button>';
          return '<tr data-device-id="' + esc(d.id) + '"><td>' + esc(d.name) + '</td><td class="mono">' + esc(d.ip)
            + '</td><td>' + when + '</td><td>' + btn + '</td></tr>';
        }).join('');
      }
    }
  }
  function fmt(ms) {
    if (!ms) return '—';
    var d = new Date(ms + 8 * 3600 * 1000);
    return d.toISOString().replace('T', ' ').slice(0, 16);
  }
  function refresh() { api('status').then(function (d) { if (d && d.ok) applyStatus(d); }); }
  var reveal = document.getElementById('btn-reveal-seed');
  if (reveal) reveal.addEventListener('click', function () {
    reveal.disabled = true;
    api('seed').then(function (d) {
      reveal.disabled = false;
      if (!d.ok) { show('读取失败：' + (d.error || 'unknown'), false); return; }
      renderSecret(d);
      show('已显示当前种子与未用恢复码（请离线抄写）', true);
    });
  });
  var en = document.getElementById('btn-enable');
  if (en) en.addEventListener('click', function () {
    if (en.disabled) return;
    var tip = window.__MFA_HAS_SEED === true
      ? '启用二次验证？将沿用现有种子，旧验证器继续可用。'
      : '启用二次验证？启用后未信任设备登录需要验证码。';
    if (!confirm(tip)) return;
    api('enable').then(function (d) {
      if (!d.ok) { show('启用失败：' + (d.error || 'unknown'), false); return; }
      renderSecret(d);
      refresh();
      show(window.__MFA_HAS_SEED === true ? '已启用（沿用现有种子，未信任设备登录需验证码）' : '已启用；请立即扫码并抄写恢复码', true);
    });
  });
  var dis = document.getElementById('btn-disable');
  if (dis) dis.addEventListener('click', function () {
    api('disable').then(function (d) {
      if (!d.ok) { show('停用失败：' + (d.error || 'unknown'), false); return; }
      refresh(); show('已停用（种子与恢复码保留，登录回到仅密码）', true);
    });
  });
  var reg = document.getElementById('btn-regenerate');
  if (reg) reg.addEventListener('click', function () {
    if (!confirm('重新生成种子会立即作废旧验证器与未显示的恢复码。确定继续？')) return;
    var also = confirm('是否同时吊销所有已信任设备？（确定=全部设备下次登录需重新验证）');
    api('regenerate', { alsoRevokeDevices: also }).then(function (d) {
      if (!d.ok) { show('重生成失败：' + (d.error || 'unknown'), false); return; }
      renderSecret(d); refresh();
      show(also ? '已重生成种子并吊销全部设备；请重新扫码' : '已重生成种子；请重新扫码', true);
    });
  });
  var purge = document.getElementById('btn-purge');
  if (purge) purge.addEventListener('click', function () {
    if (!confirm('删除种子文件将彻底清除二次验证（恢复码一并失效），且无法撤销。确定删除？')) return;
    api('purge').then(function (d) {
      if (!d.ok) { show('删除失败：' + (d.error || 'unknown'), false); return; }
      var box = document.getElementById('seed-box');
      if (box) { box.open = false; }
      renderSecret({ secret: '', qrSvg: null, recoveryCodes: [] });
      if (box) box.open = false;
      refresh(); show('种子文件已删除，二次验证已停用', true);
    });
  });
  var rav = document.getElementById('btn-revoke-all');
  if (rav) rav.addEventListener('click', function () {
    if (!confirm('吊销全部设备后，所有设备下次登录都需要重新输入验证码。确定继续？')) return;
    api('revokeAll').then(function (d) {
      if (!d.ok) { show('吊销失败：' + (d.error || 'unknown'), false); return; }
      refresh(); show('已吊销全部设备（epoch=' + d.deviceEpoch + '）', true);
    });
  });
  var ua = document.getElementById('btn-unlock-all');
  if (ua) ua.addEventListener('click', function () {
    if (!confirm('解除所有登录锁定（含永久锁）？确定继续？')) return;
    api('unlock', { scope: 'all' }).then(function (d) {
      if (!d.ok) { show('解除失败：' + (d.error || 'unknown'), false); return; }
      show('已解除全部登录锁定', true);
      setTimeout(function () { location.reload(); }, 400);
    });
  });
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t || !t.getAttribute) return;
    var rid = t.getAttribute('data-revoke');
    if (rid) {
      api('revokeDevice', { id: rid }).then(function (d) {
        if (!d.ok) { show('吊销失败：' + (d.error || 'unknown'), false); return; }
        refresh(); show('该设备已吊销', true);
      });
      return;
    }
    var uip = t.getAttribute('data-unlock-ip');
    if (uip) {
      api('unlock', { scope: 'ip', ip: uip }).then(function (d) {
        if (!d.ok) { show('解除失败：' + (d.error || 'unknown'), false); return; }
        refresh(); show('已解除 ' + uip + ' 的锁定', true);
      });
    }
  });
})();`;
function mfaPage(st) {
  const placeholders = Array.from({ length: 8 }, () => '<li></li>').join('');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH 登录二次验证</title>
<style>${MFA_CSS}</style></head><body>
<div class="card">
  <h1>登录二次验证</h1>
  <p class="sub">本页由 auth-proxy 自行渲染，不依赖 dsh：即使服务异常，也能在这里扫码或解除锁定。</p>
  <div class="stat">
    <div>状态：<b id="mfa-state">${st.mfa.enabled ? '已启用' : '未启用'}</b></div>
    <div>种子指纹：<b class="mono" id="mfa-fp">${st.mfa.fingerprint === null ? '—' : esc(st.mfa.fingerprint)}</b></div>
    <div><b id="mfa-devcount">${esc(devCountText(st))}</b></div>
  </div>
  <div class="row">
    <button id="btn-enable"${st.mfa.enabled === true ? ' disabled title="已启用；如需更换种子请用「重新生成种子」"' : ''}>启用</button>
    <button id="btn-disable" class="ghost">停用</button>
    <button id="btn-regenerate" class="ghost">重新生成种子</button>
    <button id="btn-purge" class="danger">删除种子文件</button>
  </div>
  <div class="risk">本页任何可打开的人都能看到种子与恢复码；请离线抄写，不要截图/发聊天</div>
  <details id="seed-box">
    <summary id="btn-reveal-seed">显示种子与恢复码</summary>
    <div class="empty" style="margin-top:8px">种子与恢复码不会随首屏下发：点击上方标题后才从服务端读取。</div>
    <div id="seed-qr"></div>
    <img id="seed-qr-brand" src="/dsh-icon-512.png" alt="DSH" width="20" height="20" aria-hidden="true" onerror="this.style.display='none'">
    <code class="secret mono" id="seed-secret"></code>
    <h2>一次性恢复码（各用一次，8 个）</h2>
    <ol id="recovery-list">${placeholders}</ol>
    <div class="empty" style="margin-top:6px">已用或未显示过的码不可找回；需要补齐请点「重新生成种子」。</div>
  </details>
  <h2>已信任设备</h2>
  <table><thead><tr><th>设备</th><th>IP</th><th>最近使用</th><th></th></tr></thead>
    <tbody id="mfa-devices">${deviceRowsHtml(st.devices)}</tbody></table>
  <div class="row"><button id="btn-revoke-all" class="danger">吊销全部设备</button></div>
  <h2>登录锁定</h2>
  <table><thead><tr><th>范围</th><th>失败/档位</th><th>解除时间</th><th></th></tr></thead>
    <tbody id="mfa-locks">${lockRowsHtml(st.locks)}</tbody></table>
  <div class="row"><button id="btn-unlock-all" class="danger">解除所有登录锁定</button></div>
  <div id="mfa-msg"></div>
  <a class="link" href="/">← 返回 DeepSeek Harness</a>
</div>
<script>window.__MFA_HAS_SEED=${st.mfa.createdAt === null || st.mfa.createdAt === undefined ? 'false' : 'true'};</script>
<script>${MFA_JS}</script>
</body></html>`;
}

// ---------- 转发到 dsh web (改写 Host/Origin 通过信任围栏) ----------
function upstreamOptions(req) {
  const u = new URL(UPSTREAM);
  const headers = Object.assign({}, req.headers);
  headers.host = u.host;     // 围栏要求 Host 为回环 (dsh 只认 loopback)
  headers.origin = u.origin; // 围栏要求 Origin 与 Host 同源
  headers['x-forwarded-for'] = clientIp(req);
  injectDshCookie(headers);  // 注入容器内换来的 dsh 浏览器会话 cookie (见上)
  return { hostname: u.hostname, port: u.port || 80, path: req.url, method: req.method, headers };
}

function proxy(req, res, retried = false) {
  const opts = upstreamOptions(req);
  // 去掉 hop-by-hop 头, 让 Node 自己管理连接与分块编码
  for (const h of ['connection', 'transfer-encoding', 'keep-alive', 'proxy-connection', 'upgrade']) {
    delete opts.headers[h];
  }
  const preq = http.request(opts, (pres) => {
    // 下游(浏览器)已断开则直接中止上游, 不再索要数据
    if (res.destroyed || res.writableEnded) { preq.destroy(); return; }
    // dsh 会话 cookie 失效 (过期/密钥轮换/进程重启后换了 token) → 自动重换一次再重试。
    // 只对无请求体的方法重试, 避免重放 body。
    if (pres.statusCode === 401 && !retried && (req.method === 'GET' || req.method === 'HEAD')) {
      pres.resume();
      dlog('upstream-401', req.url, '-> 重新换取 dsh cookie 后重试');
      ensureDshCookie(true).then((pair) => {
        if (pair === null) {
          if (!res.headersSent && !res.destroyed) {
            res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end('dsh web authentication required\n');
          }
          return;
        }
        proxy(req, res, true);
      });
      return;
    }
    res.writeHead(pres.statusCode, pres.headers);
    pres.pipe(res);
    // 上游(web)响应异常中断 → 关下游
    pres.on('error', () => res.destroy());
  });
  preq.on('error', () => {
    // 上游不可达/中断: 未发响应头则回 502, 否则关下游
    if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('502 Bad Gateway: upstream dsh web not reachable'); }
    else res.destroy();
  });
  // 下游(浏览器)断开/异常 → 就地消化 EPIPE/ECONNRESET (不再 unhandled 崩溃),
  // 并中止上游请求, 避免 dsh web 持续向无人读取的连接写数据; 连接关闭走 dsh web
  // 官方正常路径, 不会影响其它进行中的回合。
  res.on('error', () => preq.destroy());
  res.on('close', () => { if (!res.writableFinished) preq.destroy(); });
  req.on('error', () => preq.destroy());
  // 重试路径: 入站 GET/HEAD 已结束, 不再 pipe (避免对已结束流重复 pipe)
  if (retried) preq.end(); else req.pipe(preq);
}

// ---------- WebSocket 升级转发 ----------
// dsh 的实时事件流走 /api/remote.mux 一条 WebSocket 下行连接 (dsh 0.1.2 起;
// 更早版本的 /api/events.mux 与 /api/events.host 已不存在, 2026-09-11 VM 实测确认),
// 普通 HTTP 代理不处理 Upgrade 请求, 必须单独转发 (否则界面无实时更新, 只能刷新看进度)
function handleUpgrade(req, socket, head, retried = false) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const reject = (code, msg) => {
    dlog('ws-reject', url.pathname, 'from', clientIp(req), '->', msg);
    socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };

  // 校验会话 (与普通请求一致)
  if (authOn && !readCookie(req)) {
    reject(401, 'Unauthorized');
    return;
  }

  const start = () => {
    const opts = upstreamOptions(req); // 保留 Connection: upgrade / Upgrade: websocket (+ 注入 dsh cookie)
    const wreq = http.request(opts);
    wreq.on('upgrade', (upRes, upSocket, upHead) => {
      // 把上游的 101 响应与后续双向数据转发给客户端
      const statusLine = `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage || 'Switching Protocols'}\r\n`;
      let headerStr = '';
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (Array.isArray(v)) v.forEach((x) => { headerStr += `${k}: ${x}\r\n`; });
        else headerStr += `${k}: ${v}\r\n`;
      }
      socket.write(statusLine + headerStr + '\r\n');
      socket.write(upHead);
      upSocket.write(head);
      upSocket.pipe(socket);
      socket.pipe(upSocket);
      // 任一端断开/异常 → 消化 EPIPE/ECONNRESET (不再 unhandled 崩溃) 并关闭另一端;
      // 断开传导到 dsh web 走 WS 官方正常关闭路径, 不影响其它回合。
      const teardown = () => { upSocket.destroy(); socket.destroy(); };
      upSocket.on('error', teardown);
      socket.on('error', teardown);
      upSocket.on('close', () => socket.destroy());
      socket.on('close', () => upSocket.destroy());
    });
    // 上游没有升级而是回了 HTTP 响应 (401 = dsh 会话失效): 重换一次 cookie 再试一次,
    // 否则把状态码原样回给客户端并关闭。
    wreq.on('response', (pres) => {
      if (pres.statusCode === 401 && !retried) {
        pres.resume();
        dlog('ws-401', url.pathname, '-> 重新换取 dsh cookie 后重试');
        ensureDshCookie(true).then((pair) => {
          if (pair === null) { reject(401, 'Unauthorized'); return; }
          handleUpgrade(req, socket, head, true);
        });
        return;
      }
      reject(pres.statusCode || 502, 'Upstream-Rejected');
    });
    wreq.on('error', () => socket.destroy());
    wreq.end();
  };

  // 先确保 dsh 会话 cookie 就绪 (缺失时也照常试, 保持旧的 401 行为)
  ensureDshCookie().then(start, start);
}

// ---------- 主服务 ----------
function clientIp(req) {
  // 走 Cloudflare Tunnel 时所有请求都来自 cloudflared 的同一 IP,
  // 用 Cf-Connecting-Ip 取真实客户端 IP (用于防爆破和 X-Forwarded-For)
  return String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?');
}

const handler = (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const ip = clientIp(req);
  const host = req.headers.host || '';
  // 明文 HTTP + 非 localhost + 非隧道 -> 提示改用 HTTPS (安全上下文问题)
  const insecureLan = !req.socket.encrypted
    && !/^(localhost|127\.0\.0\.1|::1|\[::1\])(:\d+)?$/i.test(host)
    && !req.headers['cf-connecting-ip'];

  // 无认证模式: 纯转发
  if (!authOn) { proxy(req, res); return; }

  // 登录/登出 (2026-09-12 Stage 2: 密码 → 验证码 两步 + 设备信任 + 多档锁定)
  if (url.pathname === '/login') {
    const step = url.searchParams.get('step') === 'code' ? 'code' : '';
    const errRaw = url.searchParams.get('err') || '';
    const mfa = mfaOn();
    const now = Date.now();
    // Stage 3: `next` 只允许 `/mfa` (其它值一律忽略 ⇒ 防开放重定向, 决策 E2);
    //   密码态与验证码态的表单 action 都带上它, 完整认证走完后才跳转。
    const next = url.searchParams.get('next') === '/mfa' ? '/mfa' : '';
    const nextQ = next === '/mfa' ? '&next=/mfa' : '';
    // Stage 4: 发码唯一入口 `POST /login?step=code&action=send-otp` (契约 §4.1)。
    //   返回 JSON (非 303); 门禁顺序在 handleSendOtp 内逐条实现。非 POST ⇒ 405。
    if (url.searchParams.get('action') === 'send-otp') {
      if (req.method !== 'POST') { mfaReply(res, 405, { ok: false, error: 'method_not_allowed' }); return; }
      handleSendOtp(req, res, ip);
      return;
    }
    if (req.method === 'POST') {
      const cfg = loadMfa();
      const lock = lockStatus(ip, now);
      // 已信任设备不受锁定影响 (契约 §0.3: 也是永久锁的自锁兜底)
      const trusted = (mfa && cfg !== null) ? deviceTrusted(req, cfg) : null;
      if (lock !== null && trusted === null) {
        // 锁定期间: 密码与验证码都不收
        audit('LOGIN_LOCKED', { ip, ua: uaSummary(req), scope: lock.scope, level: String(lock.level) });
        res.writeHead(303, { Location: `/login?err=locked${nextQ}` }); res.end(); return;
      }
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > BODY_LIMIT) req.destroy(); });
      req.on('end', () => {
        const params = new URLSearchParams(body);
        const ua = uaSummary(req);
        const failLogin = (reason, loc) => {
          recordFail(ip, reason);
          sendAuthAlert('auth.login_failed', '⚠️ 登录失败',
            `IP ${ip} · ${ua} · ${auditStamp()}\n原因: ${reason}`);
          res.writeHead(303, { Location: loc }); res.end();
        };
        const success = (info) => {
          const i = info || {};
          clearFails(ip);
          audit('LOGIN_OK', Object.assign({ user: i.user || '', ip, ua }, i.audit || {}));
          const token = sign({ exp: Date.now() + SESSION_DAYS * 86400 * 1000 });
          // 登录即预热 dsh 会话 cookie, 让随后的 303 → / 一次到位 (免控制台 token)
          void ensureDshCookie(true);
          const cookies = [sessionCookie(token), clearNamedCookie(PREAUTH_COOKIE)];
          if (typeof i.deviceCookie === 'string') cookies.push(i.deviceCookie);
          // Stage 3: 完整认证 (口令 + 第二因子全流程) 走完才跳 next; next 只可能是 '/' 或 '/mfa'
          res.writeHead(303, { Location: next === '/mfa' ? '/mfa' : '/', 'Set-Cookie': cookies });
          res.end();
        };
        // 新设备过验证码 → 签发设备信任 + 告警 (恢复码登录也走这条, 正文标注)
        let otpTriesUsed = 0;   // Stage 4: 一次性码登录时记录本次用掉前已错的次数 (审计 OTP_USED)
        const newDevice = (kind, cfg2) => {
          const dev = registerDevice(req, ip);
          audit(kind === 'recovery' ? 'MFA_RECOVERY_USED' : 'MFA_NEW_DEVICE', { ip, ua, device: dev.name });
          if (kind === 'otp') audit('OTP_USED', { ip, ua, device: dev.name, triesUsed: String(otpTriesUsed) });
          sendAuthAlert('auth.new_device', '✅ 新设备登录通过',
            `IP ${ip} · ${ua} · ${auditStamp()}\n设备: ${dev.name}${kind === 'recovery' ? ' (使用恢复码)' : ''}`);
          success({ mfa: kind, deviceCookie: deviceCookieHeader(dev.id, cfg2.deviceEpoch) });
        };

        if (step === 'code') {
          // 验证码步骤: 需要有效预认证 cookie (密码已通过的同一 IP, 5 分钟内)
          if (!preauthOk(req, ip)) { res.writeHead(303, { Location: `/login?err=1${nextQ}` }); res.end(); return; }
          // 边角: 验证码步骤进行中 MFA 被停用 (种子文件删掉) ⇒ 口令已验证过, 直接完成登录
          // (否则会一直"验证码错误"并持续累计失败计数, 最终把用户锁死 —— 违背"绝不半途锁死")
          if (!mfa || cfg === null) { success({ mfa: 'off', audit: { note: 'mfa-disabled-midflow' } }); return; }
          const code = params.get('code') || '';
          // Stage 4 (契约 §4.3): 先验证器/恢复码 (现状不动), 再一次性码; 任一通过 ⇒ 既有 newDevice 路径。
          const kind = verifyMfaCode(cfg, code);
          if (kind !== null) { newDevice(kind, cfg); return; }
          const otpRes = verifyOtpCode(ip, ua, code);
          if (otpRes === null) {
            // 失败共用同一条既有失败路径: 恰计 1 次 recordFail (F9: **禁止**为 OTP 另立计数器)
            audit('LOGIN_CODE_FAIL', { ip, ua, step: 'code' });
            failLogin('验证码错误', `/login?step=code&err=2${nextQ}`);
            return;
          }
          otpTriesUsed = otpRes.triesUsed;
          newDevice('otp', cfg);
          return;
        }

        const u = params.get('username') || '', p = params.get('password') || '';
        if (!checkCreds(u, p)) {
          audit('LOGIN_FAIL', { user: u, ip, ua });
          failLogin('密码错误', `/login?err=1${nextQ}`);
          return;
        }
        if (!mfa || cfg === null) { success({ user: u, audit: { mfa: 'off' } }); return; }   // 回滚态: 与加 MFA 之前一致
        if (trusted !== null) {   // 已信任设备: 只输密码
          const devices = loadDevices().devices;
          if (devices[trusted.id] !== undefined) { devices[trusted.id].lastSeenAt = Date.now(); saveDevices(); }
          success({ user: u, audit: { mfa: 'trusted' } });
          return;
        }
        const code = params.get('code') || '';
        if (code === '') {
          // 密码已通过 → 只签发 5 分钟预认证 cookie, 密码不落任何后续形态
          res.writeHead(303, { Location: `/login?step=code${nextQ}`, 'Set-Cookie': preauthCookieHeader(ip) });
          res.end(); return;
        }
        const kind = verifyMfaCode(cfg, code);
        if (kind === null) { audit('LOGIN_CODE_FAIL', { ip, ua, step: 'password' }); failLogin('验证码错误', `/login?step=code&err=2${nextQ}`); return; }
        newDevice(kind, cfg);
      });
      return;
    }
    // GET /login
    if (readCookie(req)) { res.writeHead(302, { Location: '/' }); res.end(); return; }
    const cfgGet = loadMfa();
    const trustedGet = (mfa && cfgGet !== null) ? deviceTrusted(req, cfgGet) : null;
    const lockGet = lockStatus(ip, now);
    if (lockGet !== null && trustedGet === null) { sendLogin(res, { insecureLan, lock: lockGet, next }); return; }
    if (step === 'code') {
      if (!preauthOk(req, ip)) { res.writeHead(302, { Location: '/login' }); res.end(); return; }
      // Stage 4: 按钮仅在 otpEnabled && !locked && mfa 时渲染 (契约 §5); 关闭态只多一个空的 hidden #otp-msg
      sendLogin(res, { insecureLan, mfa, step: 'code', err: errRaw === '2' ? 2 : 0, next, otp: mfa && lockGet === null && otpOn() });
      return;
    }
    sendLogin(res, { insecureLan, mfa, err: errRaw === '1' ? 1 : 0, next });
    return;
  }
  if (url.pathname === '/logout') {
    audit('LOGOUT', { ip, ua: uaSummary(req) });
    res.writeHead(302, { Location: '/login', 'Set-Cookie': clearCookie() });
    res.end();
    return;
  }

  // MFA 管理页 + 管理 API (2026-09-12 Stage 3): 自渲染, **必须在反向代理分支之前**处理,
  // 且不依赖 dsh (dsh 停掉时 /mfa 仍可用 —— "挂了也能自救")。
  if (url.pathname === '/mfa') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
      res.end('method not allowed\n');
      return;
    }
    if (!readCookie(req)) {   // 无有效会话 (含无 t 字段的旧会话一样有效) ⇒ 去登录页, 带上 next
      res.writeHead(303, { Location: '/login?next=/mfa' });
      res.end();
      return;
    }
    try {
      const st = mfaStatusPayload();
      audit('MFA_VIEW', { ip, ua: uaSummary(req), enabled: String(st.mfa.enabled), devices: String(st.devices.filter((d) => !d.revokedAt).length) });
      const html = mfaPage(st);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : html);
    } catch (e) {
      console.error('[auth] /mfa 页面渲染失败:', e.message);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('mfa page error\n');
    }
    return;
  }
  if (url.pathname.startsWith('/mfa/api/')) { handleMfaApi(req, res, url, ip); return; }

  // 免登录放行路径:
  //  - PWA 静态资源: manifest/图标/favicon 必须无 Cookie 也能获取
  //    (iOS 添加到主屏幕/浏览器抓 favicon 时通常不带会话 Cookie, 拦截会导致图标加载失败)
  //  - /public/ 公开分享区: dsh-fileserve 的免登录路由, 只服务 /workspace/public/ 目录。
  //    注意: 本白名单只负责"放行进 dsh web", 越界防护 (目录穿越/符号链接逃逸)
  //    由插件端对 public 根目录做 resolve+realpath 双重校验兜底, 不依赖这里的前缀匹配。
  //  - /bing-wallpaper /wallpaper-folder: 登录页背景图端点 (与聊天背景同一壁纸源,
  //    未登录时登录页也要能加载; 仅壁纸图片, 无敏感数据)。前缀匹配会连带
  //    -meta 介绍端点 (title/body/图片URL, 无敏感信息, 可接受)。
  const PUBLIC_PATHS = ['/manifest.webmanifest', '/apple-touch-icon.png', '/dsh-icon-512.png', '/favicon.svg', '/favicon.ico', '/public/', '/bing-wallpaper', '/wallpaper-folder'];
  if (PUBLIC_PATHS.some((p) => url.pathname === p || url.pathname.startsWith(p))) {
    proxy(req, res);
    return;
  }

  // 其余路径: 校验会话
  const session = readCookie(req);
  if (!session) {
    // 调试用: 区分"浏览器没发 Cookie" vs "Cookie 有但签名/过期无效"
    dlog('session-reject', url.pathname, 'from', ip, '->', req.headers.cookie ? 'cookie-present-but-invalid' : 'cookie-missing');
    res.writeHead(302, { Location: '/login' }); res.end(); return;
  }
  proxy(req, res);
};

// ---------- HTTP + HTTPS 双端口 ----------
const servers = [];
const httpServer = http.createServer(handler);
httpServer.on('upgrade', handleUpgrade); // WebSocket 实时事件流
servers.push(httpServer);
httpServer.listen(HTTP_PORT, LISTEN_HOST, () => {
  console.log(`auth-proxy: http  ${LISTEN_HOST}:${HTTP_PORT} (隧道回源/SSH隧道/localhost用) -> ${UPSTREAM}${authOn ? ' (auth ON)' : ' (auth OFF, 仅限可信局域网)'}`);
});

if (useTls) {
  const https = require('https');
  const httpsServer = https.createServer(
    { key: fs.readFileSync(TLS_KEY), cert: fs.readFileSync(TLS_CERT) },
    handler
  );
  httpsServer.on('upgrade', handleUpgrade);
  servers.push(httpsServer);
  httpsServer.listen(HTTPS_PORT, LISTEN_HOST, () => {
    console.log(`auth-proxy: https ${LISTEN_HOST}:${HTTPS_PORT} (局域网直连用, 自签名证书) -> ${UPSTREAM}`);
  });
}

function shutdown() {
  servers.forEach((s) => s.close(() => process.exit(0)));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ---------- 启动预热 ----------
// dsh web 与代理同时启动, 写 token 文件的插件也要几秒才就绪 → 这里每 5s 重试一次 (最多 1 分钟),
// 让容器刚起来时的第一波外部访问就已经带好 dsh 会话 cookie。失败不影响服务:
// 真正请求时还有上游 401 自愈路径, 最坏退回"用 dsh web 打印的 ?token= URL 打开一次"。
(function warmDshCookie(attempt) {
  Promise.resolve(ensureDshCookie(true)).then((pair) => {
    if (pair !== null || attempt >= 12) return;
    setTimeout(() => warmDshCookie(attempt + 1), 5000);
  }, () => {});
})(0);

// 安全内核启动自检 (2026-09-12, Stage 2; Stage 3 追加 /mfa 与令牌面): 一行看清
// MFA 开关/限速档/锁表残留/告警设备数/管理面令牌状态, 供部署后与重启后验证直接 grep。
// 任何异常都不影响服务启动。
(function reportSecurityState() {
  try {
    loadOrCreateMfaToken();   // Stage 3: 令牌文件不存在则生成 (0600 / 32 hex); 失败只禁用令牌路径
    const cfg = loadMfa();
    const on = cfg !== null && cfg.enabled;
    const locks = loadLocks();
    const lockedIps = Object.keys(locks.ips).length;
    const hub = loadHub();
    const usable = on ? cfg.recoveryCodes.filter((r) => r !== null && !r.usedAt).length : 0;
    console.log('auth-proxy: 安全内核'
      + ` TOTP=${on ? 'ON' : 'OFF'}`
      + (on ? ` (${cfg.digits} 位/${cfg.period}s, 设备 epoch=${cfg.deviceEpoch}, 可用恢复码 ${usable})`
        : ` (${TOTP_FILE} 不存在 ⇒ 仅密码登录, 行为与加 MFA 前一致)`)
      + ` 限速档=${LOCK_TIERS.map((t) => t.at).join('/')} 全站闸=${GLOBAL_MAX_FAILS}/h`
      + ` 锁表=${lockedIps} 个 IP${locks.global.lockUntil > Date.now() ? ' + 全站闸生效中' : ''}`
      + ` 告警设备=${hub === null ? '未配置' : String(hub.devices.filter((d) => d.enabled !== false).length)}`
      + ` /mfa页=ON 管理令牌=${mfaToken === null ? 'OFF(仅cookie)' : 'ON'} 二维码=${qrLib === null ? 'OFF(手动输入)' : 'ON'}`
      + (() => {   // Stage 4: 手机一次性码开关 (关闭态 = 回滚态, 行为回到 Stage 3)
        const otp = loadOtp();
        const otpOnNow = otp.otpEnabled === true;
        return ` OTP=${otpOnNow ? 'ON' : 'OFF'}`
          + (otpOnNow
            ? ` (TTL ${Math.round(OTP_TTL_MS / 1000)}s, 尝试 ${OTP_MAX_TRIES} 次, 节流 ${Math.round(OTP_COOLDOWN_MS / 1000)}s/${OTP_MAX_SENDS}次每${Math.round(OTP_WINDOW_MS / 60000)}min, 待用码 ${otp.codes.filter((c) => c.usedAt === 0).length})`
            : ` (${OTP_FILE} 不存在或 otpEnabled!==true ⇒ 登录页不显示发码按钮, send-otp 返回 403 otp_disabled)`);
      })());
  } catch (e) { console.error('[auth] 安全内核启动自检失败:', e.message); }
})();
