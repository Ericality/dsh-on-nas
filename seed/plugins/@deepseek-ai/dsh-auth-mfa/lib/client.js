window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-auth-mfa",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");
		var { createSnapshotStore } = require("@deepseek-ai/dsh-client-store");

		// ═══════════════════════════════════════════════════════════════════
		//  「登录二次验证」设置卡 —— 通知中枢 Stage 3 (MFA 界面)
		//  位置: 设置 > 本地插件 > 登录二次验证
		//        body 槽 settings.localplugin.item key=auth-mfa
		//        summary 兄弟槽 settings.localplugin.summary key=auth-mfa (同一 key)
		//  契约: docs/任务记录/2026-09-12-通知中枢Stage3-契约与决策.md §2(动作矩阵)/§3(钩子)/§5(设置卡)
		//        docs/任务记录/2026-09-12-本地插件折叠卡-契约.md (折叠胶囊卡 v1 + 补丁 ⑳/㉑)
		//  数据面: 已认证 RPC /auth-mfa → host 侧以本地 IPC 令牌调 auth-proxy 的 /mfa/api/*
		//        方法 1:1 = status|seed|enable|regenerate|disable|purge|revokeDevice|revokeAll|unlock
		//        (浏览器永远拿不到令牌; 令牌只在 dsh 进程内使用, 本组件从不接触令牌)
		//  安全: 种子/QR/恢复码**默认不显示**, 只有用户点「显示种子与恢复码」才向 auth-proxy 索取;
		//        种子只落在 DOM(可离线抄写), 不写 localStorage/cookie/日志。
		//  外观: 卡根**不自绘胶囊外壳/标题行**(契约 §5.1/§5.2) —— 外壳+折叠+箭头由容器
		//        (dsh-quick-insert 的 details.dsh-lp-card)提供; 卡内分组级折叠用既有 .lp-details;
		//        主题色 = 卡自带 #22c55e (Stage3 契约 E11 裁定: 绿, 非 sky);
		//        零新增配色 —— 全部 --dsw-alias-* 语义变量 + color-mix; 风险提示行用 warn 语义色。
		// ═══════════════════════════════════════════════════════════════════
		var CARD_KEY = "auth-mfa";
		var NS = "ui-auth-mfa";
		var CHANNEL = "/auth-mfa";
		/** 恢复码总数 (契约 §2: 8 个; 摘要固定显示 /8)。 */
		var TOTAL_RECOVERY = 8;

		/** 文案 (与 /mfa 页一致; 本卡中文, 与 dsh-notify 设置卡同策略)。 */
		var TXT = {
			title: "登录二次验证",
			badge: "本地插件",
			note: "与 /mfa 管理页同等能力（经本地管理令牌直连 auth-proxy）。种子与恢复码默认不显示，点击后才索取。",
			stateOn: "已启用",
			stateOff: "未启用",
			stateLoading: "读取中…",
			stateError: "状态读取失败",
			fpLabel: "种子指纹",
			reveal: "显示种子与恢复码",
			revealBusy: "正在读取…",
			risk: "本页任何可打开的人都能看到种子与恢复码；请离线抄写，不要截图/发聊天",
			seedTitle: "种子与恢复码（敏感）",
			secretLabel: "base32 种子（手动输入用）",
			qrLabel: "扫码添加（验证器 App）",
			qrUnavailable: "二维码不可用，请手动输入上方 base32",
			recoveryLabel: "恢复码（每个只能使用一次）",
			recoveryWarn: "已用/未显示的码不可找回，请重生成",
			enable: "启用",
			disable: "停用",
			regenerate: "重生成种子",
			alsoRevoke: "同时吊销全部设备",
			purge: "删除种子文件",
			devicesTitle: "信任设备",
			noDevices: "暂无信任设备",
			revoke: "吊销",
			revoked: "已吊销",
			revokeAll: "吊销全部设备",
			lockTitle: "登录锁定",
			lockHint: "删除 auth-lock.json（含永久锁）；解除后下一次登录即可重试（口令/验证码仍走限速）",
			unlockAll: "解除所有登录锁定",
			confirmPurge: "删除种子文件 = 彻底清除 MFA（种子与恢复码全部作废）。继续？",
			confirmRegen: "重生成种子会作废旧验证器与新恢复码之外的旧恢复码。继续？",
			confirmRegenRevoke: "重生成种子并吊销全部信任设备：所有已信任设备下次登录都要重新验证码。继续？",
			confirmRevokeAll: "吊销全部设备：所有浏览器下次登录都要重新输入验证码。继续？",
			confirmUnlock: "解除所有登录锁定（含永久锁）？",
			// 裁决 E17 (2026-09-12): enable 语义 = 无种子才生成; 有种子未启用只置 enabled=true (复用现有种子/恢复码/epoch,
			// 旧验证器继续可用); 已启用 = 幂等 ⇒ 「换种子」的唯一入口是「重新生成种子」。
			confirmEnable: "启用二次验证？启用后未信任设备登录需要验证码",
			confirmEnableReuse: "（已有种子 ⇒ 沿用现有种子与恢复码，旧验证器继续可用）",
			confirmEnableUnknown: "（如已有种子则沿用现有种子，旧验证器继续可用）",
			enableDisabledHint: "已启用；如需更换种子请用「重新生成种子」",
			recoveryEmpty: "未显示的恢复码不可找回，请用「重新生成种子」获取 8 个新码"
		};

		// ---------- 样式 (mf- 家族; 零新增配色: 只用 --dsw-alias-* 语义变量 + color-mix) ----------
		// ⚠️ 变量作用域 (折叠卡契约补丁 ⑳, 2026-09-12 事故后强制): dsh 的 --dsw-alias-* 定义在 **body**
		// (不在 :root) ⇒ 本文件**不写任何 `:root{…}` 块**; 卡自带的唯一自定义属性 --lp-accent
		// 是**字面量色值**且挂在 .dsh-lp-card[data-lp-key] 上(body 之内), 不间接引用 dsw 变量。
		var INJECTED_CSS = [
			// 卡自带主题色 (Stage3 契约 E11 裁定: 绿 #22c55e; 卡侧显式声明, 不依赖容器哈希分配)
			".dsh-lp-card[data-lp-key=\"auth-mfa\"]{--lp-accent:#22c55e}",
			".mf-note{background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#9aa3b2) 10%,transparent);border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;padding:6px 10px;font-size:11.5px;line-height:1.75;color:var(--dsw-alias-label-secondary)}",
			// 状态行: 已启用/未启用 + 种子指纹 + 设备数·恢复码
			".mf-state{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary)}",
			".mf-pill{display:inline-flex;align-items:center;height:22px;padding:0 9px;border-radius:999px;font-size:11.5px;line-height:1;flex:none;border:1px solid transparent;background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#9aa3b2) 16%,transparent);color:var(--dsw-alias-label-secondary)}",
			".mf-pill[data-on=\"true\"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 14%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 45%,transparent);color:var(--dsw-alias-state-success-primary,#22c55e);font-weight:600}",
			".mf-fp,.mf-count{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary)}",
			// 分组标题行 (同 dsh-notify 的 .nt-sh 口径)
			".mf-sh{display:flex;align-items:center;gap:7px;flex-wrap:wrap;border-top:1px dashed var(--dsw-alias-border-l2);padding-top:9px;color:var(--dsw-alias-label-secondary);font-size:12.5px;font-weight:600}",
			".mf-tag{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 14%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 45%,transparent);color:var(--dsw-alias-state-business-primary,#4176e6);font-size:9.5px;font-weight:600;padding:0 7px;border-radius:8px;line-height:15px;flex:none}",
			".mf-hint,.mf-hint *{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}",
			// 动作按钮 (同 nt-btn 口径)
			".mf-acts{display:flex;gap:6px;align-items:center;flex-wrap:wrap}",
			".mf-btn{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;height:26px;font:inherit;font-size:12px;line-height:24px;cursor:pointer;white-space:nowrap;flex:none}",
			".mf-btn:hover:not(:disabled){border-color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.12))}",
			".mf-btn:disabled{opacity:.45;cursor:default}",
			".mf-btn-solid{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 55%,transparent);color:var(--dsw-alias-state-success-primary,#22c55e);font-weight:600}",
			".mf-btn-solid:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 14%,transparent)}",
			".mf-btn-danger{color:var(--dsw-alias-state-danger-primary,#ef4444);border-color:color-mix(in srgb,var(--dsw-alias-state-danger-primary,#ef4444) 42%,transparent)}",
			".mf-btn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-danger-primary,#ef4444) 14%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-danger-primary,#ef4444) 42%,transparent)}",
			".mf-chk{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}",
			// 风险提示行 (.risk 同款 warn 语义色, 零新增家族色)
			".mf-risk{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 12%,transparent);border:1px dashed color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 45%,transparent);border-radius:8px;padding:6px 10px;font-size:11.5px;line-height:1.7;color:var(--dsw-alias-state-warn-primary,#f59e0b)}",
			// 种子区 (默认不渲染; 点击后才有内容)
			".mf-seed{display:flex;flex-direction:column;gap:8px}",
			".mf-slabel{color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:600}",
			".mf-secret{display:block;font-family:ui-monospace,'SF Mono',Consolas,monospace;font-size:12.5px;letter-spacing:.6px;line-height:19px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.12));border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 9px;color:var(--dsw-alias-label-primary);user-select:all;word-break:break-all}",
			".mf-qr{display:flex;justify-content:flex-start;align-items:flex-start}",
			".mf-qr svg{width:168px;height:168px;display:block;border-radius:6px}",
			".mf-recs{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:5px;margin:0;padding:0;list-style:none}",
			".mf-rec{font-family:ui-monospace,'SF Mono',Consolas,monospace;font-size:11.5px;line-height:18px;text-align:center;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.12));border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:3px 2px;color:var(--dsw-alias-label-primary);user-select:all}",
			// 设备列表
			".mf-devlist{display:grid;grid-template-columns:1fr;gap:6px}",
			".mf-dev{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:7px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}",
			".mf-dev[data-revoked=\"true\"]{opacity:.55}",
			".mf-dev-name{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary)}",
			".mf-dev-meta{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,'SF Mono',Consolas,monospace}",
			".mf-dev-acts{margin-left:auto;display:flex;gap:4px;align-items:center;flex-wrap:wrap}",
			// 结果条 (#mfa-msg): 成功/失败/进行中
			".mf-msg{display:flex;gap:7px;align-items:center;flex-wrap:wrap;font-size:11.5px;line-height:16px;min-height:16px}",
			".mf-msg[data-state=\"ok\"]{color:var(--dsw-alias-state-success-primary,#22c55e)}",
			".mf-msg[data-state=\"err\"]{color:var(--dsw-alias-state-danger-primary,#ef4444)}",
			".mf-msg[data-state=\"busy\"]{color:var(--dsw-alias-state-warn-primary,#f59e0b)}",
			"@media (max-width:640px){.mf-dev-meta{flex-basis:100%}.mf-dev-acts{margin-left:0}}"
		].join("\n");

		function injectCss() {
			try {
				if (typeof document === "undefined") return;
				if (document.getElementById("dsh-mfa-card-css")) return;
				var st = document.createElement("style");
				st.id = "dsh-mfa-card-css";
				st.textContent = INJECTED_CSS;
				(document.head || document.documentElement).appendChild(st);
			} catch (e) { /* 样式注入失败不影响功能 */ }
		}

		// ---------- 响应解析 (宽容: auth-proxy 的 JSON 形状未在契约中逐字段冻结 ⇒ 多重兜底) ----------
		/** 错误文案: 兼容 host 的 `{ok:false,error:"<串>"}` 与 RPC 层的 `{code,message}` 对象两种形状。 */
		function errText(res, fallback) {
			var e = res && res.error;
			if (typeof e === "string" && e) return e;
			if (e && typeof e === "object") {
				var m = e.message || e.code;
				if (m) return String(m);
			}
			return fallback || "操作失败";
		}
		/**
		 * status 视图归一: auth-proxy 的 status 既可能把字段放在顶层, 也可能挂在 `status.mfa` 下
		 * (协调人裁决里的口径是 `status.mfa.enabled`) ⇒ 取到第一个存在的节点, 两个都查。
		 */
		function viewOf(d) {
			if (!d || typeof d !== "object") return null;
			if (d.mfa && typeof d.mfa === "object") return Object.assign({}, d, d.mfa);
			return d;
		}
		function isEnabled(d) {
			var v = viewOf(d);
			return !!(v && v.enabled === true);
		}
		function fingerprintOf(d) {
			var v = viewOf(d);
			if (!v) return "—";
			var fp = v.fingerprint || v.fp || v.seedFingerprint || v.secretFingerprint;
			return fp ? String(fp) : "—";
		}
		/** 是否已有种子 (决定 enable 走"生成新种子"还是"沿用现有种子"分支; 判不出时按"不确定"处理)。 */
		function hasSeed(d) {
			var v = viewOf(d);
			if (!v) return false;
			if (v.hasSeed === true || v.seedPresent === true || v.hasSecret === true) return true;
			if (v.hasSeed === false || v.seedPresent === false) return false;
			return fingerprintOf(d) !== "—";
		}
		function deviceListOf(d) {
			var v = viewOf(d);
			if (!v) return [];
			if (Array.isArray(v.devices)) return v.devices;
			if (Array.isArray(v.trustedDevices)) return v.trustedDevices;
			return [];
		}
		function isRevoked(dev) { return !!(dev && (dev.revokedAt || dev.revoked === true || dev.status === "revoked")); }
		function activeDevices(d) { return deviceListOf(d).filter(function (x) { return !isRevoked(x); }); }
		function codeUnused(c) {
			if (c === null || c === undefined) return false;
			if (typeof c === "string") return c !== "";
			return !(c.usedAt || c.used === true || c.revokedAt);
		}
		/** 剩余未用恢复码数 (契约 §2: 剩余 = 未用数; 摘要固定 /8)。 */
		function remainingOf(d) {
			var v = viewOf(d);
			if (!v) return 0;
			var keys = ["recoveryRemaining", "recoveryCodesRemaining", "recoveryLeft", "recoveryCodesLeft", "recoveryUnused"];
			for (var i = 0; i < keys.length; i++) {
				var n = v[keys[i]];
				if (typeof n === "number" && isFinite(n)) return n;
			}
			if (Array.isArray(v.recoveryCodes)) return v.recoveryCodes.filter(codeUnused).length;
			if (Array.isArray(v.recovery)) return v.recovery.filter(codeUnused).length;
			if (typeof v.recoveryTotal === "number" && typeof v.recoveryUsed === "number") {
				return Math.max(0, v.recoveryTotal - v.recoveryUsed);
			}
			return 0;
		}
		function fmtTime(v) {
			if (v === null || v === undefined || v === "") return "—";
			var t = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Date.parse(String(v));
			if (!isFinite(t)) return String(v);
			try { return new Date(t).toLocaleString("zh-CN", { hour12: false }); } catch (e) { return String(v); }
		}
		/** seed/enable/regenerate 三者的返回同形状 ⇒ 统一归一化。 */
		function normalizeSeed(v) {
			if (!v || typeof v !== "object") return null;
			var secret = v.secret || v.base32 || v.secretBase32 || "";
			var codes = Array.isArray(v.recoveryCodes) ? v.recoveryCodes
				: Array.isArray(v.codes) ? v.codes
					: Array.isArray(v.recovery) ? v.recovery : [];
			return {
				secret: String(secret || ""),
				otpauth: String(v.otpauth || v.otpauthUri || v.uri || ""),
				qrSvg: typeof v.qrSvg === "string" ? v.qrSvg : (typeof v.qr === "string" ? v.qr : null),
				recoveryCodes: codes.filter(codeUnused).map(function (c) {
					return typeof c === "string" ? c : String((c && (c.code || c.value)) || "");
				}).filter(Boolean).slice(0, TOTAL_RECOVERY)
			};
		}
		/** 破坏性动作二次确认 (confirm 不可用时(冒烟环境)放行 —— 见回报决策登记)。 */
		function confirmAsk(text) {
			try {
				if (typeof window !== "undefined" && typeof window.confirm === "function") return window.confirm(text) === true;
			} catch (e) { /* confirm 异常 ⇒ 放行 */ }
			return true;
		}

		// ---------- 控制器: /auth-mfa RPC + snapshot store ----------
		function createController(connection) {
			var store = createSnapshotStore({ status: "loading", loaded: false, data: null, error: "" });
			function call(method, payload) {
				var rpc = connection && connection.rpc;
				if (!rpc || typeof rpc.call !== "function") {
					return Promise.resolve({ ok: false, error: "connection 服务不可用" });
				}
				return rpc.call(CHANNEL, method, payload || {}).then(function (result) {
					return result && typeof result === "object" ? result : { ok: false, error: "响应格式异常" };
				}).catch(function (err) {
					return { ok: false, error: "RPC 失败: " + String((err && err.message) || err) };
				});
			}
			/** status: 卡加载即拉取 (auth-proxy 为权威源; 不含种子明文)。 */
			function refresh() {
				return call("status", {}).then(function (res) {
					if (res && res.ok && res.value && typeof res.value === "object") {
						store.set({ status: "ready", loaded: true, data: res.value, error: "" });
						return res.value;
					}
					// 读取失败 ⇒ loaded=false ⇒ 摘要回落「读取中…」(契约 §5, 摘要不得为空)
					store.set({ status: "error", loaded: false, data: null, error: errText(res, TXT.stateError) });
					return null;
				});
			}
			refresh();
			return {
				store: store,
				refresh: refresh,
				status: refresh,
				seed: function () { return call("seed", {}); },
				enable: function () { return call("enable", {}).then(afterWrite); },
				regenerate: function (alsoRevokeDevices) {
					return call("regenerate", { alsoRevokeDevices: alsoRevokeDevices === true }).then(afterWrite);
				},
				disable: function () { return call("disable", {}).then(afterWrite); },
				purge: function () { return call("purge", {}).then(afterWrite); },
				revokeDevice: function (id) { return call("revokeDevice", { id: id }).then(afterWrite); },
				revokeAll: function () { return call("revokeAll", {}).then(afterWrite); },
				unlock: function (scope, ip) { return call("unlock", ip ? { scope: scope, ip: ip } : { scope: scope || "all" }).then(afterWrite); }
			};
			/** 写动作成功后刷新状态 (失败不刷新, 保留旧视图 + 结果条报错)。 */
			function afterWrite(res) {
				if (res && res.ok) refresh();
				return res;
			}
		}

		// ---------- 「登录二次验证」卡 (body 槽) ----------
		function AuthMfaCard(props) {
			var state = props.useAuthMfa(function (s) { return s; });
			var data = state && state.data && typeof state.data === "object" ? state.data : null;
			var loaded = !!(state && state.loaded);
			var busyRef = React.useRef(false);
			var busyState = React.useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];
			var seedState = React.useState(null);
			var seed = seedState[0];
			var setSeed = seedState[1];
			var openState = React.useState(false);
			var seedOpen = openState[0];
			var setSeedOpen = openState[1];
			var alsoState = React.useState(false);
			var alsoRevoke = alsoState[0];
			var setAlsoRevoke = alsoState[1];
			var msgState = React.useState(null);
			var msg = msgState[0];
			var setMsg = msgState[1];

			function say(kind, text) { setMsg({ state: kind, text: String(text || "") }); }
			/** 统一的写动作包装: 禁用态 + 结果条三态 (busy/ok/err)。 */
			function run(busyText, promise, okText, after) {
				if (busyRef.current) return;
				busyRef.current = true;
				setBusy(true);
				say("busy", busyText);
				promise.then(function (res) {
					busyRef.current = false;
					setBusy(false);
					if (res && res.ok) {
						if (after) { try { after(res.value); } catch (e) { /* 渲染态更新失败不影响结果条 */ } }
						say("ok", okText);
					} else {
						say("err", errText(res, "操作失败"));
					}
				}, function (err) {
					busyRef.current = false;
					setBusy(false);
					say("err", "RPC 失败: " + String((err && err.message) || err));
				});
			}
			/** ① 状态行 (来自 status; 不触种子) */
			var enabled = isEnabled(data);
			var devs = deviceListOf(data);
			var active = activeDevices(data);
			var remain = remainingOf(data);
			var devCountText = active.length + " 台设备 · 恢复码 " + remain + "/" + TOTAL_RECOVERY;
			var stateText = !loaded ? TXT.stateLoading : (state && state.status === "error" ? TXT.stateError : (enabled ? TXT.stateOn : TXT.stateOff));

			// ② 种子与恢复码: **默认不显示** (details 默认收起 + 未经 seed 不渲染任何明文)
			function revealSeed() {
				run(TXT.revealBusy, props.seed(), "已显示种子与恢复码 —— 请离线抄写，不要截图/发聊天", function (value) {
					var norm = normalizeSeed(value);
					setSeed(norm);
					setSeedOpen(true);
				});
			}
			// ③ 动作按钮 (破坏性动作二次确认)
			// 裁决 E17 (2026-09-12): enable 不再"换种子" —— 无种子才生成; 有种子未启用只置 enabled=true (沿用现有种子/恢复码,
			// 旧验证器继续可用); 已启用 = 幂等 ⇒ **已启用时「启用」按钮 disabled**, 换种子的唯一入口是「重新生成种子」。
			function doEnable() {
				if (enabled) return; // 双保险: 已启用时按钮已 disabled, 即便被程序化触发也不发请求
				// 分支文案: 能判出已有种子 ⇒ 明确"沿用现有种子"; 判不出 ⇒ 补一句"如已有种子则沿用…"
				var confirmText = TXT.confirmEnable + (hasSeed(data) ? TXT.confirmEnableReuse : TXT.confirmEnableUnknown);
				if (!confirmAsk(confirmText)) return;
				run("正在启用…", props.enable(), "已启用二次验证", function (value) {
					// 复用分支也会带 secret/qrSvg (让用户能重新扫码) ⇒ 照常渲染并展开; recoveryCodes 为空由渲染层降级
					var norm = normalizeSeed(value);
					if (norm && (norm.secret || norm.qrSvg)) { setSeed(norm); setSeedOpen(true); }
				});
			}
			function doDisable() { run("正在停用…", props.disable(), "已停用（种子与恢复码保留，可再启用）"); }
			function doRegenerate() {
				if (!confirmAsk(alsoRevoke ? TXT.confirmRegenRevoke : TXT.confirmRegen)) return;
				run("正在重生成…", props.regenerate(alsoRevoke), "已重生成种子" + (alsoRevoke ? "，并吊销全部信任设备" : "") + " —— 请重新扫码并抄写恢复码", function (value) {
					var norm = normalizeSeed(value);
					if (norm && (norm.secret || norm.qrSvg)) { setSeed(norm); setSeedOpen(true); }
				});
			}
			function doPurge() {
				if (!confirmAsk(TXT.confirmPurge)) return;
				run("正在删除种子文件…", props.purge(), "已删除种子文件（MFA 彻底停用）", function () {
					setSeed(null);
					setSeedOpen(false);
				});
			}
			// ⑤ 设备 / ⑥ 解锁
			function doRevoke(dev) {
				var id = String(dev && (dev.id || dev.deviceId) || "");
				if (!id) return;
				run("正在吊销…", props.revokeDevice(id), "已吊销设备 " + id);
			}
			function doRevokeAll() {
				if (!confirmAsk(TXT.confirmRevokeAll)) return;
				run("正在吊销全部设备…", props.revokeAll(), "已吊销全部设备");
			}
			function doUnlockAll() {
				if (!confirmAsk(TXT.confirmUnlock)) return;
				run("正在解除锁定…", props.unlock("all"), "已解除所有登录锁定");
			}

			var qrOk = !!(seed && typeof seed.qrSvg === "string" && seed.qrSvg.trim().indexOf("<svg") === 0);
			var seedEl = null;
			if (seed) {
				seedEl = React.createElement("div", { className: "mf-seed", id: "seed-content" }, [
					React.createElement("span", { className: "mf-slabel", key: "sl1" }, TXT.secretLabel),
					React.createElement("code", { className: "mf-secret", id: "seed-secret", key: "secret" }, seed.secret || "—"),
					React.createElement("span", { className: "mf-slabel", key: "sl2" }, TXT.qrLabel),
					// ④ 二维码: 服务端返回的 qrSvg **直接注入** (不引第三方 QR 库); 缺失 ⇒ 文案降级
					qrOk
						? React.createElement("div", {
							className: "mf-qr", id: "seed-qr", key: "qr",
							dangerouslySetInnerHTML: { __html: seed.qrSvg }
						})
						: React.createElement("div", { className: "mf-qr", id: "seed-qr", key: "qr", "data-fallback": "true" },
							React.createElement("span", { className: "mf-hint" }, TXT.qrUnavailable)),
					React.createElement("span", { className: "mf-slabel", key: "sl3" }, TXT.recoveryLabel),
					// 裁决 E17: enable 走"沿用现有种子"分支时 recoveryCodes 通常是 `[]` (哈希不可逆, 明文只在那一次返回过)
					// ⇒ **渲染降级文案**, 绝不放 8 个空行 (会让人误以为"没生成")。
					seed.recoveryCodes.length
						? React.createElement("ul", { className: "mf-recs", id: "recovery-list", key: "recs" },
							seed.recoveryCodes.map(function (c, i) {
								return React.createElement("li", { className: "mf-rec", key: "r" + i }, c);
							}))
						: React.createElement("div", {
							className: "mf-risk risk", id: "recovery-list", key: "recs",
							"data-empty": "true"
						}, TXT.recoveryEmpty),
					React.createElement("span", { className: "mf-hint", key: "rw" },
						seed.recoveryCodes.length
							? "剩余未用 " + seed.recoveryCodes.length + "/" + TOTAL_RECOVERY + " · " + TXT.recoveryWarn
							: TXT.recoveryWarn),
					seed.otpauth ? React.createElement("span", { className: "mf-hint", key: "otp" }, "otpauth: " + seed.otpauth) : null
				]);
			}
			var seedGroup = React.createElement("details", {
				className: "lp-details",
				id: "seed-box",
				key: "seedbox",
				open: seedOpen,
				onToggle: function (e) { setSeedOpen(!!(e && e.currentTarget && e.currentTarget.open)); }
			}, [
				React.createElement("summary", { key: "sum" }, [
					React.createElement("span", { className: "lp-arr", key: "arr" }, "▶"),
					React.createElement("span", { key: "t" }, TXT.seedTitle)
				]),
				React.createElement("div", { className: "mf-seed", key: "body" }, [
					React.createElement("div", { className: "mf-acts", key: "acts" }, [
						React.createElement("button", {
							type: "button", className: "mf-btn mf-btn-solid", id: "btn-reveal-seed",
							disabled: busy, key: "reveal", onClick: revealSeed
						}, seed ? "重新读取种子与恢复码" : TXT.reveal),
						React.createElement("span", { className: "mf-hint", key: "h" }, "首次点击才向 auth-proxy 索取（审计记为 MFA_SECRET_REVEAL）")
					]),
					React.createElement("p", { className: "mf-risk risk", key: "risk" }, TXT.risk),
					seedEl
				])
			]);

			// ⑤ 设备列表
			var devRows = devs.map(function (dev, i) {
				var id = String((dev && (dev.id || dev.deviceId)) || ("dev" + i));
				var revoked = isRevoked(dev);
				return React.createElement("div", {
					className: "mf-dev", key: id, "data-device-id": id,
					"data-revoked": revoked ? "true" : "false"
				}, [
					React.createElement("span", { className: "mf-dev-name", key: "n" }, String((dev && (dev.name || dev.label || dev.ua)) || id)),
					React.createElement("span", { className: "mf-dev-meta", key: "ip" }, "IP " + String((dev && dev.ip) || "—")),
					React.createElement("span", { className: "mf-dev-meta", key: "c" }, "创建 " + fmtTime(dev && (dev.createdAt || dev.created))),
					React.createElement("span", { className: "mf-dev-meta", key: "l" }, "最近 " + fmtTime(dev && (dev.lastUsedAt || dev.lastSeenAt || dev.lastUsed || dev.lastSeen))),
					React.createElement("span", { className: "mf-dev-acts", key: "acts" }, revoked
						? React.createElement("span", { className: "mf-hint" }, TXT.revoked)
						: React.createElement("button", {
							type: "button", className: "mf-btn mf-btn-danger", disabled: busy,
							"data-revoke": id, onClick: function () { doRevoke(dev); }
						}, TXT.revoke))
				]);
			});
			var devicesBlock = React.createElement(React.Fragment, { key: "devices" }, [
				React.createElement("div", { className: "mf-sh", key: "h" }, [
					TXT.devicesTitle,
					React.createElement("span", { className: "mf-tag", key: "tag" }, devs.length + " 台 · " + (devs.length - active.length) + " 台已吊销"),
					React.createElement("span", { className: "mf-acts", key: "acts" }, React.createElement("button", {
						type: "button", className: "mf-btn mf-btn-danger", id: "btn-revoke-all",
						disabled: busy || active.length === 0, onClick: doRevokeAll
					}, TXT.revokeAll)),
					React.createElement("span", { className: "mf-hint", key: "hint" }, "每行：名称 · IP · 创建时间 · 最近使用 · 吊销")
				]),
				devRows.length
					? React.createElement("div", { className: "mf-devlist", id: "mfa-devices", key: "list" }, devRows)
					: React.createElement("div", { className: "mf-hint", id: "mfa-devices", key: "list" }, TXT.noDevices)
			]);

			// ⑥ 解锁
			var lockBlock = React.createElement(React.Fragment, { key: "lock" }, [
				React.createElement("div", { className: "mf-sh", key: "h" }, [
					TXT.lockTitle,
					React.createElement("span", { className: "mf-hint", key: "hint" }, TXT.lockHint),
					React.createElement("span", { className: "mf-acts", key: "acts" }, React.createElement("button", {
						type: "button", className: "mf-btn", id: "btn-unlock-all", disabled: busy, onClick: doUnlockAll
					}, TXT.unlockAll))
				])
			]);

			// ② 结果条 (#mfa-msg) —— 成功/失败文案 + 进行中
			var msgEl = React.createElement("div", {
				className: "mf-msg", id: "mfa-msg",
				"data-state": msg ? msg.state : "idle", role: "status", "aria-live": "polite"
			}, msg ? msg.text : "");

			// body 顶层直出 (契约 §5.1: 卡根无外壳/无标题行; 间距由容器 .dsh-lp-body 提供)
			return React.createElement(React.Fragment, null, [
				React.createElement("p", { className: "mf-note", key: "note" }, TXT.note),
				React.createElement("div", { className: "mf-state", key: "state" }, [
					React.createElement("span", { className: "mf-pill", id: "mfa-state", key: "pill", "data-on": enabled ? "true" : "false" }, stateText),
					React.createElement("span", { className: "mf-fp", id: "mfa-fp", key: "fp" }, TXT.fpLabel + " " + fingerprintOf(data)),
					React.createElement("span", { className: "mf-count", id: "mfa-devcount", key: "cnt" }, loaded ? devCountText : TXT.stateLoading),
					loaded ? null : React.createElement("span", { className: "mf-hint", key: "err" }, state && state.error ? state.error : "")
				]),
				// ④ 动作按钮 (启用/停用/重生成+同时吊销/删除种子文件)
				// 裁决 E17: 已启用 ⇒ 「启用」disabled (enable 是幂等)、换种子走「重新生成种子」
				React.createElement("div", { className: "mf-acts", key: "acts" }, [
					React.createElement("button", {
						type: "button", className: "mf-btn mf-btn-solid", id: "btn-enable",
						disabled: busy || enabled, key: "enable", onClick: doEnable,
						title: enabled ? TXT.enableDisabledHint : TXT.confirmEnable
					}, TXT.enable),
					React.createElement("button", {
						type: "button", className: "mf-btn", id: "btn-disable",
						disabled: busy || !enabled, key: "disable", onClick: doDisable
					}, TXT.disable),
					React.createElement("button", {
						type: "button", className: "mf-btn", id: "btn-regenerate",
						disabled: busy, key: "regen", onClick: doRegenerate
					}, TXT.regenerate),
					React.createElement("label", { className: "mf-chk", key: "chk" }, [
						React.createElement("input", {
							type: "checkbox", key: "cb", checked: alsoRevoke,
							onChange: function (e) { setAlsoRevoke(!!(e && e.target && e.target.checked)); }
						}, null),
						TXT.alsoRevoke
					]),
					React.createElement("button", {
						type: "button", className: "mf-btn mf-btn-danger", id: "btn-purge",
						disabled: busy, key: "purge", onClick: doPurge
					}, TXT.purge),
					// 内联提示 (与按钮 title 同文案): 已启用时告诉用户换种子走哪
					enabled ? React.createElement("span", { className: "mf-hint", id: "enable-hint", key: "ehint" }, TXT.enableDisabledHint) : null
				]),
				seedGroup,
				devicesBlock,
				lockBlock,
				msgEl
			]);
		}

		// ---------- 卡 · summary (折叠标题行: 图标 + 标题 + 徽标 + 实时摘要, 契约 §5) ----------
		// 与 item 卡共用同一个 inject 返回值 (同一 controller.store) ⇒ 摘要随 store 实时刷新
		function AuthMfaSummary(props) {
			var state = props.useAuthMfa(function (s) { return s; });
			var ready = !!(state && state.loaded && state.status === "ready");
			var d = ready && state.data && typeof state.data === "object" ? state.data : null;
			// 摘要模板 (契约 §5): {已启用|未启用} · {n} 台信任设备 · 恢复码 {m}/8; 未加载 ⇒ 读取中…
			var hint = ready
				? (isEnabled(d) ? TXT.stateOn : TXT.stateOff) + " · " + activeDevices(d).length + " 台信任设备 · 恢复码 " + remainingOf(d) + "/" + TOTAL_RECOVERY
				: TXT.stateLoading;
			return React.createElement(React.Fragment, null, [
				React.createElement("span", { className: "lp-ico", key: "ico" }, "🛡"),
				React.createElement("span", { className: "lp-title", key: "title" }, TXT.title),
				React.createElement("span", { className: "lp-badge", key: "badge" }, TXT.badge),
				React.createElement("span", { className: "lp-hint", key: "hint" }, hint)
			]);
		}

		// ---------- 注册 ----------
		var inject = ["slots", "locale", "connection"];
		/** 控制器实例 (apply 内赋值; 两个槽的 inject 共用)。 */
		var controller = null;
		/** item / summary 两个槽共用同一 inject 返回值 (契约 §1: summary props 契约 = item 卡)。 */
		function cardInjected() {
			return {
				hooks: { authMfa: controller.store },
				refresh: controller.refresh,
				status: controller.status,
				seed: controller.seed,
				enable: controller.enable,
				regenerate: controller.regenerate,
				disable: controller.disable,
				purge: controller.purge,
				revokeDevice: controller.revokeDevice,
				revokeAll: controller.revokeAll,
				unlock: controller.unlock
			};
		}

		function apply(ctx) {
			injectCss();
			// 中文卡 (zh 即 en, 免英文回退缺失)
			ctx.effect(function () { return ctx.locale.register(NS, { zh: {}, en: {} }); }, "ui-auth-mfa: settings card dictionaries");
			controller = createController(ctx.get("connection"));

			// 设置菜单「本地插件」列: 「登录二次验证」卡 **只注册 body**
			// (胶囊外壳/折叠/箭头/标题行由容器 dsh-quick-insert 提供, 契约 §5.1/§5.2)
			ctx.slots.inject("settings.localplugin.item", function () {
				return ctx.slots.register({
					name: "settings.localplugin.item",
					key: CARD_KEY,
					locale: NS,
					inject: cardInjected
				}, AuthMfaCard);
			});

			// 同卡的 summary 兄弟槽 (key 必须与 item 相同): 只提供折叠标题行 (图标/标题/徽标/实时摘要)。
			// 槽不可用/注册失败 ⇒ 静默 —— 容器检测不到该 key 的 summary 时走 .dsh-lp-flat 降级 (零破坏, 契约 §6)
			try {
				ctx.slots.inject("settings.localplugin.summary", function () {
					try {
						return ctx.slots.register({
							name: "settings.localplugin.summary",
							key: CARD_KEY,
							locale: NS,
							inject: cardInjected
						}, AuthMfaSummary);
					} catch (e) { return function () {}; }
				});
			} catch (e) { /* summary 槽不可用: 静默 (容器侧自动降级) */ }
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
