window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-taskqueue",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");
		var { createSnapshotStore } = require("@deepseek-ai/dsh-client-store");

		// ═══════════════════════════════════════════════════════════════════
		// dsh-taskqueue 客户端 (v0.7.0 新增 / v0.8.0 提示换位 + 单会话豁免 / v0.8.2 折叠图标+弹层 /
		//                        v0.8.3 0.1.2 槽契约修复 + 诊断上报)
		//
		// 1) 错峰出行模式 (offpeak mode):
		//    - 设置菜单「本地插件」列新增「任务队列」卡: 开关 + 当前状态显示
		//    - 开启后高峰期间: 所有消息 (已有/新会话) 默认入队 —— 包装会话对象的
		//      prompt(content, mode, signal, requestId) (0.1.2 真实发送入口), 当
		//      开关开 + 当前高峰 + 纯文本时 不发给 LLM, 改调 /queue RPC add 入队
		//      (绑当前会话, 服务端注入蓝色队列横幅), 并向 composer 返回模拟成功
		//      (accepted: true) 清空输入框。
		//      平峰期间或关闭状态: 原样放行 (正常发送)。
		//    - 斜杠命令不走 session.prompt (走 commands.execute), 天然不受拦截。
		//    - v0.8.0 单会话豁免: 服务端持久化 exempt map (offpeak-mode.json),
		//      豁免会话高峰照常发送; 拦截器命中条件加 !exempt[sessionId]。
		//    - v0.8.5 (2026-09-12): 拦截点**前移**到 conversation.sendSession —— 只在 prompt 层拦截时,
		//      composer 的本地乐观 echo 已经建好且永不 retire, 表现为"会话里出现一条消息, 刷新后消失"
		//      (幽灵消息)。前移后命中即返回 {kind:"success"}, 根本不进 beginSubmission:
		//      会话里只剩「给 agent 的固定提示(转正确认)」+「任务 #N 已入队」横幅。
		//    - v0.8.3 修复 (2026-09-12): 0.1.2 的会话作用域槽 (conversation.input.left)
		//      只给 props.sessionId + useSession hook (旧代码读 props.session → 药丸 return null,
		//      且拦截器唯一兜底捕获一起失效 → 拦截器其实从未安装)。改为「sessions.list 订阅 +
		//      useSession/槽参捕获 + 短时重试」三路捕获, 并加诊断上报 (window.__dshTaskqueueDebug
		//      + /queue RPC diag → 服务端 log/taskqueue/offpeak-debug.log)。
		//      强制时段 (调试): 服务端 debug=peak|offpeak 时状态文案标注 [强制 …·debug]。
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
			// v0.8.6: 拦截器未安装 (宿主升级导致挂点变更等) —— "宁愿报错也不静默直发"
			statusBroken: "⚠ 拦截器未安装 · 消息将直发 (按高峰价), 请强刷页面",
			descBroken: "错峰拦截未安装：当前高峰时段消息不会被拦截入队，而是直接发送（按高峰价计费）。请强刷页面；仍无效则查 /queue/diag.get。",
			saved: "✓ 已保存",
			pillPeak: "高峰 · 自动入队",
			pillExempt: "本会话立即发送",
			pillOffpeak: "平峰 · 正常发送",
			// v0.8.2 弹层 (点击药丸/图标弹出的小菜单)
			descPeak: "当前为高峰时段，发送的消息会自动入队，到低谷价时段再执行。",
			descExempt: "本会话已豁免错峰：高峰时段消息也立即发送，不入队。",
			descOffpeak: "当前为平峰时段，消息正常发送。",
			popRowLabel: "本会话立即发送",
			// v0.9.0: 高峰暂停 (全局子开关 + 本会话暂停态)
			pauseLabel: "高峰暂停",
			pauseHint: "高峰时段把正在跑的回合停在步骤边界, 到低谷自动继续 (等待期零 token; 关闭则高峰照常跑完)",
			pauseRowLabel: "高峰暂停 (全局)",
			pauseAria: "高峰暂停开关 (全局): 高峰期把正在跑的 agent 回合停在步骤边界",
			pauseBroken: "暂停闸门未安装（本版本宿主不兼容）",
			pillPaused: "⏸ 暂停中",
			statusPaused: "已暂停 · 预计 %s 继续",
			descPaused: "本会话的回合已停在步骤边界，等低谷价时段到达后自动继续（等待期零 token，不打断上下文）。",
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
			// v0.8.6: interceptor not installed → fail loud instead of silently sending at peak price
			statusBroken: "⚠ Interceptor not installed · messages send directly (peak price), please hard-reload",
			descBroken: "Off-peak interceptor is NOT installed: peak-hour messages are sent directly (billed at peak price) instead of being queued. Hard-reload the page; if it persists, check /queue/diag.get.",
			saved: "✓ Saved",
			pillPeak: "Peak · auto-queue",
			pillExempt: "Send now (this session)",
			pillOffpeak: "Off-peak · normal send",
			descPeak: "Peak hours now: messages you send are auto-queued and run in the next off-peak window.",
			descExempt: "This session bypasses off-peak mode: messages send immediately even during peak hours.",
			descOffpeak: "Off-peak now: messages send normally.",
			popRowLabel: "Send now in this session",
			// v0.9.0: peak-pause (global sub-switch + per-session paused state)
			pauseLabel: "Peak pause",
			pauseHint: "During peak hours a running turn is parked at the step boundary and resumes in the off-peak window (zero tokens while waiting; off = peak turns run to completion)",
			pauseRowLabel: "Peak pause (global)",
			pauseAria: "Peak pause switch (global): park running agent turns at the step boundary during peak hours",
			pauseBroken: "Pause gate NOT installed (host incompatible)",
			pillPaused: "⏸ Paused",
			statusPaused: "Paused · resumes ~%s",
			descPaused: "This session's turn is parked at the step boundary and resumes automatically when the off-peak window starts (zero tokens while waiting, context kept).",
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
			// v0.8.6: 拦截器未安装 = 红字告警 (不再伪装成"平峰正常发送")
			".dsh-tq-status[data-state=\"broken\"]{color:var(--dsw-alias-state-error-primary,#ef4444);font-weight:600}",
			".dsh-tq-hint{font-size:12px;color:var(--dsw-alias-label-tertiary);margin:0}",
			// v0.8.2 触发器 (Full access 行右侧, conversation.input.left):
			// 宽屏=完整文案药丸(.dsh-tq-pill, button) / 窄屏(≤640px)=26×26 图标(.dsh-tq-icon, 同 access 收缩);
			// 点击任一 → 弹层 .dsh-tq-pop (fixed, JS 摆位): 状态点+完整文案+说明 + 高峰豁免开关
			".dsh-tq-wrap{position:relative;display:inline-flex;align-items:center;flex:none;min-width:0;line-height:1}",
			".dsh-tq-pill{display:inline-flex;align-items:center;gap:5px;box-sizing:border-box;height:26px;margin:0;padding:0 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:11.5px;line-height:1;white-space:nowrap;cursor:pointer;user-select:none;flex:none;min-width:0;max-width:100%;overflow:hidden}",
			".dsh-tq-pill .dsh-tq-dot,.dsh-tq-icon .dsh-tq-dot,.dsh-tq-pop .dsh-tq-dot{width:7px;height:7px;border-radius:50%;flex:none;background:currentColor}",
			".dsh-tq-pill .dsh-tq-txt{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsh-tq-pill[data-state=\"peak\"],.dsh-tq-icon[data-state=\"peak\"],.dsh-tq-pill[data-state=\"paused\"],.dsh-tq-icon[data-state=\"paused\"]{color:var(--dsw-alias-state-warn-primary,#f59e0b);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 12%,transparent)}",
			".dsh-tq-pill[data-state=\"exempt\"],.dsh-tq-pill[data-state=\"offpeak\"],.dsh-tq-icon[data-state=\"exempt\"],.dsh-tq-icon[data-state=\"offpeak\"]{color:var(--dsw-alias-state-success-primary,#22c55e);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 11%,transparent)}",
			// v0.8.6: 未安装态 (红) —— 药丸/图标/弹层标题 + composer 边框同色
			".dsh-tq-pill[data-state=\"broken\"],.dsh-tq-icon[data-state=\"broken\"]{color:var(--dsw-alias-state-error-primary,#ef4444);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 12%,transparent)}",
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
			".dsh-tq-pop[data-state=\"peak\"] .dsh-tq-pop-title,.dsh-tq-pop[data-state=\"paused\"] .dsh-tq-pop-title{color:var(--dsw-alias-state-warn-primary,#f59e0b)}",
			".dsh-tq-pop[data-state=\"exempt\"] .dsh-tq-pop-title,.dsh-tq-pop[data-state=\"offpeak\"] .dsh-tq-pop-title{color:var(--dsw-alias-state-success-primary,#22c55e)}",
			".dsh-tq-pop[data-state=\"broken\"] .dsh-tq-pop-title{color:var(--dsw-alias-state-error-primary,#ef4444)}",
			".dsh-tq-pop-desc{margin-top:6px;font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary)}",
			".dsh-tq-pop-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:10px;padding-top:9px;border-top:1px dashed var(--dsw-alias-border-l2);font-size:12px;color:var(--dsw-alias-label-primary)}",
			// 输入框边框随状态着色 (:has() 纯 CSS, 药丸/图标任一在 composer 卡内即着色;
			// 平峰不着色; 模式关闭无触发器自然不着色)
			"[data-composer-card]:has(.dsh-tq-pill[data-state=\"peak\"],.dsh-tq-icon[data-state=\"peak\"],.dsh-tq-pill[data-state=\"paused\"],.dsh-tq-icon[data-state=\"paused\"]){border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 55%,transparent) !important}",
			"[data-composer-card]:has(.dsh-tq-pill[data-state=\"exempt\"],.dsh-tq-icon[data-state=\"exempt\"]){border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 50%,transparent) !important}",
			"[data-composer-card]:has(.dsh-tq-pill[data-state=\"broken\"],.dsh-tq-icon[data-state=\"broken\"]){border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 55%,transparent) !important}"
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

		// ---------- 控制器: /queue RPC (mode.get/mode.set/mode.exempt/mode.debug/diag) + store ----------
		// 状态缓存: 高峰判定服务端 30min 缓存窗口, 客户端 UI 侧缓存 60s 足够 (时段边界最多延迟 1 分钟)。
		// v0.8.3: 拦截判定单独用更短的 TTL (PROMPT_TTL_MS) —— 强制时段/豁免开关切换后要在几秒内生效,
		//   否则"刚 /queue debug peak 就发消息"会按旧的平峰状态直发 (用户以为没生效)。
		//   UI 侧 15s 轮询刷新, 让药丸/设置卡也能较快跟随强制状态。
		var STATUS_TTL_MS = 60 * 1000;
		var PROMPT_TTL_MS = 5 * 1000;
		var UI_POLL_MS = 15 * 1000;

		function createController(connection) {
			var store = createSnapshotStore({ status: "loading", loaded: false, enabled: false, peak: false, windowSource: "", peakSource: "", debug: "auto", exempt: {}, pause: true, paused: { count: 0, sessions: [] }, pauseInstalled: true });
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
			/** v0.8.3 诊断上报: 拦截器/药丸在浏览器里, 静默失效时只能靠它远程取证 (服务端落 log/taskqueue/) */
			function report(event, detail) {
				try {
					return void call("diag", { event: event, detail: detail || {} });
				} catch (e) { /* 诊断失败绝不影响功能 */ }
			}
			/** v0.9.0: paused 摘要归一 (服务端 mode.get 新增字段; 老服务端没有 ⇒ 空摘要) */
			function pausedOf(value) {
				var p = value && value.paused;
				if (!p || typeof p !== "object" || !Array.isArray(p.sessions)) return { count: 0, sessions: [] };
				return { count: typeof p.count === "number" ? p.count : p.sessions.length, sessions: p.sessions };
			}
			function publish(value) {
				store.set({
					status: "ready",
					loaded: true,
					enabled: value.enabled === true,
					peak: value.peak === true,
					windowSource: String(value.windowSource || ""),
					peakSource: String(value.peakSource || value.windowSource || ""),
					debug: String(value.debug || "auto"),
					exempt: (value.exempt && typeof value.exempt === "object") ? value.exempt : {},
					pause: value.pause !== false,
					pauseInstalled: value.pauseInstalled !== false, // v0.9.0: 闸门自检失败 ⇒ 设置卡加一句可见提示
					paused: pausedOf(value)
				});
			}
			function refresh(force, ttlMs) {
				var ttl = typeof ttlMs === "number" ? ttlMs : STATUS_TTL_MS;
				if (!force && cached && Date.now() - cached.at < ttl) return Promise.resolve(cached.value);
				return call("mode.get", {}).then(function (res) {
					if (res.ok) {
						cached = { at: Date.now(), value: res.value };
						publish(res.value);
						return res.value;
					}
					store.set({ status: "error", loaded: true, enabled: false, peak: false, windowSource: "", peakSource: "", debug: "auto", exempt: {}, pause: true, paused: { count: 0, sessions: [] }, pauseInstalled: true });
					return null;
				});
			}
			refresh(true);
			// 周期性兜底刷新 (开关状态变化/时段切换/强制时段切换), 不阻塞任何操作
			setInterval(function () { void refresh(false, UI_POLL_MS); }, UI_POLL_MS);
			/** v0.9.0 降级: RPC 失败 ⇒ 回退 UI 到服务端真实状态 (不以乐观值骗用户) */
			function resync() {
				return refresh(true).then(function () { return null; }, function () { return null; });
			}
			function setter(endpoint, payload, res) {
				if (res && res.ok) {
					cached = { at: Date.now(), value: res.value };
					publish(res.value);
					return res;
				}
				return resync().then(function () { return res; }); // 失败 ⇒ 回退到服务端真实状态
			}
			return {
				store: store,
				report: report,
				refresh: refresh,
				// 拦截判定用短 TTL (v0.8.3): 强制时段/豁免切换 ≤5s 生效, 避免"以为没生效"
				getStatus: function () { return refresh(false, PROMPT_TTL_MS); },
				setEnabled: function (enabled) {
					return call("mode.set", { enabled: enabled === true }).then(function (res) { return setter("mode.set", null, res); });
				},
				// v0.9.0 高峰暂停子开关 (全局): mode.set 只带 pause ⇒ 服务端不动其它字段
				setPause: function (pause) {
					return call("mode.set", { pause: pause === true }).then(function (res) { return setter("mode.set", null, res); });
				},
				setExempt: function (sessionId, exempt) {
					return call("mode.exempt", { sessionId: sessionId, exempt: exempt === true }).then(function (res) { return setter("mode.exempt", null, res); });
				},
				addTask: function (content, sessionId) {
					return call("add", { content: content, sessionId: sessionId });
				}
			};
		}

		// ---------- 拦截: 0.1.2 Session.prompt (2026-09-11 P3 适配 / 2026-09-12 修复) ----------
		// 0.1.2 起 connection 服务只剩 { isLoopback, generation, state, rpc, reconnect,
		// registerGenerationSource } —— **`connection.api` 已不存在**，旧代码
		// `connection.api.sessions.prompt` 包装恒不执行 (guard 直接 return) → 错峰拦截静默失效。
		// 真实发送链路: composer → 会话对象 `prompt(content, mode, signal, requestId)`
		//   (content = [{type:"text",text}]|[{type:"image",...}]; 返回 { ok, value:{accepted} } 或 { ok:false, error })。
		// 类本身未导出 ⇒ 用「已捕获实例的 prototype」包装 (WeakSet 去重, 一次包装覆盖所有会话)。
		//
		// ⚠️ 2026-09-12 修复: P3 的两条捕获路径在 0.1.2 下**都拿不到会话**, 拦截器从未安装且完全静默:
		//   ① apply 发生在页面启动早期, `sessions.list` 快照的 current 仍是 undefined (seed 落空);
		//   ② 唯一兜底 = 药丸槽 props.session —— 但 0.1.2 的 session 作用域槽只给
		//      `props.sessionId` + `useSession` hook (源码: renderSlot("conversation.input.left", {})),
		//      老代码读 props.session 恒 undefined → 药丸 return null → 兜底也没了。
		//   现在三条并行捕获路径 (任一成功即完成原型包装), 且每一步都上报诊断:
		//     a) 订阅 `sessions.list` (列表就绪/切换会话时补挂, 解决页面早期 current 为空);
		//     b) 药丸渲染时用 useSession hook / 槽 inject 工厂第一参(会话 id) 捕获实例;
		//     c) `window.__dshTaskqueueDebug` + /queue RPC diag (无浏览器控制台也能远程确认是否装上)。
		var patchedPromptProtos = new WeakSet();
		// controller 绑定键: 放在被包装原型的标记属性上 (每次 apply 重新指向当前 controller,
		// 避免插件热重载/重复 apply 后旧 controller 的 60s 状态缓存残留)
		var CTL_KEY = "__dshTaskqueueOffpeakCtl";
		var captureSessionFn = null; // 由 installPromptInterceptor 赋值; 药丸/槽位渲染时把会话实例喂进来
		var lastPillDiagKey = "";
		// 诊断状态 (供 CDP/E2E 与用户自查: window.__dshTaskqueueDebug)
		var debugState = { version: "0.8.6", installed: false, sendPatched: false, sessionId: null, lastEvent: null, lastAt: 0 };
		try { window.__dshTaskqueueDebug = debugState; } catch (e) { /* 非浏览器环境忽略 */ }
		/** v0.8.6: 错峰拦截是否"确定未安装" —— 渲染期读取 (不缓存: 拦截器是异步补挂的)。
		 *  fail-loud 语义: 未安装 = 高峰消息会直发 (按高峰价), UI 必须显示红字告警,
		 *  绝不伪装成"平峰 · 正常发送" (历史三次静默失效: 坑 14/16/22)。 */
		function interceptorMissing() {
			try { return debugState.installed !== true; } catch (e) { return false; }
		}
		function diag(controller, event, detail) {
			debugState.lastEvent = event;
			debugState.lastAt = Date.now();
			debugState.detail = detail || {};
			try {
				if (typeof controller === "function") controller(event, detail || {});
				else if (controller && typeof controller.report === "function") controller.report(event, detail || {});
			} catch (e) { /* 诊断不影响功能 */ }
		}
		/** 取会话实例: sessions 服务优先 (不依赖是否已渲染), 兜底用槽位捕获到的实例 */
		function acquireSession(ctx, sessionId, fallback) {
			var sessions = ctx.get("sessions");
			if (sessions && typeof sessions.binding === "function" && sessionId) {
				try {
					var binding = sessions.binding(sessionId);
					if (binding && binding.session) return binding.session;
				} catch (e) { /* 未 scoped/未列出 → 走兜底 */ }
			}
			return fallback || null;
		}
		/**
		 * 包装会话实例原型上的 prompt。返回 true 表示本次成功包装 (或已包装)。
		 * 原方法签名 (0.1.2): (content, mode, signal, requestId)，用 variadic 转发保证不过期。
		 */
		function patchSessionPrompt(controller, session, why) {
			if (!session) return false;
			var proto = Object.getPrototypeOf(session);
			if (!proto) return false;
			// 同一原型只包装一次; controller 绑定放在原型标记属性上, 每次 apply 重新指向
			// (插件热重载/重复 apply 时旧 controller 的 60s 状态缓存不会残留)
			if (!patchedPromptProtos.has(proto)) {
				var origPrompt = proto.prompt;
				if (typeof origPrompt !== "function") {
					diag(controller, "patch.no-prompt", { why: why, proto: String((proto.constructor && proto.constructor.name) || "?") });
					return false;
				}
				proto.prompt = async function (content, mode, signal, requestId) {
					var ctl = this[CTL_KEY];
					try {
						// 只拦截: 开关开 + 高峰 + 纯文本 (无图片) + 非空 + 本会话未豁免
						var status = ctl ? await ctl.getStatus() : null;
						if (status && status.enabled === true && status.peak === true) {
							var parts = Array.isArray(content) ? content : [];
							var hasImage = parts.some(function (p) { return p && p.type === "image"; });
							var text = parts.filter(function (p) { return p && p.type === "text" && typeof p.text === "string"; })
								.map(function (p) { return p.text; }).join("").trim();
							var sessionId = this && (this.sessionId || this.id);
							if (!hasImage && text !== "" && sessionId) {
								// v0.8.0: 豁免会话 (服务端持久化 exempt map) 高峰照常发送
								var exempt = !!(status.exempt && status.exempt[sessionId] === true);
								if (!exempt) {
									var res = await ctl.addTask(text, sessionId);
									if (res && res.ok) {
										// engaged = 服务端把该 blank 会话转正了 (发了确认 turn, 防 GUI 复用新会话导致串台)
										diag(ctl, "hit.queued", { sessionId: sessionId, chars: text.length, debug: status.debug, taskId: res.value && res.value.id, engaged: !!(res.value && res.value.engaged) });
										// 模拟 prompt 成功 (composer 清空输入框; 队列横幅由服务端注入, 消息不进 LLM)
										return { ok: true, value: { accepted: true } };
									}
									diag(ctl, "hit.add-failed", { sessionId: sessionId, error: (res && res.error) || null });
									// 入队失败 → 不静默吞消息, 回退正常发送
								}
							}
						}
					} catch (e) { diag(ctl, "hit.error", { error: String((e && e.message) || e) }); }
					return origPrompt.call(this, content, mode, signal, requestId);
				};
				patchedPromptProtos.add(proto);
				diag(controller, "interceptor.installed", { why: why });
			}
			try { proto[CTL_KEY] = controller; } catch (e) { return false; }
			return true;
		}
		/**
		 * v0.8.5: 在 **conversation.sendSession** 上再加一层拦截, 目的是"根本别建本地乐观 echo"。
		 * 背景: composer 提交 = sink → `conversation.sendSession(session, text, imageIds, mode, signal)`
		 *   → `session.beginSubmission(...)`(同步插入一条**本地 submitted echo**, 即 GUI 里"发出去了"的
		 *   那条消息) → `session.prompt(...)`。只在 prompt 层拦截时, echo 已经建好了: 我们返回模拟成功,
		 *   而这条消息永远不会被宿主回执 → echo **永不 retire**, 表现为"聊天里出现一条消息, 刷新后消失"
		 *   (用户实测反馈)。
		 * 这里前移到 sendSession: 命中错峰 → 调 RPC 入队 + 直接返回 `{kind:"success"}`(composer 清空
		 *   输入框、草稿/图片按成功处理), **完全不进入 beginSubmission** ⇒ 不产生任何幽灵消息;
		 *   会话里只剩「给 agent 的固定提示(转正确认 turn)」+「任务 #N 已入队」横幅。
		 * 兼容性: 只在"开关开 + 高峰 + 无图片 + 文本非空 + 本会话未豁免"时短路, 其余情况**原样转发**
		 *   给官方实现 (含图片序列化/回执 retirement 逻辑一行未动); session.prompt 那层包装保留作兜底
		 *   (programmatic `conversation.send()`、子会话等路径仍走 prompt)。
		 */
		var patchedSendProtos = new WeakSet();
		function patchConversationSendSession(controller, conversation) {
			if (!conversation) return false;
			var proto = Object.getPrototypeOf(conversation);
			if (!proto) return false;
			if (!patchedSendProtos.has(proto)) {
				var origSend = proto.sendSession;
				if (typeof origSend !== "function") {
					diag(controller, "patch.no-sendSession", { proto: String((proto.constructor && proto.constructor.name) || "?") });
					return false;
				}
				proto.sendSession = async function (session, text, imageIds, mode, signal) {
					var ctl = this[CTL_KEY] || controller;
					try {
						var ids = Array.isArray(imageIds) ? imageIds : [];
						var body = typeof text === "string" ? text.trim() : "";
						if (ids.length === 0 && body !== "") {
							var status = ctl ? await ctl.getStatus() : null;
							if (status && status.enabled === true && status.peak === true) {
								var sessionId = session && (session.sessionId || session.id);
								var exempt = !!(status.exempt && sessionId && status.exempt[sessionId] === true);
								if (sessionId && !exempt) {
									var res = await ctl.addTask(body, sessionId);
									if (res && res.ok) {
										diag(ctl, "hit.queued", {
											sessionId: sessionId, chars: body.length, debug: status.debug,
											taskId: res.value && res.value.id, engaged: !!(res.value && res.value.engaged),
											via: "sendSession" // v0.8.5: 未建本地 echo (无幽灵消息)
										});
										return { kind: "success" }; // 官方 composer 只判 kind
									}
									diag(ctl, "hit.add-failed", { sessionId: sessionId, via: "sendSession", error: (res && res.error) || null });
								}
							}
						}
					} catch (e) { diag(ctl, "hit.error", { via: "sendSession", error: String((e && e.message) || e) }); }
					return origSend.call(this, session, text, imageIds, mode, signal);
				};
				patchedSendProtos.add(proto);
				try { debugState.conversationRef = conversation; } catch (e) { /* 调试引用失败忽略 */ }
				diag(controller, "interceptor.sendSession", { why: "patched" });
			}
			try { proto[CTL_KEY] = controller; } catch (e) { return false; }
			return true;
		}

		function installPromptInterceptor(ctx, controller) {
			// v0.8.5: 第一优先 —— 包装 conversation.sendSession (composer 的真实入口, 在建本地 echo 之前)
			try {
				var conversation = ctx.get("conversation");
				// 调试/E2E 引用: 无论包装成败都暴露 (便于真浏览器测试直接走官方 composer 入口)
				try { if (conversation) debugState.conversationRef = conversation; } catch (e) { /* ignore */ }
				var okSend = patchConversationSendSession(controller, conversation);
				debugState.sendPatched = okSend === true;
				diag(controller, "apply.conversation", { hasConversation: !!conversation, sendSessionPatched: debugState.sendPatched });
			} catch (e) { diag(controller, "patch.sendSession-error", { error: String((e && e.message) || e) }); }
			// 供药丸/槽位在渲染时把会话实例喂进来 (渲染必然早于发送)
			captureSessionFn = function (s) {
				if (!s) return false;
				var sid = s.id || s.sessionId || null;
				var inst = acquireSession(ctx, sid, s);
				var ok = patchSessionPrompt(controller, inst, "capture");
				if (ok) debugState.installed = true;
				if (inst) debugState.sessionRef = inst; // 调试/E2E: 当前会话实例 (与 composer 发送同一对象)
				if (sid && debugState.sessionId !== sid) {
					debugState.sessionId = sid;
					diag(controller, "session.captured", { sessionId: sid, hasInstance: !!inst, patched: ok });
				}
				return ok;
			};
			var sessions = null;
			try { sessions = ctx.get("sessions"); } catch (e) { sessions = null; }
			diag(controller, "apply", {
				hasSessions: !!sessions,
				hasList: !!(sessions && sessions.list),
				hasBinding: !!(sessions && typeof sessions.binding === "function")
			});
			// a) 立即尝试 seed + 订阅会话列表 (current 出现/切换会话时补挂)
			function seed() {
				try {
					var snap = sessions && sessions.list && sessions.list.getSnapshot && sessions.list.getSnapshot();
					var id = snap && (snap.current || (snap.ids && snap.ids[0]));
					if (id) captureSessionFn({ id: id, sessionId: id });
				} catch (e) { diag(controller, "seed.error", { error: String((e && e.message) || e) }); }
			}
			seed();
			if (sessions && sessions.list && typeof sessions.list.subscribe === "function") {
				try {
					var unsub = sessions.list.subscribe(seed);
					ctx.effect(function () {
						return function () { try { unsub(); } catch (e) { /* 卸载失败忽略 */ } };
					}, "ui-taskqueue: 错峰拦截器补挂 (sessions.list 订阅)");
				} catch (e) { diag(controller, "subscribe.error", { error: String((e && e.message) || e) }); }
			}
			// c) 兜底: 订阅也没拿到时, 短时重试 (会话列表/作用域就绪有延迟)
			//    v0.8.5: 同时重试 conversation.sendSession 包装 (该服务若在本插件 apply 时尚未就绪)
			//    整段 try/catch: 定时器不可用/异常绝不能让 apply 中断 (否则药丸与设置卡都不注册)
			try {
				// ⚠️ 实测: `conversation` 服务在 apply 时**通常还没就绪** (cordis 只按 exports.inject
				//    ["slots","locale","connection","sessions"] 门控 apply), sendSession 包装实际是靠这里
				//    的补挂完成的 —— 因此窗口给足 2 分钟 (60 次), 只在两者都完成时提前退出。
				var tries = 0;
				var timer = setInterval(function () {
					tries += 1;
					if (debugState.installed && debugState.sendPatched) { clearInterval(timer); return; }
					if (tries > 60) {
						clearInterval(timer);
						if (!debugState.sendPatched) diag(controller, "sendSession.give-up", { tries: tries - 1 });
						return;
					}
					seed();
					try {
						var convNow = ctx.get("conversation");
						if (convNow) {
							try { debugState.conversationRef = convNow; } catch (e) { /* ignore */ }
							if (!debugState.sendPatched) debugState.sendPatched = patchConversationSendSession(controller, convNow);
						}
					} catch (e) { /* 下轮再试 */ }
				}, 2000);
				ctx.effect(function () { return function () { clearInterval(timer); }; }, "ui-taskqueue: 错峰拦截器安装重试");
			} catch (e) { diag(controller, "retry.unavailable", { error: String((e && e.message) || e) }); }
		}

		// ---------- 设置卡: 错峰出行模式开关 + 高峰暂停子开关 + 状态 ----------
		function TaskQueueCard(props) {
			var t = props.t;
			var state = props.useTaskQueue(function (s) { return s; });
			var loaded = !!state.loaded;
			var busy = React.useRef(false);
			var [flash, setFlash] = React.useState(false);
			// v0.9.0: 高峰暂停子开关 (全局, 与胶囊弹层同一个 RPC mode.set {pause})
			var pauseBusy = React.useRef(false);
			var [pauseFlash, setPauseFlash] = React.useState(false);
			function toggle() {
				if (busy.current) return;
				busy.current = true;
				props.setEnabled(!state.enabled).then(function () {
					busy.current = false;
					setFlash(true);
					setTimeout(function () { setFlash(false); }, 1200);
				}, function () { busy.current = false; });
			}
			function togglePause() {
				if (pauseBusy.current || typeof props.setPause !== "function") return;
				pauseBusy.current = true;
				props.setPause(state.pause === false).then(function () {
					pauseBusy.current = false;
					setPauseFlash(true);
					setTimeout(function () { setPauseFlash(false); }, 1200);
				}, function () { pauseBusy.current = false; });
			}
			var statusState = !loaded ? "loading" : state.status === "error" ? "error" : (state.enabled ? (state.peak ? "peak" : "offpeak") : "off");
			// v0.8.6: 模式开着但拦截器没装上 ⇒ 红字告警 (否则会显示"平峰·正常发送"误导用户)
			var broken = state.enabled === true && loaded && state.status !== "error" && interceptorMissing();
			if (broken) statusState = "broken";
			// v0.8.3 debug: 强制时段时在状态文案后明确标注 (只读显示; 防"忘记关")
			var forced = state.debug && state.debug !== "auto" ? " [强制 " + state.debug + " · debug]" : "";
			// v0.9.0: 闸门自检失败 ⇒ 状态文案追加一句 (可见性; 服务端仍照常工作, 只是不暂停)
			var statusText = statusState === "loading" ? t("statusLoading")
				: statusState === "error" ? t("statusError")
					: statusState === "broken" ? t("statusBroken")
						: statusState === "peak" ? t("statusPeak") + forced
							: statusState === "offpeak" ? t("statusOffpeak") + forced
								: "";
			if (loaded && state.pauseInstalled === false) {
				statusText = (statusText ? statusText + " · " : "") + t("pauseBroken");
			}
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
					React.createElement("div", { className: "dsh-tq-mode-row" }, [
						React.createElement("b", null, t("pauseLabel")),
						React.createElement("button", {
							type: "button",
							className: "dsh-tq-switch",
							"data-tq": "pause-switch",
							role: "switch",
							"aria-checked": state.pause !== false,
							"aria-label": t("pauseAria"),
							"data-on": state.pause !== false ? "true" : "false",
							onClick: togglePause
						})
					]),
					React.createElement("p", { className: "dsh-tq-hint" }, t("pauseHint")),
					React.createElement("p", { className: "dsh-tq-hint" }, flash ? t("saved") : ""),
					React.createElement("p", { className: "dsh-tq-hint" }, pauseFlash ? t("saved") : "")
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
			// ⚠️ 0.1.2 修复: 会话作用域槽 (conversation.input.left) 只提供 props.sessionId +
			// useSession hook —— 旧代码读 props.session 恒 undefined, 导致药丸 return null (消失)
			// 且拦截器的兜底捕获也一起失效。这里三种来源全兼容 (hook > props.session > props.sessionId)。
			var sessionFromHook = null;
			if (typeof props.useSession === "function") {
				try { sessionFromHook = props.useSession(function (s) { return s; }); } catch (e) { sessionFromHook = null; }
			}
			var session = sessionFromHook || props.session || null;
			var sessionId = props.sessionId || (session && (session.id || session.sessionId)) || null;
			var exempt = !!(ready && sessionId && state.exempt && state.exempt[sessionId] === true);
			var peak = state.peak === true;
			// v0.9.0: 本会话是否正在"高峰暂停" (服务端 paused.sessions 含当前会话)
			var pausedRec = null;
			if (ready && sessionId && state.paused && Array.isArray(state.paused.sessions)) {
				for (var i = 0; i < state.paused.sessions.length; i++) {
					var rec = state.paused.sessions[i];
					if (rec && rec.sessionId === sessionId) { pausedRec = rec; break; }
				}
			}
			// 预计恢复时刻 (北京时区 HH:MM; 解析失败则不显示)
			var resumeHm = "";
			try {
				if (pausedRec && pausedRec.nextOffpeakAt) {
					var d = new Date(pausedRec.nextOffpeakAt);
					if (!isNaN(d.getTime())) {
						resumeHm = new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(11, 16);
					}
				}
			} catch (e) { resumeHm = ""; }
			var paused = !!pausedRec;
			var pillState = !ready ? "offpeak" : (paused ? "paused" : (exempt ? "exempt" : (peak ? "peak" : "offpeak")));
			var label = !ready ? "" : (paused ? t("pillPaused") : (exempt ? t("pillExempt") : (peak ? t("pillPeak") : t("pillOffpeak"))));
			var desc = !ready ? "" : (paused ? t("descPaused") : (exempt ? t("descExempt") : (peak ? t("descPeak") : t("descOffpeak"))));
			// v0.8.6 fail-loud: 拦截器未安装 ⇒ 红态 + 说清"消息将直发 (按高峰价)"
			if (ready && interceptorMissing()) {
				pillState = "broken";
				label = t("statusBroken");
				desc = t("descBroken");
			}
			var aria = label ? t("triggerAria").replace("%s", label) : "";
			function toggleExempt() {
				if (busy.current || !props.setExempt || !sessionId) return;
				busy.current = true;
				props.setExempt(sessionId, !exempt).then(function () {
					busy.current = false;
				}, function () { busy.current = false; });
			}
			// v0.9.0: 全局「高峰暂停」开关 (RPC mode.set {pause}; 失败 ⇒ controller 已回退 UI 到服务端真实状态)
			function togglePause() {
				if (busy.current || typeof props.setPause !== "function") return;
				busy.current = true;
				props.setPause(state.pause === false).then(function () {
					busy.current = false;
				}, function () { busy.current = false; });
			}
			function toggleOpen() {
				setOpen(function (v) { return !v; });
			}
			// 0.1.2 适配 (P3/修复): 渲染即把会话实例喂给拦截器 (sessions.binding 取不到时的兜底原型捕获)
			React.useEffect(function () {
				if (captureSessionFn && session) { try { captureSessionFn(session); } catch (e) { /* 捕获失败不影响渲染 */ } }
				if (sessionId && lastPillDiagKey !== sessionId) {
					lastPillDiagKey = sessionId;
					diag(props.report, "pill.session", {
						sessionId: sessionId,
						from: sessionFromHook ? "useSession" : (props.session ? "props.session" : "props.sessionId"),
						hasInstance: !!session
					});
				}
			}, [session, sessionId]);
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
			}, [open, exempt, peak, paused]);
			if (!ready || !sessionId) return null;
			var popEl = null;
			if (open) {
				var rows = [];
				// v0.9.0: ① 全局「高峰暂停」开关 (服务端 mode.set {pause})
				rows.push(React.createElement("div", { className: "dsh-tq-pop-row", key: "sw-pause" }, [
					React.createElement("span", null, t("pauseRowLabel")),
					React.createElement("button", {
						type: "button",
						className: "dsh-tq-sw",
						"data-tq": "pause-switch",
						role: "switch",
						"aria-checked": state.pause !== false,
						"aria-label": t("pauseAria"),
						"data-on": state.pause !== false ? "true" : "false",
												onClick: togglePause
					})
				]));
				// ② 本会话豁免 (v0.8.2 起统一收在弹层; 仅在高峰时有意义)
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
					// v0.9.0 状态行: 暂停中显示"已暂停 · 预计 HH:MM 继续"
					paused && resumeHm ? React.createElement("div", { className: "dsh-tq-pop-desc", "data-tq": "paused-line" }, t("statusPaused").replace("%s", resumeHm)) : null,
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
			// (D, 2026-09-10) 2026-09-09 的临时停用 return 已移除: 服务端已根治重放(E 熔断+终态+claim 驱动),
			// 客户端恢复"错峰拦截 + 队列面板 + 输入框状态条"。拦截器本身完全防御式(任何异常回退原发送)。
			injectCss();
			ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "ui-taskqueue: dictionaries");
			var t = ctx.locale.bind(NS);
			var controller = createController(ctx.get("connection"));

			// 0) 错峰出行模式拦截 (session.prompt)
			//    整段防御: 拦截器安装异常绝不能让下面的药丸/设置卡注册中断 (否则整个客户端半边失效)
			try { installPromptInterceptor(ctx, controller); } catch (e) { diag(controller, "install.failed", { error: String((e && e.message) || e) }); }

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
							setExempt: controller.setExempt,
							setPause: controller.setPause, // v0.9.0: 全局高峰暂停开关
							report: controller.report
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
							setEnabled: controller.setEnabled,
							setPause: controller.setPause // v0.9.0: 设置卡里的高峰暂停开关 (同一 RPC)
						};
					}
				}, TaskQueueCard);
			});
		}

		exports.inject = inject;
		exports.apply = apply;
		// v0.8.6: 冒烟/对撞测试专用导出 (仅 window.__DSH_SMOKE__ 置位时; 生产浏览器不置位不启用)
		if (typeof window !== "undefined" && window.__DSH_SMOKE__) {
			exports.__test = {
				TaskQueuePill: TaskQueuePill,
				TaskQueueCard: TaskQueueCard,
				dictZh: zh,
				interceptorMissing: interceptorMissing,
				debugState: debugState
			};
		}
		return module.exports;
	}
});
