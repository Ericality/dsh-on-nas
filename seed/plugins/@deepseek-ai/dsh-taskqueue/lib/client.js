window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-taskqueue",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");
		var { createSnapshotStore } = require("@deepseek-ai/dsh-client-runtime/client");

		// ═══════════════════════════════════════════════════════════════════
		// dsh-taskqueue 客户端 (v0.7.0 新增 / v0.8.0 提示换位 + 单会话豁免)
		//
		// 1) 错峰出行模式 (offpeak mode):
		//    - 设置菜单「本地插件」列新增「任务队列」卡: 开关 + 当前状态显示
		//    - 开启后高峰期间: 所有消息 (已有/新会话) 默认入队 —— 包装
		//      connection.api.sessions.prompt, 当 开关开 + 当前高峰 + 纯文本时
		//      不发给 LLM, 改调 /queue RPC add 入队 (绑当前会话, 服务端注入
		//      蓝色队列横幅), 并向 composer 返回模拟成功 (accepted: true) 清空输入框。
		//      平峰期间或关闭状态: 原样放行 (正常发送)。
		//    - 斜杠命令不走 session.prompt (走 commands.execute), 天然不受拦截。
		//    - v0.8.0 单会话豁免: 服务端持久化 exempt map (offpeak-mode.json),
		//      豁免会话高峰照常发送; 拦截器命中条件加 !exempt[sessionId]。
		// 2) 提示位置 (v0.8.0): 取代 v0.7.0 输入框上方悬浮状态条 (conversation.input.dock),
		//    移入输入框底部工具行 Full access 选择器右侧 (conversation.input.left 槽):
		//    紧凑药丸 —— 高峰琥珀「高峰 · 自动入队」+「本会话立即发送」小开关 (豁免);
		//    豁免绿 / 平峰绿「平峰 · 正常发送」(无开关); 模式关闭不渲染。
		//    输入框边框随状态着色 (:has() 纯 CSS, 高峰琥珀 / 豁免绿; 平峰不着色)。
		// ═══════════════════════════════════════════════════════════════════

		var NS = "ui-taskqueue";
		var CARD_KEY = "taskqueue";

		// ---------- 文案 ----------
		var zh = {
			cardTitle: "任务队列",
			cardHint: "低谷价时段自动执行 · 队列面板 / 错峰出行模式",
			modeOn: "错峰出行模式",
			modeOnHint: "开启后, 高峰时段发送的消息自动入队 (平峰/关闭时正常发送)",
			on: "已开启",
			off: "已关闭",
			statusPeak: "当前高峰时段 · 消息将自动入队",
			statusOffpeak: "当前平峰时段 · 消息正常发送",
			statusLoading: "状态读取中…",
			statusError: "状态读取失败, 请刷新重试",
			saved: "✓ 已保存",
			pillPeak: "高峰 · 自动入队",
			pillExempt: "本会话立即发送",
			pillOffpeak: "平峰 · 正常发送",
			ariaLabel: "错峰出行模式开关",
			switchAria: "本会话立即发送 (豁免错峰, 高峰照常发送)",
			switchAriaOn: "本会话已豁免错峰, 高峰照常发送 (点击恢复自动入队)"
		};
		var en = {
			cardTitle: "Task Queue",
			cardHint: "Auto-run at off-peak prices · queue panel / off-peak mode",
			modeOn: "Off-peak travel mode",
			modeOnHint: "When on, messages sent during peak hours are queued automatically (normal send during off-peak / when off)",
			on: "On",
			off: "Off",
			statusPeak: "Peak hours now · messages will be queued",
			statusOffpeak: "Off-peak now · messages send normally",
			statusLoading: "Loading status…",
			statusError: "Failed to load status, please refresh",
			saved: "✓ Saved",
			pillPeak: "Peak · auto-queue",
			pillExempt: "Send now (this session)",
			pillOffpeak: "Off-peak · normal send",
			ariaLabel: "Off-peak travel mode toggle",
			switchAria: "Send immediately in this session (bypass peak queue)",
			switchAriaOn: "This session bypasses peak queue (click to restore auto-queue)"
		};

		// ---------- 样式 (沿用主题变量, 深浅主题均可读) ----------
		var INJECTED_CSS = [
			".dsh-tq-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-module-platform);flex-direction:column;gap:12px;padding:14px 16px;display:flex}",
			".dsh-tq-qhead{align-items:baseline;gap:8px;display:flex}",
			".dsh-tq-qhead b{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500}",
			".dsh-tq-qhead span{color:var(--dsw-alias-label-tertiary);font-size:12px}",
			".dsh-tq-mode{flex-direction:column;gap:6px;display:flex}",
			".dsh-tq-mode-row{align-items:center;gap:10px;display:flex}",
			".dsh-tq-mode-row b{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;flex:1}",
			".dsh-tq-switch{box-sizing:border-box;flex:none;width:44px;height:24px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-hover);cursor:pointer;padding:2px;transition:background .15s,border-color .15s}",
			".dsh-tq-switch[data-on=\"true\"]{background:var(--dsw-alias-state-success-primary,#22c55e);border-color:transparent}",
			".dsh-tq-switch::after{content:\"\";display:block;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground,#fff);transition:transform .15s}",
			".dsh-tq-switch[data-on=\"true\"]::after{transform:translateX(20px)}",
			".dsh-tq-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
			".dsh-tq-status[data-state=\"peak\"]{color:var(--dsw-alias-state-warn-primary,#f59e0b)}",
			".dsh-tq-status[data-state=\"offpeak\"]{color:var(--dsw-alias-state-success-primary,#22c55e)}",
			".dsh-tq-hint{font-size:12px;color:var(--dsw-alias-label-tertiary);margin:0}",
			// v0.8.0 药丸 (Full access 行右侧, conversation.input.left)
			".dsh-tq-pill{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1;white-space:nowrap;cursor:default;user-select:none;flex:none}",
			".dsh-tq-pill .dsh-tq-dot{width:7px;height:7px;border-radius:50%;flex:none;background:currentColor}",
			".dsh-tq-pill[data-state=\"peak\"]{color:var(--dsw-alias-state-warn-primary,#f59e0b);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 12%,transparent)}",
			".dsh-tq-pill[data-state=\"exempt\"],.dsh-tq-pill[data-state=\"offpeak\"]{color:var(--dsw-alias-state-success-primary,#22c55e);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 11%,transparent)}",
			// v0.8.0 药丸内小开关 (仅高峰显示: 关=自动入队 / 开=本会话豁免)
			".dsh-tq-pill .dsh-tq-sw{position:relative;flex:none;width:28px;height:16px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-hover);cursor:pointer;padding:0;transition:background .15s,border-color .15s}",
			".dsh-tq-pill .dsh-tq-sw::after{content:\"\";position:absolute;top:1.5px;left:2px;width:11px;height:11px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground,#fff);transition:transform .15s;box-shadow:0 1px 2px rgba(0,0,0,.3)}",
			".dsh-tq-pill .dsh-tq-sw[data-on=\"true\"]{background:var(--dsw-alias-state-success-primary,#22c55e);border-color:transparent}",
			".dsh-tq-pill .dsh-tq-sw[data-on=\"true\"]::after{transform:translateX(12px)}",
			// v0.8.0 输入框边框随状态着色 (:has() 纯 CSS, 药丸在 composer 卡内 → 卡边框变色;
			// 平峰不着色; 模式关闭无药丸自然不着色)
			"[data-composer-card]:has(.dsh-tq-pill[data-state=\"peak\"]){border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 55%,transparent) !important}",
			"[data-composer-card]:has(.dsh-tq-pill[data-state=\"exempt\"]){border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 50%,transparent) !important}"
		].join("");

		function injectCss() {
			try {
				if (document.getElementById("dsh-taskqueue-css")) return;
				var st = document.createElement("style");
				st.id = "dsh-taskqueue-css";
				st.textContent = INJECTED_CSS;
				(document.head || document.documentElement).appendChild(st);
			} catch (e) { /* 样式注入失败不影响功能 */ }
		}

		// ---------- 控制器: /queue RPC (mode.get/mode.set/mode.exempt) + store ----------
		// 状态缓存: 高峰判定服务端 30min 缓存窗口, 客户端再缓存 60s 足够 (时段边界最多延迟 1 分钟)。
		var STATUS_TTL_MS = 60 * 1000;

		function createController(connection) {
			var store = createSnapshotStore({ status: "loading", loaded: false, enabled: false, peak: false, windowSource: "", exempt: {} });
			var cached = null; // { at, value }
			function call(endpoint, payload) {
				var rpc = connection && connection.rpc;
				if (!rpc || typeof rpc.call !== "function") {
					return Promise.resolve({ ok: false, error: { code: "unavailable", message: "connection 服务不可用" } });
				}
				return rpc.call("/queue", endpoint, payload || {}).then(function (result) {
					return result && typeof result === "object" ? result : { ok: false, error: { code: "bad-response", message: "响应格式异常" } };
				}).catch(function (err) {
					return { ok: false, error: { code: "transport", message: String((err && err.message) || err) } };
				});
			}
			function publish(value) {
				store.set({
					status: "ready",
					loaded: true,
					enabled: value.enabled === true,
					peak: value.peak === true,
					windowSource: String(value.windowSource || ""),
					exempt: (value.exempt && typeof value.exempt === "object") ? value.exempt : {}
				});
			}
			function refresh(force) {
				if (!force && cached && Date.now() - cached.at < STATUS_TTL_MS) return Promise.resolve(cached.value);
				return call("mode.get", {}).then(function (res) {
					if (res.ok) {
						cached = { at: Date.now(), value: res.value };
						publish(res.value);
						return res.value;
					}
					store.set({ status: "error", loaded: true, enabled: false, peak: false, windowSource: "", exempt: {} });
					return null;
				});
			}
			refresh(true);
			// 周期性兜底刷新 (开关状态变化/时段切换), 不阻塞任何操作
			setInterval(function () { void refresh(false); }, STATUS_TTL_MS);
			return {
				store: store,
				refresh: refresh,
				getStatus: function () { return refresh(false); },
				setEnabled: function (enabled) {
					return call("mode.set", { enabled: enabled === true }).then(function (res) {
						if (res.ok) {
							cached = { at: Date.now(), value: res.value };
							publish(res.value);
						}
						return res;
					});
				},
				setExempt: function (sessionId, exempt) {
					return call("mode.exempt", { sessionId: sessionId, exempt: exempt === true }).then(function (res) {
						if (res.ok) {
							cached = { at: Date.now(), value: res.value };
							publish(res.value);
						}
						return res;
					});
				},
				addTask: function (content, sessionId) {
					return call("add", { content: content, sessionId: sessionId });
				}
			};
		}

		// ---------- 拦截: connection.api.sessions.prompt ----------
		// 条件: 开关开 + 当前高峰 + 纯文本 (无图片) + 文本非空 + 本会话未豁免 (v0.8.0)。
		// 命中 → /queue RPC add 入队 (绑当前会话, 服务端注入队列横幅) + 返回模拟成功,
		//       composer 清空输入框 (消息不发送给 LLM, 零 token);
		// 未命中 → 原样放行。斜杠命令走 commands.execute, 不经 session.prompt, 不受影响。
		function installPromptInterceptor(ctx, controller) {
			var connection = ctx.get("connection");
			if (!connection || !connection.api || !connection.api.sessions) return;
			var sessions = connection.api.sessions;
			var origPrompt = sessions.prompt;
			if (typeof origPrompt !== "function") return;
			sessions.prompt = async function (payload, signal) {
				try {
					// 只拦截: 开关开 + 高峰 + 纯文本 (无图片) + 非空 + 本会话未豁免
					var status = await controller.getStatus();
					var content = Array.isArray(payload && payload.content) ? payload.content : [];
					var hasImage = content.some(function (part) { return part && part.type === "image"; });
					var text = content.filter(function (part) { return part && part.type === "text" && typeof part.text === "string"; }).map(function (part) { return part.text; }).join("").trim();
					if (status && status.enabled === true && status.peak === true && !hasImage && text !== "") {
						var sessionId = payload && payload.sessionId;
						if (sessionId) {
							// v0.8.0: 豁免会话 (服务端持久化 exempt map) 高峰照常发送
							var exempt = !!(status.exempt && status.exempt[sessionId] === true);
							if (!exempt) {
								var res = await controller.addTask(text, sessionId);
								if (res && res.ok) {
									// 模拟 session.prompt 成功返回 (composer 清空输入框; 队列横幅由服务端注入)
									return { rpcId: "offpeak-queued", result: { ok: true, value: { accepted: true } } };
								}
								// 入队失败 → 不静默吞消息, 回退正常发送
							}
						}
					}
				} catch (e) { /* 任何异常都不拦截, 回退正常发送 */ }
				return origPrompt(payload, signal);
			};
			ctx.effect(function () {
				return function () {
					try { sessions.prompt = origPrompt; } catch (e) { /* 恢复失败忽略 */ }
				};
			}, "dsh-taskqueue: prompt interceptor");
		}

		// ---------- 设置卡: 错峰出行模式开关 + 状态 ----------
		function TaskQueueCard(props) {
			var t = props.t;
			var state = props.useTaskQueue(function (s) { return s; });
			var loaded = !!state.loaded;
			var busy = React.useRef(false);
			var [flash, setFlash] = React.useState(false);
			function toggle() {
				if (busy.current) return;
				busy.current = true;
				props.setEnabled(!state.enabled).then(function () {
					busy.current = false;
					setFlash(true);
					setTimeout(function () { setFlash(false); }, 1200);
				}, function () { busy.current = false; });
			}
			var statusState = !loaded ? "loading" : state.status === "error" ? "error" : (state.enabled ? (state.peak ? "peak" : "offpeak") : "off");
			var statusText = statusState === "loading" ? t("statusLoading")
				: statusState === "error" ? t("statusError")
					: statusState === "peak" ? t("statusPeak")
						: statusState === "offpeak" ? t("statusOffpeak")
							: "";
			return React.createElement("div", { className: "dsh-tq-card" }, [
				React.createElement("div", { className: "dsh-tq-qhead" }, [
					React.createElement("b", null, t("cardTitle")),
					React.createElement("span", null, t("cardHint"))
				]),
				React.createElement("div", { className: "dsh-tq-mode" }, [
					React.createElement("div", { className: "dsh-tq-mode-row" }, [
						React.createElement("b", null, t("modeOn")),
						React.createElement("button", {
							type: "button",
							className: "dsh-tq-switch",
							role: "switch",
							"aria-checked": state.enabled === true,
							"aria-label": t("ariaLabel"),
							"data-on": state.enabled === true ? "true" : "false",
							onClick: toggle
						})
					]),
					React.createElement("span", { className: "dsh-tq-status", "data-state": statusState }, statusText),
					React.createElement("p", { className: "dsh-tq-hint" }, t("modeOnHint")),
					React.createElement("p", { className: "dsh-tq-hint" }, flash ? t("saved") : "")
				])
			]);
		}

		// ---------- 输入框药丸 (v0.8.0, conversation.input.left: Full access 行右侧) ----------
		// 高峰: 琥珀「高峰 · 自动入队」+ 小开关 (关) → 点开关 = 本会话豁免 (服务端持久化);
		// 豁免: 绿「本会话立即发送」+ 开关 (开) → 点开关 = 恢复自动入队;
		// 平峰: 绿「平峰 · 正常发送」无开关; 模式关闭/未加载: 不渲染。
		function TaskQueuePill(props) {
			var t = props.t;
			var state = props.useTaskQueue(function (s) { return s; });
			// hooks 必须无条件调用 (Rules of Hooks): useRef 置于 early return 之前
			var busy = React.useRef(false);
			if (!state.loaded || state.status !== "ready" || !state.enabled) return null;
			var session = props.session;
			var sessionId = session && (session.id || session.sessionId);
			if (!sessionId) return null;
			var exempt = !!(state.exempt && state.exempt[sessionId] === true);
			var peak = state.peak === true;
			function toggleExempt() {
				if (busy.current || !props.setExempt) return;
				busy.current = true;
				props.setExempt(sessionId, !exempt).then(function () {
					busy.current = false;
				}, function () { busy.current = false; });
			}
			if (!peak) {
				// 平峰: 绿色信息药丸, 无开关 (豁免状态仅在高峰时显示/可切)
				return React.createElement("span", { className: "dsh-tq-pill", "data-state": "offpeak" }, [
					React.createElement("span", { className: "dsh-tq-dot" }),
					React.createElement("span", null, t("pillOffpeak"))
				]);
			}
			// 高峰: 琥珀自动入队 / 绿豁免 + 小开关
			var pillState = exempt ? "exempt" : "peak";
			var pillText = exempt ? t("pillExempt") : t("pillPeak");
			return React.createElement("span", { className: "dsh-tq-pill", "data-state": pillState }, [
				React.createElement("span", { className: "dsh-tq-dot" }),
				React.createElement("span", null, pillText),
				React.createElement("button", {
					type: "button",
					className: "dsh-tq-sw",
					role: "switch",
					"aria-checked": exempt,
					"aria-label": exempt ? t("switchAriaOn") : t("switchAria"),
					"data-on": exempt ? "true" : "false",
					disabled: busy.current ? true : false,
					onClick: toggleExempt
				})
			]);
		}

		// ---------- 注册 ----------
		var inject = ["slots", "locale", "connection", "sessions"];

		function apply(ctx) {
			injectCss();
			ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "ui-taskqueue: dictionaries");
			var t = ctx.locale.bind(NS);
			var controller = createController(ctx.get("connection"));

			// 0) 错峰出行模式拦截 (session.prompt)
			installPromptInterceptor(ctx, controller);

			// 1) 输入框药丸 (v0.8.0): conversation.input.left —— 渲染在输入框底部工具行
			//    Full access 选择器右侧 (原 v0.7.0 conversation.input.dock 悬浮状态条已移除)
			ctx.slots.inject("conversation.input.left", function () {
				return ctx.slots.register({
					name: "conversation.input.left",
					id: "taskqueue-offpeak-pill",
					order: 10,
					locale: NS,
					inject: function () {
						return {
							hooks: { taskQueue: controller.store },
							setExempt: controller.setExempt
						};
					}
				}, TaskQueuePill);
			});

			// 2) 设置菜单「本地插件」列配置卡
			ctx.slots.inject("settings.localplugin.item", function () {
				return ctx.slots.register({
					name: "settings.localplugin.item",
					key: CARD_KEY,
					locale: NS,
					inject: function () {
						return {
							hooks: { taskQueue: controller.store },
							setEnabled: controller.setEnabled
						};
					}
				}, TaskQueueCard);
			});
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
