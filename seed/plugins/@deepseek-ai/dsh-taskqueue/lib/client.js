window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-taskqueue",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");
		var { createSnapshotStore } = require("@deepseek-ai/dsh-client-runtime/client");

		// ═══════════════════════════════════════════════════════════════════
		// dsh-taskqueue 客户端 (v0.7.0 新增)
		//
		// 1) 错峰出行模式 (offpeak mode):
		//    - 设置菜单「本地插件」列新增「任务队列」卡: 开关 + 当前状态显示
		//    - 开启后高峰期间: 所有消息 (已有/新会话) 默认入队 —— 包装
		//      connection.api.sessions.prompt, 当 开关开 + 当前高峰 + 纯文本时
		//      不发给 LLM, 改调 /queue RPC add 入队 (绑当前会话, 服务端注入
		//      蓝色队列横幅), 并向 composer 返回模拟成功 (accepted: true) 清空输入框。
		//      平峰期间或关闭状态: 原样放行 (正常发送)。
		//    - 斜杠命令不走 session.prompt (走 commands.execute), 天然不受拦截。
		// 2) 输入框上方状态提示条 (conversation.input.dock, order 16):
		//    开启后显示当前模式 (高峰·自动入队 / 平峰·正常发送)。
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
			dockPeak: "错峰模式 · 高峰中, 消息自动入队",
			dockOffpeak: "错峰模式 · 平峰中, 正常发送",
			ariaLabel: "错峰出行模式开关"
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
			dockPeak: "Off-peak mode · peak hours, auto-queue",
			dockOffpeak: "Off-peak mode · off-peak, normal send",
			ariaLabel: "Off-peak travel mode toggle"
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
			// 输入框上方状态条
			".dsh-tq-dock{display:flex;justify-content:center;margin:0 auto 2px}",
			".dsh-tq-chip{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:3px 12px;border-radius:999px;font-size:11.5px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}",
			".dsh-tq-chip[data-state=\"peak\"]{color:var(--dsw-alias-state-warn-primary,#f59e0b);border-color:rgba(245,158,11,.35)}",
			".dsh-tq-chip[data-state=\"offpeak\"]{color:var(--dsw-alias-state-success-primary,#22c55e);border-color:rgba(34,197,94,.35)}"
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

		// ---------- 控制器: /queue RPC (mode.get/mode.set) + store ----------
		// 状态缓存: 高峰判定服务端 30min 缓存窗口, 客户端再缓存 60s 足够 (时段边界最多延迟 1 分钟)。
		var STATUS_TTL_MS = 60 * 1000;

		function createController(connection) {
			var store = createSnapshotStore({ status: "loading", loaded: false, enabled: false, peak: false, windowSource: "" });
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
					windowSource: String(value.windowSource || "")
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
					store.set({ status: "error", loaded: true, enabled: false, peak: false, windowSource: "" });
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
				addTask: function (content, sessionId) {
					return call("add", { content: content, sessionId: sessionId });
				}
			};
		}

		// ---------- 拦截: connection.api.sessions.prompt ----------
		// 条件: 开关开 + 当前高峰 + content 为纯文本 (无图片) + 文本非空。
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
					// 只拦截: 开关开 + 高峰 + 纯文本 (无图片) + 非空
					var status = await controller.getStatus();
					var content = Array.isArray(payload && payload.content) ? payload.content : [];
					var hasImage = content.some(function (part) { return part && part.type === "image"; });
					var text = content.filter(function (part) { return part && part.type === "text" && typeof part.text === "string"; }).map(function (part) { return part.text; }).join("").trim();
					if (status && status.enabled === true && status.peak === true && !hasImage && text !== "") {
						var sessionId = payload && payload.sessionId;
						if (sessionId) {
							var res = await controller.addTask(text, sessionId);
							if (res && res.ok) {
								// 模拟 session.prompt 成功返回 (composer 清空输入框; 队列横幅由服务端注入)
								return { rpcId: "offpeak-queued", result: { ok: true, value: { accepted: true } } };
							}
							// 入队失败 → 不静默吞消息, 回退正常发送
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

		// ---------- 输入框上方状态提示条 ----------
		function TaskQueueDock(props) {
			var t = props.t;
			var state = props.useTaskQueue(function (s) { return s; });
			if (!state.loaded || state.status !== "ready" || !state.enabled) return null;
			var peak = state.peak === true;
			return React.createElement("div", { className: "dsh-tq-dock" },
				React.createElement("span", { className: "dsh-tq-chip", "data-state": peak ? "peak" : "offpeak" },
					peak ? t("dockPeak") : t("dockOffpeak"))
			);
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

			// 1) 输入框上方状态提示条 (quick-insert order 15 之后, 不与队列/待办条冲突)
			ctx.slots.inject("conversation.input.dock", function () {
				return ctx.slots.register({
					name: "conversation.input.dock",
					id: "taskqueue-offpeak",
					order: 16,
					locale: NS,
					inject: function () {
						return { hooks: { taskQueue: controller.store } };
					}
				}, TaskQueueDock);
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
