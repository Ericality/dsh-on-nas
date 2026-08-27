import { readFile, stat, realpath, mkdir, readdir } from "node:fs/promises";
import { resolve, sep, extname, join } from "node:path";

/**
 * @deepseek-ai/dsh-fileserve (本地辅助插件, 非官方包)
 *
 * 在 webServer 上注册两个前缀路由:
 *   /files/<workspace相对路径>  — 登录后可访问, 只读服务整个 workspace
 *   /public/<相对路径>          — 免登录公开分享区, 只服务 <workspace>/public/ 目录
 *                                 (目录访问返回简单文件列表索引页, 供浏览分享内容)
 * 只读。路径防护: /files 限 workspace 根目录内, /public 限 public 目录内
 * (两者均做 resolve 字符串归一化 + realpath 符号链接双重越界检查)。
 *
 * 用法: 聊天消息里给出相对链接, 如 [查看 ENV.md](/files/ENV.md)
 * 或 [查看分享](/public/README.md)。
 */
export const name = "dsh-fileserve";
export const inject = ["webServer"];

const DEFAULT_ROOT = "/workspace";
const PUBLIC_DIR_NAME = "public";
const EXT_CONTENT_TYPES = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".pdf": "application/pdf",
	".html": "text/html; charset=utf-8"
};
const DEFAULT_CONTENT_TYPE = "text/plain; charset=utf-8";

function contentTypeFor(path) {
	return EXT_CONTENT_TYPES[extname(path).toLowerCase()] ?? DEFAULT_CONTENT_TYPE;
}

function notFound(res, message = "not found") {
	res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
	res.end(message);
}

function forbidden(res, message) {
	res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
	res.end(message);
}

/**
 * 把 rel 解析到 root 下的真实路径, 双重防越界 (安全关键, 缺一不可):
 *   1) resolve 字符串归一化后检查仍在 root 内 — 防 `..` / 编码穿越
 *   2) realpath 解开符号链接后检查仍在 root 内 — 防软链逃逸
 * 返回 null 表示越界/非法; ENOENT 等异常由调用方统一兜底。
 */
async function realInRoot(root, rel) {
	if (rel.includes("\0")) return null;
	const target = resolve(root, rel);
	if (target !== root && !target.startsWith(root + sep)) return null;
	const real = await realpath(target);
	if (real !== root && !real.startsWith(root + sep)) return null;
	return real;
}

function escapeHtml(s) {
	return String(s)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function formatSize(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let v = bytes / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i += 1;
	}
	return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

function formatTime(d) {
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 面包屑: /public / a / b (当前段不加链接) */
function breadcrumbHtml(prefix, rel) {
	const segs = rel.split("/").filter(Boolean);
	let acc = prefix;
	let html = `<a href="${prefix}/">${escapeHtml(prefix)}</a>`;
	for (let i = 0; i < segs.length - 1; i += 1) {
		acc += `/${encodeURIComponent(segs[i])}`;
		html += ` / <a href="${acc}/">${escapeHtml(segs[i])}</a>`;
	}
	if (segs.length > 0) html += ` / ${escapeHtml(segs[segs.length - 1])}`;
	return html;
}

/** 目录索引页 (仅 /public 区启用) */
async function serveIndex(req, res, realDir, prefix, rel) {
	const entries = await readdir(realDir, { withFileTypes: true });
	const visible = entries
		.filter((e) => !e.name.startsWith("."))
		.sort((a, b) => {
			const ad = a.isDirectory() ? 0 : 1;
			const bd = b.isDirectory() ? 0 : 1;
			return ad !== bd ? ad - bd : a.name.localeCompare(b.name, "zh-CN");
		});
	let rows = "";
	for (const ent of visible) {
		const isDir = ent.isDirectory();
		const href = `${encodeURIComponent(ent.name)}${isDir ? "/" : ""}`;
		let size = "—";
		let mtime = "—";
		try {
			const st = await stat(join(realDir, ent.name));
			size = st.isFile() ? formatSize(st.size) : "—";
			mtime = formatTime(st.mtime);
		} catch { /* stat 失败不阻塞列表 */ }
		rows += `<tr><td class="n"><a href="${href}">${isDir ? "&#128193;" : "&#128196;"} ${escapeHtml(ent.name)}${isDir ? "/" : ""}</a></td><td class="s">${size}</td><td class="t">${mtime}</td></tr>`;
	}
	const bodyHtml = rows === ""
		? `<div class="empty">（空目录）</div>`
		: `<table><thead><tr><th class="n">名称</th><th class="s">大小</th><th class="t">修改时间</th></tr></thead><tbody>${rows}</tbody></table>`;
	const title = `${prefix}${rel === "" ? "/" : `/${rel}`}`;
	const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: #f6f7f9; color: #1a2332; font-family: -apple-system,"PingFang SC","Microsoft YaHei",sans-serif; }
  .card { max-width: 860px; margin: 0 auto; background: #fff; border-radius: 10px; box-shadow: 0 2px 12px rgba(0,0,0,.08); overflow: hidden; }
  .head { padding: 16px 20px; border-bottom: 1px solid #e8eaee; }
  .head h1 { margin: 0; font-size: 16px; font-weight: 600; }
  .crumb { font-size: 13px; color: #888; margin-top: 6px; word-break: break-all; }
  .crumb a { color: #4d6bfe; text-decoration: none; }
  .crumb a:hover { text-decoration: underline; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { padding: 8px 20px; border-top: 1px solid #f0f2f5; background: #fafbfc; color: #666; font-weight: 600; font-size: 12px; text-align: left; }
  td { padding: 9px 20px; border-top: 1px solid #f0f2f5; }
  td.n a { color: #1a2332; text-decoration: none; }
  td.n a:hover { color: #4d6bfe; text-decoration: underline; }
  th.s, td.s { width: 90px; text-align: right; font-variant-numeric: tabular-nums; color: #888; }
  th.t, td.t { width: 140px; color: #888; font-variant-numeric: tabular-nums; }
  .empty { padding: 40px 20px; text-align: center; color: #aaa; font-size: 14px; }
  .foot { padding: 10px 20px; border-top: 1px solid #e8eaee; color: #aaa; font-size: 12px; text-align: right; }
</style>
</head><body>
<div class="card">
  <div class="head">
    <h1>${escapeHtml(title)}</h1>
    <div class="crumb">${rel !== "" ? `<a href="../">&#11014; 上级目录</a> · ` : ""}${breadcrumbHtml(prefix, rel)}</div>
  </div>
  ${bodyHtml}
  <div class="foot">dsh-fileserve 公开分享目录 · 只读</div>
</div>
</body></html>`;
	const data = Buffer.from(html, "utf-8");
	res.writeHead(200, {
		"Content-Type": "text/html; charset=utf-8",
		"Content-Length": data.length,
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff"
	});
	if (req.method === "HEAD") res.end();
	else res.end(data);
}

/**
 * 路由工厂: 同一套 GET/HEAD 只读逻辑, 参数化服务根目录。
 * @param {string} root     仅允许服务该目录内 (resolve + realpath 双重校验)
 * @param {string} prefix   路由前缀, 如 /files 或 /public
 * @param {boolean} allowDir 目录访问是否返回索引页 (仅 /public 开启)
 */
function makeHandler({ root, prefix, allowDir }) {
	return async (req, res) => {
		try {
			if (req.method !== "GET" && req.method !== "HEAD") {
				res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
				res.end("method not allowed");
				return;
			}
			let pathname;
			try {
				pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
			} catch {
				res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
				res.end("bad request");
				return;
			}
			if (pathname === prefix) {
				res.writeHead(301, { Location: `${prefix}/` });
				res.end();
				return;
			}
			if (!pathname.startsWith(`${prefix}/`)) return notFound(res);
			const rel = pathname.slice(prefix.length + 1);
			const real = await realInRoot(root, rel);
			if (real === null) return forbidden(res, "forbidden: outside served root");
			const info = await stat(real);
			if (info.isFile()) {
				const data = await readFile(real);
				res.writeHead(200, {
					"Content-Type": contentTypeFor(real),
					"Content-Length": data.length,
					"Cache-Control": "no-store",
					"X-Content-Type-Options": "nosniff"
				});
				if (req.method === "HEAD") res.end();
				else res.end(data);
				return;
			}
			if (info.isDirectory() && allowDir) {
				await serveIndex(req, res, real, prefix, rel);
				return;
			}
			return notFound(res, "not a file");
		} catch (error) {
			if (error?.code === "ENOENT") return notFound(res);
			res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
			res.end(String(error?.message ?? error));
		}
	};
}

export async function apply(ctx) {
	const root = resolve(process.env.DSH_FILESERVE_ROOT ?? DEFAULT_ROOT);
	const publicRoot = resolve(root, PUBLIC_DIR_NAME);

	// 确保公开目录存在 (只读服务的前提; 失败不阻塞启动, 路由照常注册)
	try {
		await mkdir(publicRoot, { recursive: true });
	} catch { /* 忽略: 目录缺失时 /public 访问自然 404 */ }

	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: "/files",
		handler: makeHandler({ root, prefix: "/files", allowDir: false })
	}));
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: "/public",
		handler: makeHandler({ root: publicRoot, prefix: "/public", allowDir: true })
	}));
}
