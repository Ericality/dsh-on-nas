#!/usr/bin/env node
// ============================================================
// 轻量登录认证反代 (零依赖, 纯 Node 标准库)
//
//   对外 0.0.0.0:3080 (登录页 + 会话)  ->  127.0.0.1:3081 (dsh web)
//
// 特性:
//   - 前端登录页面 (替代浏览器 basic auth 弹窗)
//   - HttpOnly + SameSite 签名会话 Cookie (HMAC, 无状态, 默认 7 天)
//   - 改写 Host/Origin 通过 dsh 的 /api 浏览器信任围栏
//   - 防爆破: 同一 IP 5 次失败锁 60 秒
//   - 未设置 DSH_AUTH_USERNAME/PASSWORD 时: 纯转发模式 (无认证, 仅限可信局域网)
// ============================================================
'use strict';

const http = require('http');
const crypto = require('crypto');

const LISTEN_PORT = parseInt(process.env.DSH_LISTEN_PORT || '3080', 10);
const LISTEN_HOST = process.env.DSH_LISTEN_HOST || '0.0.0.0';
const UPSTREAM = process.env.DSH_UPSTREAM || 'http://127.0.0.1:3081';
const USER = process.env.DSH_AUTH_USERNAME || '';
const PASS = process.env.DSH_AUTH_PASSWORD || '';
const COOKIE_NAME = 'dsh_session';
const SESSION_DAYS = parseInt(process.env.DSH_SESSION_DAYS || '7', 10);
const MAX_FAILS = 5;          // 同 IP 失败次数上限
const LOCK_MS = 60 * 1000;    // 锁定时长
const BODY_LIMIT = 64 * 1024; // 登录请求体上限

const secret = crypto.randomBytes(32).toString('hex');
const authOn = USER !== '' && PASS !== '';

// ---------- 会话 ----------
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
function readCookie(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`).exec(req.headers.cookie || '');
  return m ? verify(decodeURIComponent(m[1])) : null;
}
function sessionCookie(token) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`;
}
function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

// ---------- 登录校验 (常数时间比较) ----------
function checkCreds(u, p) {
  const hu = crypto.createHash('sha256').update(u).digest();
  const hp = crypto.createHash('sha256').update(p).digest();
  const eu = crypto.createHash('sha256').update(USER).digest();
  const ep = crypto.createHash('sha256').update(PASS).digest();
  return crypto.timingSafeEqual(hu, eu) && crypto.timingSafeEqual(hp, ep);
}

// ---------- 防爆破 ----------
const fails = new Map(); // ip -> { count, lockUntil }
const DEBUG = process.env.DSH_AUTH_DEBUG === '1';
function dlog(...a) { if (DEBUG) console.log('[auth]', ...a); }
function isLocked(ip) {
  const f = fails.get(ip);
  if (!f) return false;
  if (f.lockUntil && f.lockUntil > Date.now()) return true;
  if (f.lockUntil) fails.delete(ip); // 锁已过期, 清理
  return false;
}
function recordFail(ip) {
  const f = fails.get(ip) || { count: 0, lockUntil: 0 };
  f.count += 1;
  if (f.count >= MAX_FAILS) { f.lockUntil = Date.now() + LOCK_MS; f.count = 0; }
  fails.set(ip, f);
  dlog('fail', ip, 'count=', f.count, 'lockUntil=', f.lockUntil);
}
function clearFails(ip) { fails.delete(ip); }

// ---------- 登录页 ----------
const LOGIN_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DeepSeek Harness 登录</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: linear-gradient(160deg,#0f1420,#1a2332); font-family: -apple-system,"PingFang SC","Microsoft YaHei",sans-serif; }
  .card { width: 340px; padding: 36px 32px; border-radius: 14px; background: #fff; box-shadow: 0 12px 40px rgba(0,0,0,.45); }
  h1 { font-size: 20px; color: #111; margin-bottom: 6px; }
  p.sub { font-size: 13px; color: #888; margin-bottom: 22px; }
  label { display: block; font-size: 13px; color: #555; margin: 14px 0 6px; }
  input { width: 100%; padding: 10px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 15px; outline: none; }
  input:focus { border-color: #4d6bfe; }
  button { width: 100%; margin-top: 22px; padding: 11px; border: 0; border-radius: 8px; background: #4d6bfe; color: #fff; font-size: 15px; cursor: pointer; }
  button:hover { background: #3d59e0; }
  .err { display: none; margin-top: 14px; padding: 8px 10px; border-radius: 8px; background: #fdeaea; color: #c0392b; font-size: 13px; }
</style></head><body>
<div class="card">
  <h1>DeepSeek Harness</h1>
  <p class="sub">请输入访问凭据</p>
  <form method="post" action="/login">
    <label for="u">用户名</label>
    <input id="u" name="username" autocomplete="username" required autofocus>
    <label for="p">密码</label>
    <input id="p" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">登 录</button>
  </form>
  <div class="err" id="err">用户名或密码错误, 请重试</div>
</div>
<script>if (location.search.includes('err=1')) document.getElementById('err').style.display='block';</script>
</body></html>`;

function sendLogin(res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(LOGIN_HTML);
}

// ---------- 转发到 dsh web (改写 Host/Origin 通过信任围栏) ----------
function proxy(req, res) {
  const u = new URL(UPSTREAM);
  const headers = Object.assign({}, req.headers);
  headers.host = u.host;
  headers.origin = u.origin; // 围栏要求 Origin 与 Host 同源(回环)
  headers['x-forwarded-for'] = req.socket.remoteAddress || '';
  const preq = http.request({
    hostname: u.hostname, port: u.port || 80,
    path: req.url, method: req.method, headers,
  }, (pres) => {
    res.writeHead(pres.statusCode, pres.headers);
    pres.pipe(res);
  });
  preq.on('error', () => {
    if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('502 Bad Gateway: upstream dsh web not reachable'); }
    else res.end();
  });
  req.pipe(preq);
}

// ---------- 主服务 ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const ip = req.socket.remoteAddress || '?';

  // 无认证模式: 纯转发
  if (!authOn) { proxy(req, res); return; }

  // 登录/登出
  if (url.pathname === '/login') {
    if (req.method === 'POST') {
      dlog('POST /login from', ip, 'locked=', isLocked(ip));
      if (isLocked(ip)) { res.writeHead(303, { Location: '/login?err=1' }); res.end(); return; }
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > BODY_LIMIT) req.destroy(); });
      req.on('end', () => {
        const params = new URLSearchParams(body);
        const u = params.get('username') || '', p = params.get('password') || '';
        if (checkCreds(u, p)) {
          clearFails(ip);
          const token = sign({ exp: Date.now() + SESSION_DAYS * 86400 * 1000 });
          res.writeHead(303, { Location: '/', 'Set-Cookie': sessionCookie(token) });
          res.end();
        } else {
          recordFail(ip);
          res.writeHead(303, { Location: '/login?err=1' }); res.end();
        }
      });
      return;
    }
    // GET /login
    if (readCookie(req)) { res.writeHead(302, { Location: '/' }); res.end(); return; }
    sendLogin(res);
    return;
  }
  if (url.pathname === '/logout') {
    res.writeHead(302, { Location: '/login', 'Set-Cookie': clearCookie() });
    res.end();
    return;
  }

  // 其余路径: 校验会话
  if (!readCookie(req)) { res.writeHead(302, { Location: '/login' }); res.end(); return; }
  proxy(req, res);
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`auth-proxy: listening on ${LISTEN_HOST}:${LISTEN_PORT} -> ${UPSTREAM}${authOn ? ' (auth ON)' : ' (auth OFF, 无认证! 仅限可信局域网)'}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
