import { readFile, writeFile } from "node:fs/promises";

/**
 * @deepseek-ai/dsh-balance (本地辅助插件, 非官方包)
 *
 * 斜杠命令:
 *   /balance        简洁版: 余额 / 间隔(时间范围+时段) / 本次差值预估 / 官方扣费
 *   /balance-detail 详细版: token 差值明细 + 运算过程 + 定价来源 + 累计
 *
 * 数据源:
 *   - 实时余额: DeepSeek /user/balance API (CNY)
 *   - 累计用量: session_projcache 各会话 tokenUsage.totals 汇总
 *   - 快照: /data/dsh/balance-state.json (持久卷), 用于计算与上次的差值
 *
 * 定价: 每次运行尝试从官方定价页解析
 *   (https://api-docs.deepseek.com/zh-cn/quick_start/pricing, V4-Flash 列);
 *   失败则回退到上次成功解析的缓存(<12h), 再失败回退内置常量。
 *   高峰=北京9-12点/14-18点; 间隔完全落在高峰=高峰, 完全落在其余=低谷, 横跨=混合。
 *
 * 命令结果只渲染在 UI, 不进模型历史, 不消耗模型 token。
 */
export const name = "dsh-balance";
export const inject = ["commands"];

// 内置常量兜底 (2026-08-17 官方价, ¥/百万tokens)
const FALLBACK_PRICES = {
	peak: { inputMiss: 3, inputHit: 0.1, output: 9 },
	offpeak: { inputMiss: 1.5, inputHit: 0.05, output: 4.5 }
};
const PRICING_PAGE_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing";
const PRICING_TIMEOUT_MS = 12000;
const PRICING_CACHE_TTL_MS = 30 * 60 * 1000;

const CREDENTIALS_FILE = "/data/dsh/.credentials.yaml";
const PROJCACHE_FILE = "/data/dsh/storages/session_projcache.json";
const STATE_FILE = "/data/dsh/balance-state.json";
const BALANCE_URL = "https://api.deepseek.com/user/balance";
const BALANCE_TIMEOUT_MS = 15000;

function beijingHour() {
	return (new Date().getUTCHours() + 8) % 24;
}

/** 北京时刻字符串 HH:MM */
function beijingHm(ms) {
	return new Date(ms + 8 * 3600 * 1000).toISOString().slice(11, 16);
}

/** 间隔时段分类: 高峰 / 低谷 / 混合(长间隔) */
function classifyInterval(startMs, endMs) {
	const ms = Math.max(0, endMs - startMs);
	if (ms <= 0) return "瞬时";
	const mins = Math.round(ms / 60000);
	if (mins > 60 * 24 * 2) return "混合(长间隔)";
	const startMin = (((startMs + 8 * 3600 * 1000) / 60000) % 1440 + 1440) % 1440;
	let peak = 0, off = 0;
	for (let i = 0; i < mins; i++) {
		const h = Math.floor(((startMin + i) % 1440) / 60);
		if ((h >= 9 && h < 12) || (h >= 14 && h < 18)) peak++; else off++;
	}
	if (peak > 0 && off > 0) return "混合";
	return peak > 0 ? "高峰" : "低谷";
}

async function resolveApiKey() {
	if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
	try {
		const txt = await readFile(CREDENTIALS_FILE, "utf8");
		const m = txt.match(/^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$/m);
		if (m) return m[1];
	} catch { /* fallthrough */ }
	return undefined;
}

async function fetchBalance(key) {
	const resp = await fetch(BALANCE_URL, {
		headers: { Authorization: `Bearer ${key}` },
		signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS)
	});
	if (!resp.ok) throw new Error(`balance API HTTP ${resp.status}`);
	return await resp.json();
}

/** 从官方定价页解析 V4-Flash 三档价格; 失败返回 null */
async function parseOfficialPrices() {
	try {
		const resp = await fetch(PRICING_PAGE_URL, {
			headers: { "User-Agent": "Mozilla/5.0" },
			signal: AbortSignal.timeout(PRICING_TIMEOUT_MS)
		});
		if (!resp.ok) return null;
		let text = await resp.text();
		text = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ");
		text = text.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
		const grab = (keyword) => {
			const idx = text.indexOf(keyword);
			if (idx < 0) return null;
			const seg = text.slice(idx, idx + 260);
			const nums = [...seg.matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => parseFloat(m[1]));
			return nums.length >= 4 ? { off: nums[0], peak: nums[3] } : null;
		};
		const hit = grab("（缓存命中）");
		const miss = grab("（缓存未命中）");
		const out = grab("百万tokens输出");
		if (!hit || !miss || !out) return null;
		return {
			peak: { inputMiss: miss.peak, inputHit: hit.peak, output: out.peak },
			offpeak: { inputMiss: miss.off, inputHit: hit.off, output: out.off }
		};
	} catch {
		return null;
	}
}

async function readUsageTotals() {
	try {
		const txt = await readFile(PROJCACHE_FILE, "utf8");
		const cache = JSON.parse(txt);
		const sessions = cache?.tables?.sessions ?? {};
		const totals = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
		let count = 0;
		for (const session of Object.values(sessions)) {
			const tu = session?.rows?.tokenUsage?.val?.totals ?? session?.rows?.tokenUsage?.totals;
			if (!tu) continue;
			count += 1;
			totals.uncachedInputTokens += tu.uncachedInputTokens ?? 0;
			totals.cacheReadTokens += tu.cacheReadTokens ?? 0;
			totals.cacheWriteTokens += tu.cacheWriteTokens ?? 0;
			totals.outputTokens += tu.outputTokens ?? 0;
		}
		return { ...totals, sessions: count };
	} catch {
		return { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, sessions: 0 };
	}
}

async function readState() {
	try {
		return JSON.parse(await readFile(STATE_FILE, "utf8"));
	} catch {
		return undefined;
	}
}

async function writeState(state) {
	try {
		await writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
		return true;
	} catch {
		return false;
	}
}

const costOf = (totals, price) =>
	((totals.uncachedInputTokens + totals.cacheWriteTokens) * price.inputMiss
		+ totals.cacheReadTokens * price.inputHit
		+ totals.outputTokens * price.output) / 1e6;

const fmtMoney = (n) => (Math.round(n * 100) / 100).toLocaleString("zh-CN");
const fmtTokens = (n) => `${(Math.round(n / 1000)).toLocaleString("zh-CN")}k`;
const fmtSignedTokens = (n) => `${n >= 0 ? "+" : ""}${fmtTokens(n)}`;
const fmtElapsed = (ms) => {
	const min = Math.max(1, Math.round(ms / 60000));
	if (min < 60) return `${min} 分钟`;
	return `${Math.floor(min / 60)} 小时 ${min % 60} 分钟`;
};

/** 收集一次完整快照(余额/用量/差值/时段/定价), 两个命令共用 */
async function collect() {
	const usage = await readUsageTotals();
	const key = await resolveApiKey();
	const state = await readState();

	// 并行: 余额查询 + 定价解析(缓存<30min 则直接用缓存, 不打官方页)
	const cacheFresh = state?.prices && Date.now() - (state.pricesFetchedAt ?? 0) < PRICING_CACHE_TTL_MS;
	const [balanceResult, priceResult] = await Promise.allSettled([
		key ? fetchBalance(key) : Promise.resolve(null),
		cacheFresh ? Promise.resolve(null) : parseOfficialPrices()
	]);

	let cny = null, available = null;
	const data = balanceResult.status === "fulfilled" ? balanceResult.value : null;
	if (data) {
		const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : [];
		const found = infos.find((i) => i.currency === "CNY");
		cny = found ? parseFloat(found.total_balance) : null;
		available = data.is_available;
	}

	// 定价: 本次解析成功 → 用它; 否则缓存(<30min) → 内置常量
	let prices, priceSource;
	const fresh = priceResult.status === "fulfilled" ? priceResult.value : null;
	if (fresh) {
		prices = fresh;
		priceSource = `官方页解析(${beijingHm(Date.now())})`;
	} else if (cacheFresh) {
		prices = state.prices;
		priceSource = "缓存(30分钟内)";
	} else {
		prices = FALLBACK_PRICES;
		priceSource = "内置常量";
	}

	const now = Date.now();
	const lastCheckAt = state?.lastCheckAt ?? null;
	const interval = lastCheckAt ? { from: lastCheckAt, to: now, ms: now - lastCheckAt } : null;
	const tier = interval ? classifyInterval(lastCheckAt, now) : null;
	const p = tier === "高峰" ? prices.peak : prices.offpeak;

	const delta = state?.totals ? {
		uncachedInputTokens: Math.max(0, usage.uncachedInputTokens - (state.totals.uncachedInputTokens ?? 0)),
		cacheReadTokens: Math.max(0, usage.cacheReadTokens - (state.totals.cacheReadTokens ?? 0)),
		cacheWriteTokens: Math.max(0, usage.cacheWriteTokens - (state.totals.cacheWriteTokens ?? 0)),
		outputTokens: Math.max(0, usage.outputTokens - (state.totals.outputTokens ?? 0))
	} : null;

	const balanceMoved = interval && cny !== null && typeof state?.balanceCny === "number"
		? state.balanceCny - cny
		: null;

	await writeState({
		version: 2,
		lastCheckAt: now,
		totals: {
			uncachedInputTokens: usage.uncachedInputTokens,
			cacheReadTokens: usage.cacheReadTokens,
			cacheWriteTokens: usage.cacheWriteTokens,
			outputTokens: usage.outputTokens
		},
		balanceCny: cny,
		prices: fresh ?? state?.prices ?? FALLBACK_PRICES,
		pricesFetchedAt: fresh ? now : (state?.pricesFetchedAt ?? 0)
	});

	return {
		usage, cny, available, interval, tier, p, prices,
		delta, deltaCost: delta ? costOf(delta, p) : null,
		totalCost: costOf(usage, p),
		balanceMoved, stateBalance: state?.balanceCny ?? null,
		priceSource
	};
}

export async function apply(ctx) {
	// ---- 简洁版 ----
	ctx.commands.register({
		name: "balance",
		description: "余额/间隔差值预估/官方扣费 (简洁)",
		handler: async () => {
			const d = await collect();
			const lines = [];
			lines.push(`余额: ${d.cny !== null ? `¥${fmtMoney(d.cny)}` : "查询失败"}${d.available !== null ? ` (可用: ${d.available ? "是" : "否"})` : ""}`);

			if (d.interval && d.delta) {
				lines.push(`间隔: ${fmtElapsed(d.interval.ms)} (${beijingHm(d.interval.from)}→${beijingHm(d.interval.to)}) · 时段: ${d.tier}`);
				lines.push(`本次预估: ¥${fmtMoney(d.deltaCost)}`);
				if (d.balanceMoved !== null) {
					lines.push(`官方扣费(计费有延迟): ${d.balanceMoved >= 0 ? "-" : "+"}¥${fmtMoney(Math.abs(d.balanceMoved))}`);
				}
			} else {
				lines.push("(首次记账: 从本次开始, 下次运行显示差值)");
			}
			return { kind: "success", text: lines.join("\n") };
		}
	});

	// ---- 详细版 ----
	ctx.commands.register({
		name: "balance-detail",
		description: "余额/用量/费用全量明细 (token + 运算 + 定价来源)",
		handler: async () => {
			const d = await collect();
			const lines = [];
			lines.push(`余额: ${d.cny !== null ? `¥${fmtMoney(d.cny)}` : "查询失败"}${d.available !== null ? ` (可用: ${d.available ? "是" : "否"})` : ""}`);

			if (d.interval && d.delta) {
				lines.push(`-- 本次间隔 ${fmtElapsed(d.interval.ms)} (${beijingHm(d.interval.from)}→${beijingHm(d.interval.to)}) · 时段: ${d.tier} --`);
				lines.push(`token 差值: 输入 ${fmtSignedTokens(d.delta.uncachedInputTokens)} · 缓存命中 ${fmtSignedTokens(d.delta.cacheReadTokens)} · 输出 ${fmtSignedTokens(d.delta.outputTokens)}`);
				lines.push(`本次预估: ¥${fmtMoney(d.deltaCost)} = 输入${fmtTokens(d.delta.uncachedInputTokens)}×¥${d.p.inputMiss} + 缓存${fmtTokens(d.delta.cacheReadTokens)}×¥${d.p.inputHit} + 输出${fmtTokens(d.delta.outputTokens)}×¥${d.p.output} (每百万, 当前${d.tier}价)`);
				if (d.balanceMoved !== null) {
					lines.push(`官方扣费(计费有延迟): ${d.balanceMoved >= 0 ? "-" : "+"}¥${fmtMoney(Math.abs(d.balanceMoved))} (上次 ¥${fmtMoney(d.stateBalance)} → 现在 ¥${fmtMoney(d.cny)})`);
				}
			} else {
				lines.push("-- 本次间隔 --\n(首次记账: 从本次开始, 下次运行显示差值)");
			}

			lines.push(`-- 累计 (${d.usage.sessions} 会话) --`);
			lines.push(`输入 ${fmtTokens(d.usage.uncachedInputTokens)} · 缓存 ${fmtTokens(d.usage.cacheReadTokens)} · 输出 ${fmtTokens(d.usage.outputTokens)}`);
			lines.push(`累计预估: ¥${fmtMoney(d.totalCost)}`);
			lines.push(`定价来源: ${d.priceSource} | 高峰 输入${d.prices.peak.inputMiss}/缓存${d.prices.peak.inputHit}/输出${d.prices.peak.output} · 低谷 ${d.prices.offpeak.inputMiss}/${d.prices.offpeak.inputHit}/${d.prices.offpeak.output} (¥/百万)`);
			return { kind: "success", text: lines.join("\n") };
		}
	});
}
