import z from "@deepseek-ai/schemastery";
import { KNOWN_SESSION_EVENT_TYPES } from "@deepseek-ai/dsh-session";
import { attachReconcile, lastTurnEnd, turnElapsedMs } from "@deepseek-ai/dsh-reconcile";
import { appendFileSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

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
 * 附带命令 /notify-test 用于验证各通道。
 * 通知发送是 fire-and-forget, 失败只记日志, 不影响任务。
 */
export const name = "dsh-notify";
export const inject = ["commands"];

export const Config = z.object({
	barkKeys: z.array(z.string()).default([]),
	synologyWebhookUrl: z.string().default(""),
	minTurnMs: z.number().default(60000)
});

const BARK_PUSH_URL = "https://api.day.app/push";
const SEND_TIMEOUT_MS = 10000;
/** Synology Chat incoming webhook 单条消息硬上限: 超过被拒收 (entry.cgi success:false) */
export const SYNOLOGY_PAGE_LIMIT = 2000;

async function sendBark(key, title, body) {
	const resp = await fetch(BARK_PUSH_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ device_key: key, title, body }),
		signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
	});
	if (!resp.ok) throw new Error(`Bark HTTP ${resp.status}`);
	const data = await resp.json();
	if (data?.code !== 200) throw new Error(`Bark code ${data?.code}: ${data?.message ?? ""}`);
	return true;
}

async function sendSynology(webhookUrl, text) {
	// Synology Chat incoming API (version=2) 接受 form-urlencoded 的 payload 字段
	const payload = JSON.stringify({ text });
	const resp = await fetch(webhookUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: `payload=${encodeURIComponent(payload)}`,
		signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
	});
	const data = await resp.json().catch(() => null);
	if (!resp.ok) throw new Error(`Synology HTTP ${resp.status}`);
	// entry.cgi 失败时也返回 HTTP 200, 必须检查 success 字段
	if (data?.success !== true) throw new Error(`Synology success:false: ${JSON.stringify(data?.error ?? data)}`);
	return true;
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

/** 最近一次会话标题 (session/title 事件), 无则空串 */
function sessionTitle(session) {
	const ev = session.events.findLast((e) => e.type === "session/title" && typeof e.data?.title === "string");
	return ev?.data?.title ?? "";
}

/** 本轮最后一个真实用户消息 (source.kind="user") 的文本 */
function lastUserQuestion(session) {
	const events = session.events;
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
	const events = session.events;
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
	debug(`apply: minTurnMs=${config?.minTurnMs} barkKeys=${(config?.barkKeys ?? []).length} synology=${!!config?.synologyWebhookUrl}`);
	const barkKeys = [...new Set([
		...(config.barkKeys ?? []),
		...(process.env.DSH_BARK_KEYS ? process.env.DSH_BARK_KEYS.split(",").map((s) => s.trim()).filter(Boolean) : [])
	])];
	const synologyUrl = config.synologyWebhookUrl || process.env.DSH_SYNOLOGY_WEBHOOK_URL || "";
	const minTurnMs = config.minTurnMs ?? 60000;
	const hasChannel = barkKeys.length > 0 || synologyUrl !== "";

	/** 分页串行发送间隔: 避开 Synology entry.cgi 限流 (code 411 "create post too fast", 实测 1.5s 安全) */
	const SEND_PAGE_INTERVAL_MS = 1500;

	/**
	 * v0.5.3: 通知发送**全局 FIFO 串行** — 一个通知的所有页发完 (含页间 1.5s 间隔)
	 * 才发送下一个通知 (用户 2026-08-29 要求: 不能让分页答案乱序, 也不能跨会话交错)。
	 * 所有触发源 (完成/提问/中断对账) 共用同一条队列, 队列拒绝处理 (catch) 后仍继续。
	 */
	let notifyQueue = Promise.resolve();
	async function notify(title, pages) {
		const run = notifyQueue.then(async () => {
			// v0.5.1: 逐通道串行发送 (原 Promise.allSettled 并发 → 多页推送触发 411 丢页)
			// Bark: 单条全文 (未启用通道, 保持兼容); Synology: 逐页发送, 每页间隔 1.5s
			const barkBody = pages.join("\n\n");
			const results = [];
			for (const key of barkKeys) {
				try { await sendBark(key, title, barkBody); results.push({ status: "fulfilled" }); }
				catch (reason) { results.push({ status: "rejected", reason }); }
			}
			for (const p of pages) {
				try { await sendSynology(synologyUrl, p); results.push({ status: "fulfilled" }); }
				catch (reason) { results.push({ status: "rejected", reason }); }
				await new Promise((r) => setTimeout(r, SEND_PAGE_INTERVAL_MS));
			}
			for (const result of results) {
				debug(`send ${result.status}${result.status === "rejected" ? ": " + String(result.reason?.message ?? result.reason) : ""}`);
				if (result.status === "rejected") ctx.logger.warn(`dsh-notify: 推送失败: ${String(result.reason?.message ?? result.reason)}`);
			}
			return results;
		});
		// 队列吞掉异常, 保证后续通知不被卡死
		notifyQueue = run.then(() => {}, () => {});
		return run;
	}

	// 回合计时: sessionId -> { turn, startTs }
	const turnStarts = new Map();

	ctx.on("session/event", (session, event) => {
		if (event.type === "turn/start" || event.type === "turn/end") debug(`event ${event.type} turn=${event.data?.turn} sid=${String(session?.id ?? "").slice(0, 12)}`);
		if (!session?.id || !event?.type) return;
		if (event.type === "turn/start" && typeof event.data?.turn === "number") {
			turnStarts.set(session.id, { turn: event.data.turn, startTs: Date.now() });
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
			const qTitle = `⁉️ DSH 需要你回应 · ${sessionTitle(session) || "会话"}`;
			const qFooter = `回合 #${turn} 在等你回应 · 会话 ${sidShort}`;
			const qPages = composeSynologyPages(qTitle, stripMarkdown(rawQ), stripMarkdown(rawA), qFooter);
			void notify(qTitle, qPages);
			return;
		}
		if (event.type !== "turn/end") return;
		const start = turnStarts.get(session.id);
		turnStarts.delete(session.id);
		if (!start) return;
		const elapsed = Date.now() - start.startTs;
		if (!hasChannel) return;
		debug(`turn/end: elapsed=${elapsed}ms threshold=${minTurnMs}ms hasChannel=${hasChannel}`);
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
		if (elapsed < minTurnMs) return;
		const summary = extractSummary(rawA);
		const title = `✅ DSH 任务完成 · ${sessionTitle(session) || "会话"}`;
		const footer = `回合 #${turn} 完成 (用时 ${fmtElapsed(elapsed)}) · 原因: ${reasonText} · 会话 ${sidShort}`;
		const pages = composeSynologyPages(title, stripMarkdown(rawQ), stripMarkdown(rawA), footer);
		void notify(title, pages);
		// 本地横幅 (v0.3.0, 用户要求): 普通完成通知内容与外部推送相同,
		// 不再在 GUI 重复弹"任务完成"浮窗; 仅当回复含"新的总结信息"
		// (总结段落, extractSummary 启发式) 时注入, 以【总结】展示
		// 通知里没有的新内容。注入需 setTimeout 延迟到 turn/end 事件
		// 派发之外, 避免 session.append 重入被吞 (与 cost-guard 同法)。
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
			if (!hasChannel) return false;
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
			debug(`reconcile: 中断回合 #${end.turn} elapsed=${elapsed}ms threshold=${minTurnMs}ms hasChannel=${hasChannel}`);
			if (elapsed === null || elapsed < minTurnMs) {
				// 短回合被打断不值得打扰; 标记避免每次启动重算
				await markPushed(key);
				return;
			}
			const sid = String(session.id ?? "");
			const sidShort = sid.startsWith("session-") ? sid.slice(8, 16) : sid.slice(0, 8);
			const rawQ = lastUserQuestion(session);
			const rawA = lastAssistantAnswer(session);
			const title = `❌ DSH 回合被中断 · ${sessionTitle(session) || "会话"}`;
			const footer = `回合 #${end.turn} 被中断 (用时 ${fmtElapsed(elapsed)}) · 会话 ${sidShort}`;
			const pages = composeSynologyPages(title, stripMarkdown(rawQ), stripMarkdown(rawA), footer);
			const results = await notify(title, pages);
			await markPushed(key);
			debug(`reconcile: 中断回合 #${end.turn} 推送完成 ${results.filter((r) => r.status === "fulfilled").length}/${results.length}`);
		}
	});

	// 验证命令
	ctx.commands.register({
		name: "notify-test",
		description: "发送测试通知到 Bark/Synology Chat (验证通道)",
		handler: async () => {
			if (!hasChannel) {
				return { kind: "error", text: "未配置任何通知通道 (barkKeys / synologyWebhookUrl)" };
			}
			const results = await notify("DSH 测试通知", [`通道测试 ${new Date().toLocaleString("zh-CN", { hour12: false })} · 配置通道: ${barkKeys.length} 个 Bark + ${synologyUrl ? "1 个 Synology Chat" : "0"}`]);
			const ok = results.filter((r) => r.status === "fulfilled").length;
			const fail = results.length - ok;
			return { kind: "success", text: `已发送: ${ok} 成功, ${fail} 失败${fail > 0 ? " (详见服务日志)" : ""}` };
		}
	});
}
