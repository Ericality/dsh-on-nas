import { readFile, stat, realpath } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";

/**
 * @deepseek-ai/dsh-fileserve (本地辅助插件, 非官方包)
 *
 * 在 webServer 上注册前缀路由 /files/<workspace相对路径>, 以纯文本形式把
 * workspace 内的文件返回给浏览器, 让用户在聊天里点链接即可在新标签页查看
 * agent 产出的文件。只读、只限 workspace 根目录内(含 realpath 防符号链接逃逸)。
 *
 * 用法: 聊天消息里给出相对链接, 如 [查看 ENV.md](/files/ENV.md)
 * 或 [查看产物](/files/projects/x/report.md)。
 */
export const name = "dsh-fileserve";
export const inject = ["webServer"];

const DEFAULT_ROOT = "/workspace";
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

export async function apply(ctx) {
	const root = resolve(process.env.DSH_FILESERVE_ROOT ?? DEFAULT_ROOT);
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: "/files",
		handler: async (req, res) => {
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
				if (!pathname.startsWith("/files/")) return notFound(res);
				const rel = pathname.slice("/files/".length);
				if (rel === "" || rel.includes("\0")) return notFound(res);
				const target = resolve(root, rel);
				if (target !== root && !target.startsWith(root + sep)) {
					res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
					res.end("forbidden: outside workspace root");
					return;
				}
				const real = await realpath(target);
				if (real !== root && !real.startsWith(root + sep)) {
					res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
					res.end("forbidden: symlink escapes workspace root");
					return;
				}
				const info = await stat(real);
				if (!info.isFile()) return notFound(res, "not a file");
				const data = await readFile(real);
				res.writeHead(200, {
					"Content-Type": contentTypeFor(real),
					"Content-Length": data.length,
					"Cache-Control": "no-store",
					"X-Content-Type-Options": "nosniff"
				});
				if (req.method === "HEAD") {
					res.end();
				} else {
					res.end(data);
				}
			} catch (error) {
				if (error?.code === "ENOENT") return notFound(res);
				res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
				res.end(String(error?.message ?? error));
			}
		}
	}));
}
