import { deflateSync } from "node:zlib";
import { readFileSync, existsSync } from "node:fs";

/**
 * @deepseek-ai/dsh-pwa (本地辅助插件, 非官方包)
 *
 * 让 iOS Safari 可以把 dsh 网页"添加到主屏幕"当独立 App 用:
 *   - 生成 180x180 apple-touch-icon.png (纯色+边框, 程序生成)
 *   - 注入 iOS 专用 meta/link 标签 (apple-mobile-web-app-capable / apple-touch-icon / theme-color)
 *   - 覆盖 /manifest.webmanifest: display=standalone + 图标
 *
 * 生效后: Safari 分享菜单 → 添加到主屏幕 → 图标独立全屏打开。
 */
export const name = "dsh-pwa";
export const inject = ["webServer"];

const ICON_SIZE = 180;
const ICON_COLOR = [77, 107, 254]; // #4D6BFE
const ICON_BORDER = 20; // 白色内边距边框宽度(像素)

// ---------- 最小 PNG 编码器 (纯 Node, 无依赖) ----------
const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c;
	}
	return table;
})();

function crc32(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const typeBuf = Buffer.from(type, "ascii");
	const crcBuf = Buffer.alloc(4);
	crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
	return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** 生成 180x180 纯色圆角感图标: 底色 + 白色内边框 */
function buildIconPng() {
	const raw = Buffer.alloc(ICON_SIZE * (ICON_SIZE * 3 + 1));
	let o = 0;
	for (let y = 0; y < ICON_SIZE; y++) {
		raw[o++] = 0; // filter: none
		for (let x = 0; x < ICON_SIZE; x++) {
			const border = x < ICON_BORDER || y < ICON_BORDER || x >= ICON_SIZE - ICON_BORDER || y >= ICON_SIZE - ICON_BORDER;
			const color = border ? [255, 255, 255] : ICON_COLOR;
			raw[o++] = color[0];
			raw[o++] = color[1];
			raw[o++] = color[2];
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(ICON_SIZE, 0);
	ihdr.writeUInt32BE(ICON_SIZE, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // color type RGB
	// 10-12: compression/filter/interlace = 0
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0))
	]);
}

const ICON_180_PATH = "/workspace/assets/dsh-icon-180.png";
const ICON_512_PATH = "/workspace/assets/dsh-icon-512.png";
function loadIcon(path) {
	try {
		return existsSync(path) ? readFileSync(path) : null;
	} catch {
		return null;
	}
}
const ICON_PNG = loadIcon(ICON_180_PATH) ?? buildIconPng();
const ICON_512_PNG = loadIcon(ICON_512_PATH);

function buildManifest() {
	return JSON.stringify({
		id: "/",
		name: "DeepSeek Harness",
		short_name: "DSH",
		start_url: "/",
		scope: "/",
		display: "standalone",
		background_color: "#101320",
		theme_color: "#4D6BFE",
		icons: [
			{ src: "/apple-touch-icon.png?v=20260823", sizes: "180x180", type: "image/png", purpose: "any" },
			...(ICON_512_PNG ? [{ src: "/dsh-icon-512.png?v=20260823", sizes: "512x512", type: "image/png", purpose: "any" }] : []),
			{ src: "/favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }
		]
	});
}

const MANIFEST_JSON = buildManifest();

export async function apply(ctx) {
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/apple-touch-icon.png",
		handler: (req, res) => {
			res.writeHead(200, {
				"Content-Type": "image/png",
				"Content-Length": ICON_PNG.length,
				"Cache-Control": "public, max-age=86400"
			});
			res.end(ICON_PNG);
		}
	}));

	if (ICON_512_PNG) {
		ctx.effect(() => ctx.webServer.register({
			kind: "exact",
			path: "/dsh-icon-512.png",
			handler: (req, res) => {
				res.writeHead(200, {
					"Content-Type": "image/png",
					"Content-Length": ICON_512_PNG.length,
					"Cache-Control": "public, max-age=86400"
				});
				res.end(ICON_512_PNG);
			}
		}));
	}

	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/manifest.webmanifest",
		handler: (req, res) => {
			res.writeHead(200, {
				"Content-Type": "application/manifest+json",
				"Content-Length": Buffer.byteLength(MANIFEST_JSON),
				"Cache-Control": "public, max-age=3600"
			});
			res.end(MANIFEST_JSON);
		}
	}));

	ctx.on("webserver/index-inject", (table) => {
		table.push({
			kind: "html",
			placement: "head",
			html: "<meta name=\"apple-mobile-web-app-capable\" content=\"yes\">"
				+ "<meta name=\"mobile-web-app-capable\" content=\"yes\">"
				+ "<meta name=\"theme-color\" content=\"#4D6BFE\">"
				+ "<link rel=\"apple-touch-icon\" href=\"/apple-touch-icon.png?v=20260823\">"
		});
	});
}
