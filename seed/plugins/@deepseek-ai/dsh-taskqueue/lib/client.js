window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-taskqueue",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");
		var { createSnapshotStore } = require("@deepseek-ai/dsh-client-runtime/client");

		// ═══════════════════════════════════════════════════════════════════
		// dsh-taskqueue 客户端 (v0.7.0 新增 / v0.8.0 提示换位 + 单会话豁免 / v0.8.2 折叠图标+弹层)
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
		// 2) 提示位置 (v0.8.0→v0.8.2): conversation.input.left 槽 (Full access 选择器右侧):
		//    - v0.8.2 触发器: 宽屏=完整文案药丸(button); 窄屏(≤640px)=26×26 小图标
		//      (同左边 access 收缩, 解决手机端药丸/状态词仍与左右元素重叠的问题);
		//      点击药丸/图标 → 弹层 (fixed + JS 摆位): 状态圆点+完整文案+说明 +
		//      高峰「本会话立即发送」豁免开关 (开关自 v0.8.2 起统一收进弹层);
		//    - 输入框边框随状态着色 (:has() 纯 CSS, 高峰琥珀 / 豁免绿; 平峰不着色);
		//      模式关闭不渲染任何触发器。
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
			// v0.8.2 弹层 (点击药丸/图标弹出的小菜单)
			descPeak: "当前为高峰时段，发送的消息会自动入队，到低谷价时段再执行。",
			descExempt: "本会话已豁免错峰：高峰时段消息也立即发送，不入队。",
			descOffpeak: "当前为平峰时段，消息正常发送。",
			popRowLabel: "本会话立即发送",
			triggerAria: "错峰状态：%s（点击查看/操作）",
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
			descPeak: "Peak hours now: messages you send are auto-queued and run in the next off-peak window.",
			descExempt: "This session bypasses off-peak mode: messages send immediately even during peak hours.",
			descOffpeak: "Off-peak now: messages send normally.",
			popRowLabel: "Send now in this session",
			triggerAria: "Off-peak status: %s (click to view / act)",
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
			// v0.8.2 触发器 (Full access 行右侧, conversation.input.left):
			// 宽屏=完整文案药丸(.dsh-tq-pill, button) / 窄屏(≤640px)=26×26 图标(.dsh-tq-icon, 同 access 收缩);
			// 点击任一 → 弹层 .dsh-tq-pop (fixed, JS 摆位): 状态点+完整文案+说明 + 高峰豁免开关
			".dsh-tq-wrap{position:relative;display:inline-flex;align-items:center;flex:none;min-width:0;line-height:1}",
			".dsh-tq-pill{display:inline-flex;align-items:center;gap:5px;box-sizing:border-box;height:26px;margin:0;padding:0 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:11.5px;line-height:1;white-space:nowrap;cursor:pointer;user-select:none;flex:none;min-width:0;max-width:100%;overflow:hidden}",
			".dsh-tq-pill .dsh-tq-dot,.dsh-tq-icon .dsh-tq-dot,.dsh-tq-pop .dsh-tq-dot{width:7px;height:7px;border-radius:50%;flex:none;background:currentColor}",
			".dsh-tq-pill .dsh-tq-txt{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsh-tq-pill[data-state=\"peak\"],.dsh-tq-icon[data-state=\"peak\"]{color:var(--dsw-alias-state-warn-primary,#f59e0b);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 12%,transparent)}",
			".dsh-tq-pill[data-state=\"exempt\"],.dsh-tq-pill[data-state=\"offpeak\"],.dsh-tq-icon[data-state=\"exempt\"],.dsh-tq-icon[data-state=\"offpeak\"]{color:var(--dsw-alias-state-success-primary,#22c55e);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 11%,transparent)}",
			".dsh-tq-icon{display:none;align-items:center;justify-content:center;box-sizing:border-box;width:26px;height:26px;margin:0;padding:0;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-family:inherit;cursor:pointer;flex:none}",
			"@media (max-width:640px){.dsh-tq-pill{display:none}.dsh-tq-icon{display:inline-flex}}",
			// 弹层内开关 (v0.8.2 起豁免开关统一收进弹层; 28×16 同 v0.8.0 药丸内小开关)
			".dsh-tq-sw{position:relative;flex:none;width:28px;height:16px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-hover);cursor:pointer;padding:0;transition:background .15s,border-color .15s}",
			".dsh-tq-sw::after{content:\"\";position:absolute;top:1.5px;left:2px;width:11px;height:11px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground,#fff);transition:transform .15s;box-shadow:0 1px 2px rgba(0,0,0,.3)}",
			".dsh-tq-sw[data-on=\"true\"]{background:var(--dsw-alias-state-success-primary,#22c55e);border-color:transparent}",
			".dsh-tq-sw[data-on=\"true\"]::after{transform:translateX(12px)}",
			// 弹层 (fixed + JS 摆位; 点外/Esc 关闭)
			".dsh-tq-pop{display:none;box-sizing:border-box;position:fixed;z-index:9999;width:240px;padding:10px 12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);box-shadow:0 8px 32px rgba(0,0,0,.35);text-align:left}",
			".dsh-tq-pop.dsh-tq-pop-open{display:block}",
			".dsh-tq-pop-title{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}",
			".dsh-tq-pop[data-state=\"peak\"] .dsh-tq-pop-title{color:var(--dsw-alias-state-warn-primary,#f59e0b)}",
			".dsh-tq-pop[data-state=\"exempt\"] .dsh-tq-pop-title,.dsh-tq-pop[data-state=\"offpeak\"] .dsh-tq-pop-title{color:var(--dsw-alias-state-success-primary,#22c55e)}",
			".dsh-tq-pop-desc{margin-top:6px;font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary)}",
			".dsh-tq-pop-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:10px;padding-top:9px;border-top:1px dashed var(--dsw-alias-border-l2);font-size:12px;color:var(--dsw-alias-label-primary)}",
			// 输入框边框随状态着色 (:has() 纯 CSS, 药丸/图标任一在 composer 卡内即着色;
			// 平峰不着色; 模式关闭无触发器自然不着色)
			"[data-composer-card]:has(.dsh-tq-pill[data-state=\"peak\"],.dsh-tq-icon[data-state=\"peak\"]){border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 55%,transparent) !important}",
			"[data-composer-card]:has(.dsh-tq-pill[data-state=\"exempt\"],.dsh-tq-icon[data-state=\"exempt\"]){border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 50%,transparent) !important}"
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

		// ---------- 输入框触发器 (v0.8.2, conversation.input.left: Full access 行右侧) ----------
		// 宽屏: 完整文案药丸 (.dsh-tq-pill, button); 窄屏(≤640px): 26×26 图标 (.dsh-tq-icon,
		// 同左边 access 收缩, 不挤占工具行 → 不再与左右元素重叠);
		// 点击药丸/图标 → 弹层 .dsh-tq-pop (fixed + JS 摆位): 状态圆点+完整文案+说明 +
		// 高峰时「本会话立即发送」豁免开关 (v0.8.2 起豁免开关统一收进弹层, 药丸内不再内嵌开关);
		// 点外/Esc 关闭; 模式关闭/未加载: 不渲染。豁免切换仍走服务端 mode.exempt 持久化。
		var POP_W = 240;
		function TaskQueuePill(props) {
			var t = props.t;
			var state = props.useTaskQueue(function (s) { return s; });
			// hooks 必须无条件调用 (Rules of Hooks): 全部置于 early return 之前
			var busy = React.useRef(false);
			var triggerRef = React.useRef(null);
			var popRef = React.useRef(null);
			var [open, setOpen] = React.useState(false);
			var ready = !!(state.loaded && state.status === "ready" && state.enabled);
			var session = props.session;
			var sessionId = session && (session.id || session.sessionId);
			var exempt = !!(ready && sessionId && state.exempt && state.exempt[sessionId] === true);
			var peak = state.peak === true;
			var pillState = !ready ? "offpeak" : (exempt ? "exempt" : (peak ? "peak" : "offpeak"));
			var label = !ready ? "" : (exempt ? t("pillExempt") : (peak ? t("pillPeak") : t("pillOffpeak")));
			var desc = !ready ? "" : (exempt ? t("descExempt") : (peak ? t("descPeak") : t("descOffpeak")));
			var aria = label ? t("triggerAria").replace("%s", label) : "";
			function toggleExempt() {
				if (busy.current || !props.setExempt || !sessionId) return;
				busy.current = true;
				props.setExempt(sessionId, !exempt).then(function () {
					busy.current = false;
				}, function () { busy.current = false; });
			}
			function toggleOpen() {
				setOpen(function (v) { return !v; });
			}
			// 点外/Esc 关闭 (仅打开期间挂监听; capture 确保弹层内开关先于关闭判定)
			React.useEffect(function () {
				if (!open) return;
				function onDocDown(ev) {
					var trig = triggerRef.current;
					var pop = popRef.current;
					var node = ev && ev.target;
					if ((trig && node && trig.contains(node)) || (pop && node && pop.contains(node))) return;
					setOpen(false);
				}
				function onKey(ev) {
					if (ev && ev.key === "Escape") setOpen(false);
				}
				document.addEventListener("pointerdown", onDocDown, true);
				document.addEventListener("keydown", onKey, true);
				return function () {
					document.removeEventListener("pointerdown", onDocDown, true);
					document.removeEventListener("keydown", onKey, true);
				};
			}, [open]);
			// 摆位: fixed, 触发器上方水平居中 (越界自动收敛), 顶部放不下则改下方; 滚动/缩放重摆
			React.useLayoutEffect(function () {
				if (!open) return;
				function place() {
					var pop = popRef.current;
					var trig = triggerRef.current;
					if (!pop || !trig) return;
					var r = trig.getBoundingClientRect();
					var ph = pop.getBoundingClientRect().height || 120;
					var vw = window.innerWidth || document.documentElement.clientWidth || 320;
					var left = Math.max(8, Math.min(r.left + r.width / 2 - POP_W / 2, vw - POP_W - 8));
					var top = r.top - ph - 8;
					if (top < 8) top = r.bottom + 8;
					pop.style.left = Math.round(left) + "px";
					pop.style.top = Math.round(top) + "px";
					pop.style.width = POP_W + "px";
				}
				place();
				window.addEventListener("resize", place);
				window.addEventListener("scroll", place, true);
				return function () {
					window.removeEventListener("resize", place);
					window.removeEventListener("scroll", place, true);
				};
			}, [open, exempt, peak]);
			if (!ready || !sessionId) return null;
			var popEl = null;
			if (open) {
				var rows = [];
				if (peak) {
					rows.push(React.createElement("div", { className: "dsh-tq-pop-row", key: "sw" }, [
						React.createElement("span", null, t("popRowLabel")),
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
					]));
				}
				popEl = React.createElement("div", {
					ref: popRef,
					className: "dsh-tq-pop dsh-tq-pop-open",
					"data-state": pillState,
					role: "dialog",
					"aria-label": label
				}, [
					React.createElement("div", { className: "dsh-tq-pop-title" }, [
						React.createElement("span", { className: "dsh-tq-dot" }),
						React.createElement("span", null, label)
					]),
					React.createElement("div", { className: "dsh-tq-pop-desc" }, desc),
					rows
				]);
			}
			return React.createElement("span", { className: "dsh-tq-wrap", ref: triggerRef }, [
				React.createElement("button", {
					key: "pill",
					type: "button",
					className: "dsh-tq-pill",
					"data-state": pillState,
					"aria-label": aria,
					"aria-expanded": open ? "true" : "false",
					title: label,
					onClick: toggleOpen
				}, [
					React.createElement("span", { className: "dsh-tq-dot" }),
					React.createElement("span", { className: "dsh-tq-txt" }, label)
				]),
				React.createElement("button", {
					key: "icon",
					type: "button",
					className: "dsh-tq-icon",
					"data-state": pillState,
					"aria-label": aria,
					"aria-expanded": open ? "true" : "false",
					title: label,
					onClick: toggleOpen
				}, React.createElement("span", { className: "dsh-tq-dot" })),
				popEl
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

			// 1) 触发器 (v0.8.2): conversation.input.left —— 渲染在输入框底部工具行
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
