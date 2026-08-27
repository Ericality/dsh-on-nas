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
//   - 防爆破: 同一 IP 5 次失败锁 60 秒 (隧道场景用 Cf-Connecting-Ip 按真实 IP)
//   - 登录页智能提示: 明文 HTTP 且非 localhost 且非隧道访问时, 提示改用 HTTPS
//   - 未设置 DSH_AUTH_USERNAME/PASSWORD 时: 纯转发模式 (无认证, 仅限可信局域网)
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
const MAX_FAILS = 5;          // 同 IP 失败次数上限
const LOCK_MS = 60 * 1000;    // 锁定时长
const BODY_LIMIT = 64 * 1024; // 登录请求体上限

const secret = crypto.randomBytes(32).toString('hex');
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
function readCookie(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`).exec(req.headers.cookie || '');
  return m ? verify(decodeURIComponent(m[1])) : null;
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
  .hint { display: none; margin-bottom: 16px; padding: 9px 11px; border-radius: 8px; background: rgba(255,248,230,.92); border: 1px solid #f0d48a; color: #8a6d1a; font-size: 13px; line-height: 1.5; }
</style></head><body>
<div id="bg"></div>
<div class="card">
  <div class="hint" id="hint">当前是明文 HTTP 访问。局域网请使用 <b>https://NAS_IP:8443</b> 访问, 否则界面无法正常工作。</div>
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
<script>
if (location.search.includes('err=1')) document.getElementById('err').style.display='block';
if (__INSECURE_LAN__) document.getElementById('hint').style.display='block';
// 背景与聊天背景一致: 读 dsh-bg-image 同一份设置 (同域 localStorage), 复刻其模式→URL 逻辑
(function () {
  var KEY = "dsh.bg-image.v2", DEF = "/bing-wallpaper", sec = {};
  try { var raw = localStorage.getItem(KEY); if (raw) sec = JSON.parse(raw) || {}; } catch (e) {}
  var mode = sec.mode;
  if (!mode && sec.image && sec.image !== DEF) mode = "custom";
  if (!mode) mode = "daily";
  var img;
  if (mode === "folder") {
    // 跟随聊天背景: mode=current 返回服务端最近一次随机选中的图 (不重新随机),
    // 与聊天页当前显示的文件夹壁纸一致; 服务端无记录时回退随机一张
    img = "/wallpaper-folder?mode=current";
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

function sendLogin(res, insecureLan) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(LOGIN_HTML.replace('__INSECURE_LAN__', insecureLan ? 'true' : 'false'));
}

// ---------- 转发到 dsh web (改写 Host/Origin 通过信任围栏) ----------
function upstreamOptions(req) {
  const u = new URL(UPSTREAM);
  const headers = Object.assign({}, req.headers);
  headers.host = u.host;
  headers.origin = u.origin; // 围栏要求 Origin 与 Host 同源(回环)
  headers['x-forwarded-for'] = clientIp(req);
  return { hostname: u.hostname, port: u.port || 80, path: req.url, method: req.method, headers };
}

function proxy(req, res) {
  const opts = upstreamOptions(req);
  // 去掉 hop-by-hop 头, 让 Node 自己管理连接与分块编码
  for (const h of ['connection', 'transfer-encoding', 'keep-alive', 'proxy-connection', 'upgrade']) {
    delete opts.headers[h];
  }
  const preq = http.request(opts, (pres) => {
    res.writeHead(pres.statusCode, pres.headers);
    pres.pipe(res);
  });
  preq.on('error', () => {
    if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('502 Bad Gateway: upstream dsh web not reachable'); }
    else res.end();
  });
  req.pipe(preq);
}

// ---------- WebSocket 升级转发 ----------
// dsh 的实时事件流走 /api/events.mux 和 /api/events.host 两条 WebSocket 下行连接,
// 普通 HTTP 代理不处理 Upgrade 请求, 必须单独转发 (否则界面无实时更新, 只能刷新看进度)
function handleUpgrade(req, socket, head) {
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

  const opts = upstreamOptions(req); // 保留 Connection: upgrade / Upgrade: websocket
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
  });
  wreq.on('error', () => socket.destroy());
  wreq.end();
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
    sendLogin(res, insecureLan);
    return;
  }
  if (url.pathname === '/logout') {
    res.writeHead(302, { Location: '/login', 'Set-Cookie': clearCookie() });
    res.end();
    return;
  }

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
