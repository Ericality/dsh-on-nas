window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-notify",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react = require("react");
		let { createSnapshotStore } = require("@deepseek-ai/dsh-client-store");

		// ═══════════════════════════════════════════════════════════════════
		//  「通知（Bark / 群晖）」设置卡 —— 通知设置整改 v0.7.0（客户端 B 侧）
		//  位置: 设置 > 本地插件 > 通知（Bark / 群晖）(settings.localplugin.item key=notify)
		//  契约(唯一来源): docs/任务记录/2026-09-12-通知设置整改-契约v0.7.0.md §4(RPC 形状)/§5(卡片规则)
		//                 + docs/任务记录/2026-09-12-本地插件折叠卡-契约.md（外壳/标题行由容器提供）
		//  视觉/文案权威: public/preview-notify-settings.html（用户已确认"按此实施"）
		//  数据面: 已认证 RPC /notify-hub (同 /model-console、/costguard-cfg 先例)
		//          get / saveDevice / deleteDevice / setRoutes / setOptions / test —— 逐字按 §4, 不自创字段
		//  安全: 明文 URL 只上行(saveDevice); 列表/响应/日志只回 urlTail(「…尾4位」),
		//        响应与日志永不出现完整 URL / key; 本组件不做任何明文缓存或回显。
		//  样式: 零新增色相 —— 全部 dsw 语义变量(business/success/warn/danger)+ color-mix,
		//        chrome 取值与预览 public/preview-notify-settings.html 的 nt-* 家族同款;
		//        卡内**分组级**折叠保留(预留类型 / 高级), 整卡折叠由容器 dsh-quick-insert 提供。
		//  旧 host 兼容(契约 §5 补充 · 协调人裁决): 本文件先于 host 重启上线, 因此在旧 RPC 下必须优雅降级 ——
		//        ① hasProducer 缺失 ⇒ 当 true(不丢进"预留"折叠区) ② effective 缺失 ⇒ 本地回退解析
		//        ③ setOptions 不存在 ⇒ 不判整次保存失败, 改为提示 OPTIONS_RPC_HINT
		//        ④ 旧 host 会把 routes[type]=[] 删键 ⇒ 三态读回变"默认", 由同一提示覆盖
		// ═══════════════════════════════════════════════════════════════════
		const ROW_ID = "notify";
		const NS = "ui-notify";
		const CHANNEL = "/notify-hub";

		/** kind 枚举 (沿用; 设备区本次不改)。 */
		const KINDS = [
			{ id: "bark", label: "bark · Bark" },
			{ id: "synology", label: "synology · 群晖" }
		];
		const KIND_LABEL = { bark: "Bark", synology: "群晖" };
		const URL_RE = /^https?:\/\//i;

		/**
		 * 契约 §2 冻结 type 表的**兜底**副本（服务端 get 未回 types 时用于渲染项目行; 含 hasProducer）。
		 * 权威源始终是服务端返回的 types[{ type, label, group, level, hasProducer }]。
		 */
		const TYPES_FALLBACK = [
			{ type: "auth.login_failed", label: "登录失败（密码/验证码错误）", group: "DSH-安全", level: "timeSensitive", hasProducer: true },
			{ type: "auth.locked", label: "触发锁定（含全站闸）", group: "DSH-安全", level: "timeSensitive", hasProducer: true },
			{ type: "auth.unlocked", label: "锁定期满 / 手动解除", group: "DSH-安全", level: "active", hasProducer: true },
			{ type: "auth.new_device", label: "新设备通过 TOTP 验证", group: "DSH-安全", level: "timeSensitive", hasProducer: true },
			{ type: "auth.mfa_changed", label: "MFA 启用 / 停用 / 重生成", group: "DSH-安全", level: "timeSensitive", hasProducer: true },
			{ type: "auth.otp", label: "登录一次性码（发到手机）", group: "DSH-安全", level: "timeSensitive", hasProducer: true },
			{ type: "task.done", label: "对话完成（回合结束汇总）", group: "DSH-任务", level: "active", hasProducer: true },
			{ type: "task.asking", label: "需要你回应（agent 提问）", group: "DSH-任务", level: "active", hasProducer: true },
			{ type: "task.interrupted", label: "回合被中断（重启后补推）", group: "DSH-任务", level: "active", hasProducer: true },
			{ type: "cost.alert", label: "费用提醒", group: "DSH-费用", level: "active", hasProducer: false },
			{ type: "queue.dispatched", label: "队列派发", group: "DSH-队列", level: "passive", hasProducer: false },
			{ type: "queue.cancelled", label: "队列取消", group: "DSH-队列", level: "passive", hasProducer: false },
			{ type: "test", label: "测试推送（设置卡逐台）", group: "DSH-测试", level: "active", hasProducer: true }
		];

		/**
		 * 契约 §5 emoji 映射（客户端常量, 冻结; 未列出的 type ⇒ 空串）。
		 * 2026-09-12 协调人裁决①落实: 补 queue.dispatched/queue.cancelled="⛰"、cost.alert="💰"
		 * —— 与用户已确认预览 public/preview-notify-settings.html 的"预留类型"行 1:1（契约 §5 已同步此项）。
		 */
		const TYPE_EMOJI = {
			"task.done": "✅",
			"task.asking": "⁉️",
			"task.interrupted": "❌",
			"auth.login_failed": "🔒",
			"auth.locked": "🔒",
			"auth.unlocked": "🔓",
			"auth.new_device": "✅",
			"auth.mfa_changed": "🔐",
			"test": "🔔",
			"queue.dispatched": "⛰",
			"queue.cancelled": "⛰",
			"cost.alert": "💰"
		};

		/** 行内补充说明 —— 逐字取自已确认预览 public/preview-notify-settings.html（仅这 3 行有 note）。 */
		const ROW_NOTES = {
			"task.done": "回合耗时 ≥ 阈值时推送完整问答（原来和下面两项共用一个 type）",
			"task.asking": "agent 调用提问工具时立即推，不受阈值限制",
			"task.interrupted": "容器重启致回合中断时补一条，含去重标记"
		};

		/** 契约 §5 客户端分组（组内保持服务端顺序; hasProducer===false 一律进预留折叠区, 不在这里匹配）。 */
		const GROUPS = [
			{ title: "对话（回合级）", match: function (t) { return t === "task.done" || t === "task.asking" || t === "task.interrupted"; } },
			{ title: "登录安全（由 auth-proxy 发送）", match: function (t) { return t.indexOf("auth.") === 0; } },
			{ title: "其它", match: function (t) { return t === "test"; } }
		];
		/** 「其它」组下标 —— 服务端将来新增的 type(有生产者)兜底归到这里, 避免静默消失。 */
		const OTHER_GROUP = 2;

		/** 契约 §3 options 默认值（服务端未回 options 时用; 与 host 侧 `config.minTurnMs ?? 60000` 一致）。 */
		const DEFAULT_OPTIONS = { minTurnMs: 60000, bannerSummary: true, reconcile: true };
		const MIN_TURN_MS_MAX = 3600000;
		const MIN_SEC_MAX = 3600;

		/** 旧 host（host 侧插件未更新）提示 —— 契约 §5 补充 ③/④。 */
		const OPTIONS_RPC_HINT = "host 插件未更新：本次改动里的『触发条件』与『关闭』要等 dsh web 重启后生效";
		const SAVED_STALE_TEXT = "✓ 已保存（触发条件/关闭需重启 dsh web 后生效）";

		/** 空表单。 */
		function emptyForm() {
			return { name: "", kind: "bark", url: "" };
		}
		function kindLabel(kind) {
			return KIND_LABEL[kind] || String(kind || "");
		}
		/** hasProducer 缺失(旧 host) ⇒ 视为 true（不得因此丢进"预留"折叠区）。 */
		function hasProducerOf(ty) {
			return !(ty && ty.hasProducer === false);
		}
		function emojiOf(type) {
			return TYPE_EMOJI[type] || "";
		}

		// ---------- 三态 / 路由语义 (契约 §1 三步 + §5 三态推导, 纯函数便于校验) ----------
		/** 契约 §5: 键存在且非空 ⇒ custom; 键存在且为空数组 ⇒ off; 无键(或非数组) ⇒ default。 */
		function modeFromRoutes(routes, type) {
			if (!routes || !Object.prototype.hasOwnProperty.call(routes, type)) return "default";
			var v = routes[type];
			if (!Array.isArray(v)) return "default";
			return v.length ? "custom" : "off";
		}
		function enabledIdsOf(devices) {
			return (devices || []).filter(function (d) { return d && d.enabled !== false; }).map(function (d) { return d.id; });
		}
		function filterEnabled(ids, devices) {
			var en = enabledIdsOf(devices);
			return (ids || []).filter(function (id) { return en.indexOf(id) >= 0; });
		}
		/** 默认路由解析结果（为空 ⇒ 发全部启用设备）—— "关闭 → 自选"的起点用它(不得变空)。 */
		function defaultResolvedIds(routeDefault, devices) {
			var list = (routeDefault && routeDefault.length) ? routeDefault : enabledIdsOf(devices);
			return filterEnabled(list, devices);
		}
		/** 契约 §1 三步语义的本地副本 —— 仅用于 ① 服务端未回 effective ② 默认路由草稿已改动。 */
		function resolveIdsLocal(routes, routeDefault, devices, type) {
			if (routes && Object.prototype.hasOwnProperty.call(routes, type) && Array.isArray(routes[type])) {
				return filterEnabled(routes[type], devices);
			}
			return defaultResolvedIds(routeDefault, devices);
		}
		function deviceNameOf(devices, id) {
			var hit = (devices || []).filter(function (d) { return d && d.id === id; })[0];
			return hit ? (hit.name || hit.id) : id;
		}
		function deviceNamesOf(devices, ids) {
			if (!ids || !ids.length) return "无";
			return ids.map(function (id) { return deviceNameOf(devices, id); }).join(" + ");
		}
		/** 契约 §3 规整: 越界/非法 ⇒ 夹到 [0,3600000] 整数; 非布尔 ⇒ 默认 true。 */
		function normalizeOptions(raw) {
			var src = (raw && typeof raw === "object") ? raw : {};
			var ms = src.minTurnMs;
			if (typeof ms !== "number" || !isFinite(ms)) ms = DEFAULT_OPTIONS.minTurnMs;
			ms = Math.round(ms);
			if (ms < 0) ms = 0;
			if (ms > MIN_TURN_MS_MAX) ms = MIN_TURN_MS_MAX;
			return {
				minTurnMs: ms,
				bannerSummary: typeof src.bannerSummary === "boolean" ? src.bannerSummary : DEFAULT_OPTIONS.bannerSummary,
				reconcile: typeof src.reconcile === "boolean" ? src.reconcile : DEFAULT_OPTIONS.reconcile
			};
		}
		/** 阈值输入(秒) 解析: 0…3600 整数, 否则 null(调用方给错误文案)。 */
		function parseSeconds(text) {
			var s = String(text === undefined || text === null ? "" : text).trim();
			if (!/^[0-9]+$/.test(s)) return null;
			var n = parseInt(s, 10);
			if (!(n >= 0 && n <= MIN_SEC_MAX)) return null;
			return n;
		}
		/**
		 * 契约 §5 保存语义: routes 用**完整映射** —— custom 行给 ids、off 行给 []、default 行不给键。
		 * 未知 type 不下发（host 侧 setRoutes 对未知 type 返回 bad-request, 会把整次保存打挂）。
		 */
		function buildRoutesPayload(routesMap, known) {
			var out = {};
			Object.keys(routesMap || {}).forEach(function (t) {
				if (known && !known[t]) return;
				var v = routesMap[t];
				if (!Array.isArray(v)) return;
				out[t] = v.slice();
			});
			return out;
		}

		// ---------- 样式 (nt-* 家族 = 预览 public/preview-notify-settings.html 已确认; 零新增色相) ----------
		function injectCss() {
			if (typeof document === "undefined") return;
			if (document.getElementById("dsh-nt-card-css")) return;
			var st = document.createElement("style");
			st.id = "dsh-nt-card-css";
			st.textContent = [
				// 卡自带主题色 (契约 §3.1/§3.2): **本卡显式声明**, 不走容器按 key 哈希分配 —— notify = business 蓝。
				// 胶囊外壳(border/圆角/背景/外层 padding)与整卡折叠已由容器 dsh-quick-insert 提供(契约 §5.1/§5.3)。
				".dsh-lp-card[data-lp-key=\"notify\"]{--lp-accent:#4176e6}",
				// 卡内**分组级**折叠保留(预留类型 / 高级): 取值 1:1 同款折叠家族, 前缀化为 .nt-details/.nt-arr
				".nt-details{border-top:1px dashed var(--dsw-alias-border-l2);padding-top:9px}",
				".nt-details[open]{padding-bottom:2px}",
				".nt-details summary{cursor:pointer;display:flex;align-items:center;gap:7px;color:var(--dsw-alias-label-secondary);font-size:12.5px;font-weight:600;user-select:none;padding:2px 0;list-style:none}",
				".nt-details summary::-webkit-details-marker{display:none}",
				".nt-details summary:hover{color:var(--dsw-alias-label-primary)}",
				".nt-arr{font-size:9px;color:var(--dsw-alias-label-tertiary);transition:transform .15s ease;flex:none}",
				".nt-details[open] summary .nt-arr{transform:rotate(90deg)}",
				".nt-badge{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 14%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 45%,transparent);color:var(--dsw-alias-state-business-primary,#4176e6);font-size:10.5px;font-weight:700;padding:0 9px;border-radius:10px;letter-spacing:.3px;line-height:17px;flex:none}",
				".nt-badge.nt-syn{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 14%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 45%,transparent);color:var(--dsw-alias-state-success-primary,#22c55e)}",
				".nt-note{background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#9aa3b2) 10%,transparent);border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;padding:6px 10px;font-size:11.5px;line-height:1.75;color:var(--dsw-alias-label-secondary)}",
				".nt-note b{color:var(--dsw-alias-state-business-primary,#4176e6);font-weight:600}",
				".nt-note code,.nt-flabel code,.nt-rt-type,.nt-id,.nt-tail{font-family:ui-monospace,'SF Mono',Consolas,monospace;font-size:10.5px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.12));border:1px solid var(--dsw-alias-border-l2);border-radius:4px;padding:0 4px}",
				".nt-hint,.nt-hint *{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}",
				".nt-hint.nt-warn{color:var(--dsw-alias-state-warn-primary,#f59e0b)}",
				".nt-sh{display:flex;align-items:center;gap:7px;flex-wrap:wrap;border-top:1px dashed var(--dsw-alias-border-l2);padding-top:9px;color:var(--dsw-alias-label-secondary);font-size:12.5px;font-weight:600}",
				".nt-tag{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 14%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 45%,transparent);color:var(--dsw-alias-state-business-primary,#4176e6);font-size:9.5px;font-weight:600;padding:0 7px;border-radius:8px;line-height:15px;flex:none}",
				// 设备列表 (设备区本次不改)
				".nt-list{display:grid;grid-template-columns:1fr;gap:6px}",
				".nt-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:7px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}",
				".nt-row[data-off=\"true\"]{opacity:.62}",
				".nt-name{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600}",
				".nt-id{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
				".nt-tail{font-size:11px;color:var(--dsw-alias-label-secondary)}",
				".nt-acts{margin-left:auto;display:flex;gap:4px;align-items:center;flex-wrap:wrap}",
				".nt-btn{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;height:26px;font:inherit;font-size:12px;line-height:24px;cursor:pointer;white-space:nowrap;flex:none}",
				".nt-btn:hover:not(:disabled){border-color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.12))}",
				".nt-btn:disabled{opacity:.45;cursor:default}",
				".nt-btn-solid{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 55%,transparent);color:var(--dsw-alias-state-business-primary,#4176e6);font-weight:600}",
				".nt-btn-solid:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 14%,transparent)}",
				".nt-btn-danger{color:var(--dsw-alias-state-danger-primary,#ef4444);border-color:color-mix(in srgb,var(--dsw-alias-state-danger-primary,#ef4444) 42%,transparent)}",
				".nt-btn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-danger-primary,#ef4444) 14%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-danger-primary,#ef4444) 42%,transparent)}",
				".nt-result{flex-basis:100%;font-size:11px;line-height:16px}",
				".nt-result.ok{color:var(--dsw-alias-state-success-primary,#22c55e)}",
				".nt-result.err{color:var(--dsw-alias-state-danger-primary,#ef4444)}",
				".nt-result.pending{color:var(--dsw-alias-state-warn-primary,#f59e0b)}",
				// 启用开关 (44×24, 同设置卡先例)
				".nt-switch{box-sizing:border-box;flex:none;width:44px;height:24px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#9aa3b2) 28%,transparent);cursor:pointer;padding:2px;transition:background .15s,border-color .15s}",
				".nt-switch::after{content:\"\";display:block;width:18px;height:18px;border-radius:50%;background:#fff;transition:transform .15s;box-shadow:0 1px 2px rgba(0,0,0,.3)}",
				".nt-switch[data-on=\"true\"]{background:var(--dsw-alias-state-success-primary,#22c55e);border-color:transparent}",
				".nt-switch[data-on=\"true\"]::after{transform:translateX(20px)}",
				// 行内编辑 / 添加表单 (设备区本次不改)
				".nt-edit,.nt-add{flex-basis:100%;display:grid;grid-template-columns:1fr 1fr;gap:8px 12px;align-items:end;border-top:1px dashed var(--dsw-alias-border-l2);padding-top:9px;margin-top:3px}",
				".nt-add{border-top:none;padding-top:0}",
				".nt-field{display:flex;flex-direction:column;gap:3px;min-width:0}",
				".nt-flabel{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}",
				".nt-input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);width:100%;min-width:0;height:30px;font:inherit;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 9px;font-size:12.5px;line-height:22px}",
				".nt-input:focus{border-color:var(--dsw-alias-state-business-primary,#4176e6);outline:none}",
				".nt-input::placeholder{color:var(--dsw-alias-label-tertiary)}",
				".nt-edit .nt-acts,.nt-add .nt-acts{margin-left:0;grid-column:1/-1}",
				// 通知项目分组 + 行 (契约 §5; 取值 1:1 预览 .nt-grp/.nt-grp-h/.nt-item/.nt-t/.nt-eff)
				".nt-grp{display:flex;flex-direction:column;gap:6px}",
				".nt-grp-h{display:flex;align-items:center;gap:7px;color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:700;letter-spacing:.4px}",
				".nt-item{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:7px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}",
				".nt-item[data-mode=\"off\"]{border-style:dashed;opacity:.86}",
				".nt-item[data-mode=\"default\"]{background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#9aa3b2) 6%,transparent)}",
				".nt-t{color:var(--dsw-alias-label-primary);font-size:12.5px;font-weight:600;flex:none}",
				".nt-eff{flex-basis:100%;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
				".nt-eff b{color:var(--dsw-alias-label-secondary);font-weight:600}",
				".nt-rt-type{color:var(--dsw-alias-label-primary);flex:none}",
				// 三态分段控件「默认｜自选｜关闭」
				".nt-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;overflow:hidden;flex:none;margin-left:auto}",
				".nt-seg button{border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;height:24px;padding:0 11px;cursor:pointer}",
				".nt-seg button+button{border-left:1px solid var(--dsw-alias-border-l2)}",
				".nt-seg button:hover:not([data-on=\"true\"]){background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.12))}",
				".nt-seg button[data-on=\"true\"]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 14%,transparent);color:var(--dsw-alias-state-business-primary,#4176e6);font-weight:600}",
				".nt-seg button[data-on=\"true\"][data-v=\"off\"]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 16%,transparent);color:var(--dsw-alias-state-warn-primary,#f59e0b)}",
				".nt-seg button:disabled{opacity:.55;cursor:default}",
				// 设备胶囊
				".nt-chips{display:flex;gap:5px;flex-wrap:wrap;align-items:center}",
				".nt-chip{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1;font-family:inherit;cursor:pointer;user-select:none;flex:none}",
				".nt-chip:hover:not(:disabled):not([data-inherit=\"true\"]){background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.12))}",
				".nt-chip .nt-dot{width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.45;flex:none}",
				".nt-chip[data-on=\"true\"]{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 14%,transparent);color:var(--dsw-alias-state-business-primary,#4176e6);font-weight:600}",
				".nt-chip[data-on=\"true\"] .nt-dot{opacity:1}",
				// default 态: 虚线只读(继承默认路由); off 态: 整行虚线弱化 + 胶囊一起弱化; 停用设备: 不可点
				".nt-chip[data-inherit=\"true\"]{border-style:dashed;cursor:default}",
				".nt-chip[data-inherit=\"true\"][data-on=\"true\"]{border-style:dashed;border-color:color-mix(in srgb,var(--dsw-alias-label-tertiary,#9aa3b2) 55%,transparent);background:transparent;color:var(--dsw-alias-label-secondary);font-weight:600}",
				".nt-chip[data-inherit=\"true\"][data-on=\"true\"] .nt-dot{opacity:1}",
				".nt-item[data-mode=\"off\"] .nt-chip{opacity:.5}",
				".nt-chip[data-dead=\"true\"]{border-style:dashed;opacity:.5}",
				// 触发条件区 (options)
				".nt-opts{display:grid;grid-template-columns:1fr;gap:7px}",
				".nt-opt{display:flex;gap:9px;align-items:center;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-primary)}",
				".nt-opt .nt-input{width:76px}",
				".nt-cb{width:15px;height:15px;accent-color:var(--dsw-alias-state-business-primary,#4176e6);flex:none}",
				// 徽标 / 保存状态
				".nt-mark{display:inline-flex;align-items:center;height:22px;padding:0 9px;border-radius:999px;font-size:10.5px;line-height:1;flex:none;white-space:nowrap}",
				".nt-mark.ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 14%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 45%,transparent);color:var(--dsw-alias-state-success-primary,#22c55e)}",
				".nt-mark.warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 14%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 45%,transparent);color:var(--dsw-alias-state-warn-primary,#f59e0b)}",
				".nt-status{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
				".nt-st{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:999px;font-size:11.5px;line-height:1;border:1px solid transparent;flex:none}",
				".nt-st.saving{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 14%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 45%,transparent);color:var(--dsw-alias-state-warn-primary,#f59e0b)}",
				".nt-st.saved{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 14%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 45%,transparent);color:var(--dsw-alias-state-success-primary,#22c55e)}",
				".nt-st.failed{background:color-mix(in srgb,var(--dsw-alias-state-danger-primary,#ef4444) 14%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-danger-primary,#ef4444) 45%,transparent);color:var(--dsw-alias-state-danger-primary,#ef4444)}",
				".nt-err{color:var(--dsw-alias-state-danger-primary,#ef4444);font-size:10.5px;line-height:14px}",
				"@media (max-width:640px){.nt-edit,.nt-add{grid-template-columns:1fr}}"
			].join("\n");
			(document.head || document.documentElement).appendChild(st);
		}

		// ---------- 控制器: /notify-hub RPC + snapshot store (仿「模型与密钥」卡) ----------
		function createController(connection) {
			var store = createSnapshotStore({ status: "loading", loaded: false, data: null, error: "" });
			var lastValue = null;
			function call(endpoint, payload) {
				var rpc = connection && connection.rpc;
				if (!rpc || typeof rpc.call !== "function") {
					return Promise.resolve({ ok: false, error: { code: "unavailable", message: "connection 服务不可用" } });
				}
				return rpc.call(CHANNEL, endpoint, payload || {}).then(function (result) {
					return result && typeof result === "object" ? result : { ok: false, error: { code: "bad-response", message: "响应格式异常" } };
				}).catch(function (err) {
					return { ok: false, error: { code: "transport", message: String((err && err.message) || err) } };
				});
			}
			function publish(value) {
				lastValue = value;
				store.set({ status: "ready", loaded: true, data: value, error: "" });
				return value;
			}
			function fail(message) {
				store.set({ status: "error", loaded: lastValue !== null, data: lastValue, error: message || "读取失败" });
			}
			/** get: 卡加载即拉取 (服务端为权威源; 只回 urlTail, 无明文; 回 types/effective/options)。 */
			function refresh() {
				return call("get", {}).then(function (res) {
					var value = res && res.ok ? res.value : null;
					if (value && typeof value === "object") { publish(value); return value; }
					fail(res && res.error && res.error.message);
					return null;
				});
			}
			refresh();
			return {
				store: store,
				refresh: refresh,
				/** payload: { id?, name, kind, url?, enabled? } —— url 缺省/空串 = 保留原 url (§4)。 */
				saveDevice: function (payload) {
					return call("saveDevice", payload).then(function (res) {
						if (res && res.ok) refresh();
						return res;
					});
				},
				deleteDevice: function (id) {
					return call("deleteDevice", { id: id }).then(function (res) {
						if (res && res.ok) refresh();
						return res;
					});
				},
				/** payload: { routeDefault?, routes? } —— routes 为完整映射: custom ⇒ ids, off ⇒ [] (显式零请求)。 */
				setRoutes: function (payload) {
					return call("setRoutes", payload).then(function (res) {
						if (res && res.ok) refresh();
						return res;
					});
				},
				/**
				 * payload: { minTurnMs?, bannerSummary?, reconcile? } —— 契约 §4 新增端点。
				 * 旧 host 无此端点 ⇒ 返回 { ok:false }, 调用方按"只提示不判整次失败"降级(契约 §5 补充 ③)。
				 */
				setOptions: function (payload) {
					return call("setOptions", payload).then(function (res) {
						if (res && res.ok) refresh();
						return res;
					});
				},
				/** 只打被点的那一台; value = { id, status:"ok"|"fail", error? }。 */
				test: function (id) {
					return call("test", { id: id });
				}
			};
		}

		// ---------- 「通知（Bark / 群晖）」设置卡 ----------
		function NotifyCard(props) {
			var state = props.useNotifyHub(function (s) { return s; });
			var h = react.createElement;
			var data = state && state.data;
			var loaded = !!(state && state.loaded);
			var devices = data && Array.isArray(data.devices) ? data.devices : [];
			var types = data && Array.isArray(data.types) && data.types.length ? data.types : TYPES_FALLBACK;
			var enabledCount = devices.filter(function (d) { return d && d.enabled !== false; }).length;
			var serverRoutes = (data && data.routes && typeof data.routes === "object") ? data.routes : {};
			var serverDefault = (data && Array.isArray(data.routeDefault)) ? data.routeDefault : [];
			var serverEffective = (data && data.effective && typeof data.effective === "object") ? data.effective : {};
			var serverOptions = normalizeOptions(data && data.options);
			// 旧 host 探测(契约 §5 补充): 新 host 的 get 必回 options ⇒ 缺失 = host 侧插件未更新
			var staleHost = !(data && data.options && typeof data.options === "object");

			var [editing, setEditing] = react.useState(null);          // { id, form } —— 行内编辑
			var [addForm, setAddForm] = react.useState(emptyForm());   // 添加设备表单
			var [draftRoutes, setDraftRoutes] = react.useState({});    // 通知项目路由草稿 (routes 完整映射)
			var [draftDefault, setDraftDefault] = react.useState([]);  // 默认路由草稿
			var [draftSec, setDraftSec] = react.useState(String(Math.round(serverOptions.minTurnMs / 1000))); // 阈值(秒)草稿
			var [draftBanner, setDraftBanner] = react.useState(serverOptions.bannerSummary);
			var [draftReconcile, setDraftReconcile] = react.useState(serverOptions.reconcile);
			var [staleOpts, setStaleOpts] = react.useState(false);     // setOptions 失败(旧 host) ⇒ 只提示不判失败
			var [busy, setBusy] = react.useState(false);
			var [error, setError] = react.useState("");                // 卡的全局错误/负向反馈
			var [editErrs, setEditErrs] = react.useState({});        // 编辑表单字段错误
			var [addErrs, setAddErrs] = react.useState({});           // 添加表单字段错误
			var [tests, setTests] = react.useState({});                // id -> { pending } | { status, error }
			var [savedAt, setSavedAt] = react.useState(null);
			var [savedStale, setSavedStale] = react.useState(false);   // 本次"已保存"是否为降级提示文案
			var flashTimer = react.useRef(null);
			react.useEffect(function () {
				return function () { if (flashTimer.current) clearTimeout(flashTimer.current); };
			}, []);
			/** 服务端快照变化 → 重置草稿 (服务端为权威源; 「重新加载」也走这里)。 */
			react.useEffect(function () {
				if (!data) return;
				setDraftRoutes(serverRoutes);
				setDraftDefault(serverDefault);
				setDraftSec(String(Math.round(serverOptions.minTurnMs / 1000)));
				setDraftBanner(serverOptions.bannerSummary);
				setDraftReconcile(serverOptions.reconcile);
			}, [data]);

			function flashSaved(stale) {
				setSavedStale(!!stale);
				setSavedAt(Date.now());
				if (flashTimer.current) clearTimeout(flashTimer.current);
				flashTimer.current = setTimeout(function () { setSavedAt(null); }, 1800);
			}
			function errText(res, fallback) {
				return (res && res.error && res.error.message) || fallback;
			}
			/** 客户端即时校验 (服务端仍强制; 这里只为省一次往返)。 */
			function validate(form, requireUrl) {
				var errs = {};
				var name = String(form.name || "").trim();
				if (!name) errs.name = "名称不能为空";
				else if (name.length > 32) errs.name = "不能超过 32 个字符";
				var url = String(form.url || "").trim();
				if (url && !URL_RE.test(url)) errs.url = "必须以 http(s):// 开头";
				else if (!url && requireUrl) errs.url = "URL 不能为空";
				return errs;
			}

			function startEdit(dev) {
				setError("");
				setEditErrs({});
				setEditing({ id: dev.id, form: { name: dev.name || dev.id, kind: dev.kind || "bark", url: "" } });
			}
			function patchEdit(next) { setEditing(Object.assign({}, editing, { form: Object.assign({}, editing.form, next) })); }
			function submitEdit() {
				if (!editing) return;
				var errs = validate(editing.form, false);
				if (Object.keys(errs).length) { setEditErrs(errs); return; }
				setEditErrs({});
				setError("");
				setBusy(true);
				var payload = { id: editing.id, name: editing.form.name.trim(), kind: editing.form.kind };
				var url = String(editing.form.url || "").trim();
				if (url) payload.url = url;            // 留空 = 不修改 (不下发 url 字段)
				props.saveDevice(payload).then(function (res) {
					setBusy(false);
					if (res && res.ok) { setEditing(null); setError(""); flashSaved(false); }
					else setError(errText(res, "保存设备失败"));
				}, function () { setBusy(false); setError("保存设备失败"); });
			}
			function submitAdd() {
				var errs = validate(addForm, true);
				if (Object.keys(errs).length) { setAddErrs(errs); return; }
				setAddErrs({});
				setError("");
				setBusy(true);
				props.saveDevice({ name: addForm.name.trim(), kind: addForm.kind, url: String(addForm.url).trim() }).then(function (res) {
					setBusy(false);
					if (res && res.ok) { setAddForm(emptyForm()); setError(""); flashSaved(false); }
					else setError(errText(res, "添加设备失败"));
				}, function () { setBusy(false); setError("添加设备失败"); });
			}
			function toggleDevice(dev) {
				setError("");
				setBusy(true);
				props.saveDevice({ id: dev.id, name: dev.name, kind: dev.kind, enabled: dev.enabled === false }).then(function (res) {
					setBusy(false);
					if (res && res.ok) { setError(""); flashSaved(false); }
					else setError(errText(res, "切换启用状态失败"));
				}, function () { setBusy(false); setError("切换启用状态失败"); });
			}
			function removeDevice(dev) {
				setError("");
				setBusy(true);
				props.deleteDevice(dev.id).then(function (res) {
					setBusy(false);
					if (res && res.ok) {
						if (editing && editing.id === dev.id) setEditing(null);
						// deleteDevice 同时从 routeDefault 与所有 routes 剔除该 id (服务端行为)
						setError("");
						flashSaved(false);
					} else setError(errText(res, "删除设备失败"));
				}, function () { setBusy(false); setError("删除设备失败"); });
			}
			function runTest(dev) {
				setError("");
				setTests(function (prev) { return Object.assign({}, prev, { [dev.id]: { pending: true } }); });
				props.test(dev.id).then(function (res) {
					// §4: value = { id, status: "ok"|"fail", error? }
					var v = res && res.ok && res.value ? res.value : null;
					var next = v
						? (v.status === "ok" ? { status: "ok" } : { status: "fail", error: v.error || "发送失败" })
						: { status: "fail", error: errText(res, "发送失败") };
					setTests(function (prev) { return Object.assign({}, prev, { [dev.id]: next }); });
				}, function (err) {
					setTests(function (prev) {
						return Object.assign({}, prev, { [dev.id]: { status: "fail", error: String((err && err.message) || err) } });
					});
				});
			}

			// ---- 通知项目 (契约 §5): 三态推导 = routes 键判定; 胶囊显示"实际发往谁" ----
			/** 行内胶囊显示的设备集: off ⇒ 空; custom ⇒ 草稿; default ⇒ 服务端 effective(权威)或本地回退解析。 */
			function rowEffIds(type, mode) {
				if (mode === "off") return [];
				if (mode === "custom") return filterEnabled(draftRoutes[type], devices);
				var defaultDirty = JSON.stringify(draftDefault) !== JSON.stringify(serverDefault);
				if (!defaultDirty && Array.isArray(serverEffective[type])) return filterEnabled(serverEffective[type], devices);
				return defaultResolvedIds(draftDefault, devices);
			}
			/** 分段控件: 切 custom ⇒ 以当前 effective 为起点(原为 off ⇒ 默认路由解析结果, 不得变空); off ⇒ []; default ⇒ 删键。 */
			function setRowMode(type, v) {
				setDraftRoutes(function (prev) {
					var mode = modeFromRoutes(prev, type);
					if (v === mode) return prev;
					var next = Object.assign({}, prev);
					if (v === "custom") {
						next[type] = (mode === "off" ? defaultResolvedIds(draftDefault, devices) : rowEffIds(type, "default")).slice();
					} else if (v === "off") {
						next[type] = [];
					} else {
						delete next[type];
					}
					return next;
				});
			}
			/** 默认态只读(胶囊 no-op); off 态不可点; 只有 custom 态可勾/去勾。 */
			function toggleRowChip(type, id) {
				setDraftRoutes(function (prev) {
					if (modeFromRoutes(prev, type) !== "custom") return prev;
					var arr = (prev[type] || []).slice();
					var i = arr.indexOf(id);
					if (i >= 0) arr.splice(i, 1); else arr.push(id);
					var next = Object.assign({}, prev);
					next[type] = arr;
					return next;
				});
			}
			function toggleDefault(id) {
				setDraftDefault(function (prev) {
					var arr = prev.slice();
					var i = arr.indexOf(id);
					if (i >= 0) arr.splice(i, 1); else arr.push(id);
					return arr;
				});
			}
			/** 保存: 先 setRoutes(完整 routes 映射) 再 setOptions; setOptions 不可用(旧 host) ⇒ 降级提示, 不判失败。 */
			function saveAll() {
				var sec = parseSeconds(draftSec);
				if (sec === null) { setError("回合耗时阈值需为 0…3600 的整数（秒）"); return; }
				var known = {};
				types.forEach(function (t) { if (t && t.type) known[t.type] = true; });
				setBusy(true);
				setError("");
				props.setRoutes({
					routeDefault: draftDefault.slice(),
					routes: buildRoutesPayload(draftRoutes, known)
				}).then(function (res) {
					if (!(res && res.ok)) { setBusy(false); setError(errText(res, "保存路由失败")); return; }
					props.setOptions({
						minTurnMs: sec * 1000,
						bannerSummary: !!draftBanner,
						reconcile: !!draftReconcile
					}).then(function (res2) {
						setBusy(false);
						if (res2 && res2.ok) { setError(""); setStaleOpts(false); flashSaved(false); }
						else { setError(""); setStaleOpts(true); flashSaved(true); }   // 旧 host: 路由已存, 只提示选项待重启
					}, function () { setBusy(false); setError(""); setStaleOpts(true); flashSaved(true); });
				}, function () { setBusy(false); setError("保存路由失败"); });
			}

			// ---- 折叠标题行已移交 summary 槽 (契约 §5.2/§5.4): 本卡只提供 body, 不再自绘标题行/徽标行/箭头 ----
			var note = h("div", { className: "nt-note" }, [
				h("b", null, "逐项可配："),
				"每行选「默认 / 自选 / 关闭」，行尾写明",
				h("b", null, "实际发往谁"),
				"；",
				h("b", null, "关闭"),
				" = 写显式空路由（旧版空值会回落默认路由 ⇒ 关不掉）。",
				h("br"),
				h("b", null, "明文只上行："),
				"完整 URL（Bark key / 群晖 webhook）只在保存时上行，列表、响应与日志只回尾号。"
			]);

			if (!loaded) {
				// body 顶层直出 (契约 §5.1/§5.3): 无 .nt-card 外壳、无整卡 <details>
				return h(react.Fragment, null, [
					note,
					h("div", { className: "nt-hint" }, state && state.status === "error"
						? "读取失败：" + (state.error || "") + "（RPC /notify-hub 未注册？）"
						: "加载中…")
				]);
			}

			// ---- ① 设备列表 (本次不改) ----
			function kindBadge(kind) {
				return h("span", { className: "nt-badge" + (kind === "bark" ? "" : " nt-syn") }, kindLabel(kind));
			}
			function resultEl(dev) {
				var r = tests[dev.id];
				if (!r) return null;
				if (r.pending) return h("span", { className: "nt-result pending" }, "◌ 发送中…（只打这一台）");
				if (r.status === "ok") return h("span", { className: "nt-result ok" }, "✓ 已发送");
				return h("span", { className: "nt-result err" }, "✗ 失败：" + (r.error || "发送失败"));
			}
			function editFormEl(dev) {
				if (!editing || editing.id !== dev.id) return null;
				var f = editing.form;
				return h("div", { className: "nt-edit" }, [
					h("label", { className: "nt-field" }, [
						h("span", { className: "nt-flabel" }, "名称"),
						h("input", { className: "nt-input", value: f.name, disabled: busy, onChange: function (e) { patchEdit({ name: e.target.value }); } }),
						editErrs.name ? h("span", { className: "nt-err" }, editErrs.name) : null
					]),
					h("label", { className: "nt-field" }, [
						h("span", { className: "nt-flabel" }, "类型 kind"),
						h("select", { className: "nt-input", value: f.kind, disabled: busy, onChange: function (e) { patchEdit({ kind: e.target.value }); } },
							KINDS.map(function (k) { return h("option", { key: k.id, value: k.id }, k.label); }))
					]),
					h("label", { className: "nt-field", style: { gridColumn: "1/-1" } }, [
						h("span", { className: "nt-flabel" }, "完整 URL（含 key / webhook）", h("code", null, "只上行")),
						h("input", {
							className: "nt-input", type: "password", value: f.url, disabled: busy,
							placeholder: "留空 = 不修改（当前 " + (dev.urlTail || "—") + "）",
							onChange: function (e) { patchEdit({ url: e.target.value }); }
						}),
						editErrs.url ? h("span", { className: "nt-err" }, editErrs.url) : null
					]),
					h("div", { className: "nt-acts" }, [
						h("button", { type: "button", className: "nt-btn nt-btn-solid", disabled: busy, onClick: submitEdit }, "保存设备"),
						h("button", { type: "button", className: "nt-btn", disabled: busy, onClick: function () { setEditing(null); setEditErrs({}); } }, "取消"),
						h("span", { className: "nt-hint" }, "服务端只回 urlTail，不回明文")
					])
				]);
			}
			var deviceRows = devices.map(function (dev) {
				var on = dev.enabled !== false;
				return h("div", { className: "nt-row", key: dev.id, "data-off": on ? "false" : "true" }, [
					h("span", { className: "nt-name" }, dev.name || dev.id),
					kindBadge(dev.kind),
					h("code", { className: "nt-id" }, dev.id),
					h("code", { className: "nt-tail", title: "只回显尾号，明文永不下发" }, dev.urlTail || "—"),
					h("span", { className: "nt-hint" }, "urlTail"),
					h("span", { className: "nt-acts" }, [
						h("button", {
							type: "button", className: "nt-switch", disabled: busy,
							"data-on": on ? "true" : "false", "aria-pressed": on ? "true" : "false",
							title: on ? "点击停用该设备" : "点击启用该设备",
							onClick: function () { toggleDevice(dev); }
						}),
						h("button", { type: "button", className: "nt-btn", disabled: busy, onClick: function () { runTest(dev); } }, "测试推送"),
						h("button", {
							type: "button", className: "nt-btn", disabled: busy,
							onClick: function () { if (editing && editing.id === dev.id) { setEditing(null); setEditErrs({}); } else startEdit(dev); }
						}, editing && editing.id === dev.id ? "收起" : "编辑"),
						h("button", { type: "button", className: "nt-btn nt-btn-danger", disabled: busy, onClick: function () { removeDevice(dev); } }, "删除")
					]),
					resultEl(dev),
					editFormEl(dev)
				]);
			});

			// ---- ② 添加设备 (本次不改) ----
			var addEl = h("div", { className: "nt-add" }, [
				h("label", { className: "nt-field" }, [
					h("span", { className: "nt-flabel" }, "名称"),
					h("input", {
						className: "nt-input", value: addForm.name, disabled: busy, placeholder: "例如：我的手机",
						onChange: function (e) { setAddForm(Object.assign({}, addForm, { name: e.target.value })); }
					}),
					addErrs.name ? h("span", { className: "nt-err" }, addErrs.name) : null
				]),
				h("label", { className: "nt-field" }, [
					h("span", { className: "nt-flabel" }, "类型 kind"),
					h("select", {
						className: "nt-input", value: addForm.kind, disabled: busy,
						onChange: function (e) { setAddForm(Object.assign({}, addForm, { kind: e.target.value })); }
					}, KINDS.map(function (k) { return h("option", { key: k.id, value: k.id }, k.label); }))
				]),
				h("label", { className: "nt-field", style: { gridColumn: "1/-1" } }, [
					h("span", { className: "nt-flabel" }, "完整 URL（含 key / webhook，仅上行）"),
					h("input", {
						className: "nt-input", type: "password", value: addForm.url, disabled: busy,
						placeholder: "https://api.day.app/…（Bark）或群晖 webhook URL",
						onChange: function (e) { setAddForm(Object.assign({}, addForm, { url: e.target.value })); }
					}),
					addErrs.url ? h("span", { className: "nt-err" }, addErrs.url) : null
				]),
				h("div", { className: "nt-acts" }, [
					h("button", { type: "button", className: "nt-btn nt-btn-solid", disabled: busy, onClick: submitAdd }, "+ 添加设备"),
					h("span", { className: "nt-hint" }, "id 由服务端自动生成（bark1… / chat…）、enabled 默认 true；保存后列表只显示尾号")
				])
			]);

			// ---- ③ 通知项目 (契约 §5: 分组 / 三态 / 实际发往 / 预留类型折叠) ----
			function segEl(type, v, text, mode) {
				return h("button", {
					type: "button", key: v, "data-v": v, "data-seg": type,
					"data-on": mode === v ? "true" : "false", disabled: busy,
					onClick: function () { setRowMode(type, v); }
				}, text);
			}
			function rowEl(ty) {
				var type = ty.type;
				var mode = modeFromRoutes(draftRoutes, type);
				var eff = rowEffIds(type, mode);
				var emoji = emojiOf(type);
				var label = ty.label || type;
				var effText = mode === "off"
					? "不推送（该类型已关闭）"
					: deviceNamesOf(devices, eff) + "（" + eff.length + " 台" + (mode === "default" ? " · 继承默认路由" : "") + "）";
				var rowNote = ROW_NOTES[type];
				return h("div", { className: "nt-item", key: type, "data-mode": mode }, [
					h("span", { className: "nt-t" }, emoji ? emoji + " " + label : label),
					h("code", { className: "nt-rt-type" }, type),
					h("span", { className: "nt-chips" }, devices.map(function (dev) {
						var on = eff.indexOf(dev.id) >= 0;
						var inherit = mode === "default";
						var dead = dev.enabled === false;
						return h("button", {
							type: "button", key: dev.id, className: "nt-chip",
							disabled: busy || mode === "off" || dead,
							"data-on": on ? "true" : "false",
							"data-inherit": inherit ? "true" : undefined,
							"data-dead": dead ? "true" : undefined,
							"data-t": type, "data-d": dev.id,
							title: inherit ? "继承默认路由（只读）：改默认路由见最下方高级" : (dead ? "该设备已停用" : ""),
							onClick: function () { toggleRowChip(type, dev.id); }
						}, [h("span", { className: "nt-dot", key: "d" }), dev.name || dev.id]);
					})),
					h("span", { className: "nt-seg" }, [
						segEl(type, "default", "默认", mode),
						segEl(type, "custom", "自选", mode),
						segEl(type, "off", "关闭", mode)
					]),
					h("span", { className: "nt-eff" }, [
						"实际发往：",
						h("b", null, effText),
						rowNote ? " · " + rowNote : null
					])
				]);
			}
			/** 预留类型行 (hasProducer===false): 只标注, 不可交互。 */
			function reservedRowEl(ty) {
				var emoji = emojiOf(ty.type);
				var label = ty.label || ty.type;
				return h("div", { className: "nt-item", key: ty.type, "data-mode": "off" }, [
					h("span", { className: "nt-t" }, emoji ? emoji + " " + label : label),
					h("code", { className: "nt-rt-type" }, ty.type),
					h("span", { className: "nt-mark warn" }, "暂无来源"),
					h("span", { className: "nt-eff" }, "代码里查不到调用方（Stage 1 预留），本次只做标注，不删 key 以免将来接线时丢配置")
				]);
			}
			var activeTypes = types.filter(function (t) { return t && t.type && hasProducerOf(t); });
			var reservedTypes = types.filter(function (t) { return t && t.type && t.hasProducer === false; });
			var usedType = {};
			var grouped = GROUPS.map(function (g) {
				var rows = activeTypes.filter(function (t) {
					if (usedType[t.type] || !g.match(t.type)) return false;
					usedType[t.type] = true;
					return true;
				});
				return { title: g.title, rows: rows };
			});
			// 未知但有生产者的 type ⇒ 兜底归「其它」, 避免服务端新增 type 时静默消失
			var leftovers = activeTypes.filter(function (t) { return !usedType[t.type]; });
			if (leftovers.length) grouped[OTHER_GROUP].rows = grouped[OTHER_GROUP].rows.concat(leftovers);

			var typeSection = h(react.Fragment, null, [
				h("div", { className: "nt-sh", key: "h" }, [
					"通知项目",
					h("span", { className: "nt-tag" }, "逐项独立"),
					h("span", { className: "nt-hint" }, "按\"事情\"分组；对话三项本次从共用 task.done 拆分出来")
				]),
				grouped.map(function (g) {
					if (!g.rows.length) return null;
					return h("div", { className: "nt-grp", key: g.title },
						[h("div", { className: "nt-grp-h", key: "t" }, g.title)].concat(g.rows.map(rowEl)));
				}),
				reservedTypes.length ? h("details", { className: "nt-details", key: "reserved" }, [
					h("summary", null, [
						h("span", { className: "nt-arr", key: "a" }, "▶"),
						"预留类型（当前",
						h("b", { key: "b" }, "无任何生产者"),
						"，永不触发 · 点开看一眼）"
					]),
					h("div", { className: "nt-grp", style: { marginTop: 7 } }, reservedTypes.map(reservedRowEl))
				]) : null
			]);

			// ---- ④ 触发条件 (options) ----
			var stale = staleOpts || staleHost;
			var optionsSection = h(react.Fragment, null, [
				h("div", { className: "nt-sh", key: "h" }, [
					"触发条件",
					h("span", { className: "nt-tag" }, "options"),
					h("span", { className: "nt-hint" }, "原来只写在 cordis.patch.yml 的项，本次搬进卡里，改完即时生效")
				]),
				h("div", { className: "nt-opts", key: "o" }, [
					h("label", { className: "nt-opt" }, [
						"回合耗时阈值 ",
						h("input", {
							className: "nt-input", type: "number", min: 0, max: MIN_SEC_MAX, step: 1,
							value: draftSec, disabled: busy,
							onChange: function (e) { setDraftSec(e.target.value); }
						}),
						" 秒",
						h("span", { className: "nt-hint" }, "短于该时长的回合不推\"对话完成\"（提问推送不受限制）")
					]),
					h("label", { className: "nt-opt" }, [
						h("input", {
							type: "checkbox", className: "nt-cb", checked: draftBanner, disabled: busy,
							onChange: function (e) { setDraftBanner(e.target.checked); }
						}),
						" 回复含\"总结\"段落时，在会话内注入横幅（本地提醒，不推送）"
					]),
					h("label", { className: "nt-opt" }, [
						h("input", {
							type: "checkbox", className: "nt-cb", checked: draftReconcile, disabled: busy,
							onChange: function (e) { setDraftReconcile(e.target.checked); }
						}),
						" 容器重启后补推被中断的回合（去重，不重复打扰）"
					])
				]),
				stale ? h("div", { className: "nt-hint nt-warn", key: "w" }, OPTIONS_RPC_HINT) : null
			]);

			// ---- ⑤ 高级折叠区 (routeDefault 胶囊可点, 参与保存) ----
			var advancedSection = h("details", { className: "nt-details" }, [
				h("summary", null, [
					h("span", { className: "nt-arr", key: "a" }, "▶"),
					"高级：默认路由 / 原始配置（排障用）"
				]),
				h("div", { style: { marginTop: 7, display: "flex", flexDirection: "column", gap: 7 } }, [
					h("div", { className: "nt-item" }, [
						h("code", { className: "nt-rt-type" }, "routeDefault"),
						h("span", { className: "nt-hint" }, "\"默认\"态的行走这里"),
						h("span", { className: "nt-chips" }, devices.map(function (dev) {
							var on = draftDefault.indexOf(dev.id) >= 0;
							return h("button", {
								type: "button", key: dev.id, className: "nt-chip", disabled: busy,
								"data-on": on ? "true" : "false",
								onClick: function () { toggleDefault(dev.id); }
							}, [h("span", { className: "nt-dot", key: "d" }), dev.name || dev.id]);
						})),
						h("span", { className: "nt-mark ok" }, "已勾 " + draftDefault.length + " 台"),
						h("span", { className: "nt-eff" }, [
							"当前默认路由：",
							h("b", null, deviceNamesOf(devices, draftDefault)),
							"（为空则 = 发全部启用设备）"
						])
					]),
					h("div", { className: "nt-hint" }, [
						"写盘位置 ",
						h("code", null, "/data/dsh/notify-hub.json"),
						"（0600，dsh-notify 写 / auth-proxy 读）；本卡改动",
						h("b", null, "无需重启"),
						"即时生效。"
					])
				])
			]);

			// ---- ⑥ 操作栏 + 保存三态 ----
			// 优先级: 失败 > 保存中 > 已保存 > 静止提示 (避免「已保存」闪烁遮住随后的失败信息)
			var live = error
				? h("span", { className: "nt-st failed" }, "✗ " + error)
				: busy
					? h("span", { className: "nt-st saving" }, "保存中…")
					: savedAt !== null
						? h("span", { className: "nt-st saved" }, savedStale ? SAVED_STALE_TEXT : "✓ 已保存")
						: h("span", { className: "nt-hint" }, "改动后点「保存」写入；保存即时生效（无需重启）");
			var actions = h("div", { className: "nt-acts", style: { marginLeft: 0 } }, [
				h("button", { type: "button", className: "nt-btn nt-btn-solid", disabled: busy, onClick: saveAll }, "保存"),
				h("button", {
					type: "button", className: "nt-btn", disabled: busy,
					onClick: function () { setError(""); setSavedStale(false); setStaleOpts(false); props.refresh(); }
				}, "重新加载"),
				live
			]);

			// body 顶层直出 (契约 §5.1/§5.3): 原 fold 内部结构原样上提为 body 顶层,
			// 间距由容器 .dsh-lp-body(flex column + gap:var(--lp-gap)) 提供
			return h(react.Fragment, null, [
				note,
				h("div", { className: "nt-sh" }, [
					"设备",
					h("span", { className: "nt-tag" }, devices.length + " 台 · " + (devices.length - enabledCount) + " 台停用"),
					h("span", { className: "nt-hint" }, "每行：名称 · kind 徽标 · URL 尾号 · 启用开关 · 测试推送 / 编辑 / 删除")
				]),
				deviceRows.length ? h("div", { className: "nt-list" }, deviceRows) : h("div", { className: "nt-hint" }, "尚未配置任何设备"),
				addEl,
				typeSection,
				optionsSection,
				advancedSection,
				actions
			]);
		}

		// ---------- 通知卡 · summary (折叠标题行: 图标 + 标题 + 徽标 + 实时摘要, 契约 §5.1/§5.4) ----------
		// 与 item 卡共用同一个 inject 返回值 (同一 controller.store) ⇒ 摘要随 store 实时刷新
		function NotifySummary(props) {
			var state = props.useNotifyHub(function (s) { return s; });
			var loaded = !!(state && state.loaded);
			var d = state && state.data;
			var list = d && Array.isArray(d.devices) ? d.devices : [];
			var n = list.length;
			var m = list.filter(function (x) { return x && x.enabled !== false; }).length;
			// 契约 §5: K = types.filter(hasProducer).length（权威 types 来自 get; 未回则用冻结兜底表）
			var srcTypes = d && Array.isArray(d.types) && d.types.length ? d.types : TYPES_FALLBACK;
			var k = srcTypes.filter(hasProducerOf).length;
			return react.createElement(react.Fragment, null, [
				react.createElement("span", { className: "lp-ico", key: "ico" }, "🔔"),
				react.createElement("span", { className: "lp-title", key: "title" }, "通知（Bark / 群晖）"),
				react.createElement("span", { className: "lp-badge", key: "badge" }, "本地插件"),
				react.createElement("span", { className: "lp-hint", key: "hint" },
					loaded ? n + " 台设备（" + m + " 台启用）· " + k + " 个通知项目" : "读取中…")
			]);
		}

		// ---------- 注册 ----------
		var inject = ["slots", "locale", "connection"];
		// 中文卡 (zh 即 en, 免英文回退缺失)
		var dict = {};
		/** 控制器实例 (apply 内赋值; 两个槽的 inject 共用)。 */
		var controller = null;
		// item / summary 两个槽共用同一 inject 返回值 (契约 §1: summary props 契约 = item 卡)
		function cardInjected() {
			return {
				hooks: { notifyHub: controller.store },
				refresh: controller.refresh,
				saveDevice: controller.saveDevice,
				deleteDevice: controller.deleteDevice,
				setRoutes: controller.setRoutes,
				setOptions: controller.setOptions,
				test: controller.test
			};
		}

		function apply(ctx) {
			injectCss();
			ctx.effect(function () { return ctx.locale.register(NS, { zh: dict, en: dict }); }, "ui-notify: settings card dictionaries");
			controller = createController(ctx.get("connection"));

			// 设置菜单「本地插件」列: 「通知（Bark / 群晖）」卡 body 槽 (外壳/整卡折叠由容器提供)
			ctx.slots.inject("settings.localplugin.item", function () {
				return ctx.slots.register({
					name: "settings.localplugin.item",
					key: ROW_ID,
					locale: NS,
					inject: cardInjected
				}, NotifyCard);
			});

			// 同卡的 summary 兄弟槽 (key 必须与 item 相同): 只提供折叠标题行 (图标/标题/徽标/实时摘要)。
			// 槽不可用时静默降级 —— 容器检测不到该 key 的 summary 会走 .dsh-lp-flat (零破坏)
			try {
				ctx.slots.inject("settings.localplugin.summary", function () {
					try {
						return ctx.slots.register({
							name: "settings.localplugin.summary",
							key: ROW_ID,
							locale: NS,
							inject: cardInjected
						}, NotifySummary);
					} catch (e) { return function () {}; }
				});
			} catch (e) { /* summary 槽不可用: 静默 (容器侧自动降级) */ }
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
