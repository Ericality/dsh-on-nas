import z from "@deepseek-ai/schemastery";
import { appendFileSync } from "node:fs";

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
 * 内容 (v0.2.0): 通知里带上会话标题、本轮用户问题摘要、agent 答复摘要,
 * 方便不看 GUI 也能知道是哪个会话、聊了什么。
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

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

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

const DEBUG_LOG = "/workspace/notify-debug.log";
function debug(msg) {
	try { appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch { /* ignore */ }
}

export async function apply(ctx, config) {
	debug(`apply: minTurnMs=${config?.minTurnMs} barkKeys=${(config?.barkKeys ?? []).length} synology=${!!config?.synologyWebhookUrl}`);
	const barkKeys = [...new Set([
		...(config.barkKeys ?? []),
		...(process.env.DSH_BARK_KEYS ? process.env.DSH_BARK_KEYS.split(",").map((s) => s.trim()).filter(Boolean) : [])
	])];
	const synologyUrl = config.synologyWebhookUrl || process.env.DSH_SYNOLOGY_WEBHOOK_URL || "";
	const minTurnMs = config.minTurnMs ?? 60000;
	const hasChannel = barkKeys.length > 0 || synologyUrl !== "";

	async function notify(title, body) {
		const text = `${title}\n${body}`;
		const results = await Promise.allSettled([
			...barkKeys.map((key) => sendBark(key, title, body)),
			...synologyUrl ? [sendSynology(synologyUrl, text)] : []
		]);
		for (const result of results) {
			debug(`send ${result.status}${result.status === "rejected" ? ": " + String(result.reason?.message ?? result.reason) : ""}`);
			if (result.status === "rejected") ctx.logger.warn(`dsh-notify: 推送失败: ${String(result.reason?.message ?? result.reason)}`);
		}
		return results;
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
		if (event.type !== "turn/end") return;
		const start = turnStarts.get(session.id);
		turnStarts.delete(session.id);
		if (!start) return;
		const elapsed = Date.now() - start.startTs;
		debug(`turn/end: elapsed=${elapsed}ms threshold=${minTurnMs}ms hasChannel=${hasChannel}`);
		if (elapsed < minTurnMs) return;
		if (!hasChannel) return;
		const turn = event.data?.turn ?? start.turn;
		const rawReason = event.data?.reason;
		const reasonText = typeof rawReason === "string"
			? rawReason
			: rawReason && typeof rawReason === "object"
				? (rawReason.kind ?? JSON.stringify(rawReason))
				: "unknown";
		const sid = String(session.id ?? "");
		const sidShort = sid.startsWith("session-") ? sid.slice(8, 16) : sid.slice(0, 8);
		const q = lastUserQuestion(session);
		const a = lastAssistantAnswer(session);
		const title = `DSH 任务完成 · ${sessionTitle(session) || "会话"}`;
		const lines = [];
		if (q) lines.push(`❓ ${clip(q, 60)}`);
		if (a) lines.push(`🤖 ${clip(a, 100)}`);
		lines.push(`回合 #${turn} 完成 (用时 ${fmtElapsed(elapsed)}) · 原因: ${reasonText} · 会话 ${sidShort}`);
		void notify(title, lines.join("\n"));
	});

	// 验证命令
	ctx.commands.register({
		name: "notify-test",
		description: "发送测试通知到 Bark/Synology Chat (验证通道)",
		handler: async () => {
			if (!hasChannel) {
				return { kind: "error", text: "未配置任何通知通道 (barkKeys / synologyWebhookUrl)" };
			}
			const results = await notify("DSH 测试通知", `通道测试 ${new Date().toLocaleString("zh-CN", { hour12: false })} · 配置通道: ${barkKeys.length} 个 Bark + ${synologyUrl ? "1 个 Synology Chat" : "0"}`);
			const ok = results.filter((r) => r.status === "fulfilled").length;
			const fail = results.length - ok;
			return { kind: "success", text: `已发送: ${ok} 成功, ${fail} 失败${fail > 0 ? " (详见服务日志)" : ""}` };
		}
	});
}
