/** SDK 会话生命周期、上下文投影和用户回显；不持有传输连接。 */
import { messageView, attachImageUrls, historyFrames, eventFrame } from './protocol.mjs';

/** 创建会话控制器；切换时先收尾旧资源，再公布新会话和历史。 */
export function createSessionRuntime({ sdk, cwd, mode, sessionPath, pluginUi, broadcast, timings, telemetry, ui }) {
	/** 当前会话：{ session, unsubscribe }。 */
	let active = null;

	/** 是否正在跑回合（决定新消息走 prompt 还是 steer）。 */
	let busy = false;

	/** 是否成功给插件绑定了可交互的 UI 上下文（声明放在 sessionInfo 之前，避免暂时性死区）。 */
	let pluginUiBound = false;

	/** 当前会话的插件加载错误（只留前几条，页面提示用）。 */
	let pluginErrors = [];

	/**
	 * 攒着等条目 id 的用户消息回显帧。
	 * pi 是先发 message_end 事件、之后才写会话文件，事件回调里查不到条目 id；
	 * 把这一帧攒到写库之后（下一拍或下一个事件）再发，页面才能给本地那行标上回退目标。
	 */
	let pendingEcho = null;

	/** 当前上下文路径上的消息视图（带 entryId），回退与历史下发共用同一份顺序。 */
	function currentViews() {
		const session = active?.session;
		const manager = session?.sessionManager;
		// projection 就是 agent.state.messages 的来源，按它配对才能拿到条目 id
		if (typeof manager?.buildSessionProjection === 'function') {
			const views = [];
			for (const entry of manager.buildSessionProjection()?.entries ?? []) {
				const entryId = entry?.sourceEntry?.id ?? '';
				for (const message of entry?.messages ?? []) views.push(timings.withTiming(messageView(message, entryId), entryId));
			}
			return views;
		}
		// 老版本 SDK 没有 projection：仍然下发历史，只是没有 entryId（页面据此禁用回退、也不显示耗时）
		return (session?.state?.messages ?? []).map((message) => timings.withTiming(messageView(message), ''));
	}

	/** 广播当前上下文路径的完整历史（建连、新建/切换会话、回退之后都要让页面重放）。 */
	function broadcastHistory() {
		for (const frame of historyFrames(currentViews())) broadcast(frame);
	}

	/** 按参数决定会话管理器。 */
	function currentSessionManager() {
		const { SessionManager } = sdk;
		if (sessionPath) return SessionManager.open(sessionPath);
		if (mode === 'new') return SessionManager.create(cwd);
		return SessionManager.continueRecent(cwd);
	}

	/** 暂存一条用户消息回显；先补发上一条，避免连发时丢帧。 */
	function deferUserEcho(message) {
		flushUserEcho();
		pendingEcho = { message, timer: setTimeout(flushUserEcho, 0) };
	}

	/** 把攒着的回显帧补上条目 id 后发出；没有则什么也不做。 */
	function flushUserEcho() {
		if (!pendingEcho) return;
		const { message, timer } = pendingEcho;
		pendingEcho = null;
		if (timer) clearTimeout(timer);
		const frame = eventFrame({ type: 'message_end', message });
		// 查不到 id（极端时序）也照发：退回到“这行暂时不能回退”，不影响消息本身
		if (frame?.message) frame.message.entryId = timings.resolveEntryId(message);
		// 条目 id 定下来之后才能给出图片取图地址（实时回显的图片也要能显示）
		attachImageUrls(frame?.message);
		broadcast(frame);
	}

	/** 当前模型支持的思考等级（老版本 SDK 没有该方法时返回空数组，不影响其它路由）。 */
	function availableThinkingLevels(session) {
		return typeof session?.getAvailableThinkingLevels === 'function' ? session.getAvailableThinkingLevels() : [];
	}

	/** 判断两个模型是否是同一个（provider + id）。 */
	function sameModel(a, b) {
		return Boolean(a && b && a.provider === b.provider && a.id === b.id);
	}

	/** 可用模型的裁剪视图（去掉 headers / compat 等页面用不到、且不宜外发的字段）。 */
	function modelView(model) {
		return {
			provider: model.provider,
			id: model.id,
			name: model.name || model.id,
			reasoning: Boolean(model.reasoning),
			contextWindow: model.contextWindow ?? 0,
			input: Array.isArray(model.input) ? model.input : [],
		};
	}

	/** 已配鉴权的可用模型列表（当前模型置顶，其余按 provider / id 排序）。 */
	function availableModels() {
		const current = active?.session?.model;
		const models = (active?.session?.modelRuntime?.getAvailableSnapshot() ?? []).map(modelView);
		models.sort((a, b) => {
			const aCurrent = sameModel(a, current);
			const bCurrent = sameModel(b, current);
			if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
			if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
			return a.id.localeCompare(b.id);
		});
		return models;
	}

	/** 全局默认模型（settings 里的 provider / id），没设置则返回 null。 */
	function defaultModel() {
		const settings = active?.session?.settingsManager;
		const provider = settings?.getDefaultProvider?.();
		const id = settings?.getDefaultModel?.();
		return provider && id ? { provider, id } : null;
	}

	/** 当前会话的可公开信息。 */
	function sessionInfo() {
		const session = active?.session;
		const model = session?.model;
		return {
			cwd,
			sessionId: session?.sessionId ?? null,
			sessionFile: session?.sessionFile ?? null,
			model: model?.provider && model?.id ? `${model.provider}/${model.id}` : null,
			modelName: model?.name ?? null,
			modelReasoning: Boolean(model?.reasoning),
			contextWindow: model?.contextWindow ?? null,
			thinkingLevel: session?.thinkingLevel ?? null,
			thinkingLevels: availableThinkingLevels(session),
			busy,
			// 用量快照（输入/输出/缓存/费用/上下文占用），页面输入区下方那一行
			usage: telemetry.usageInfo(session),
			// 正在跑的回合：页面刷新/重连后据此接着跳回合计时
			turn: timings.currentTurnInfo(),
			// 插件是否拿到了可交互的界面（老版本 SDK 没有 bindExtensions、或启动时关了插件界面时为 false）
			pluginUi: pluginUiBound,
			// 插件加载失败列表（页面一次性提示，避免静默失效）
			pluginErrors,
			pid: process.pid,
		};
	}

	/** 广播当前会话上下文（boot、切模型、切思考等级之后都要刷新页面顶栏）。 */
	function broadcastSession(extra = {}) {
		broadcast({ kind: 'session', info: { ...sessionInfo(), ...extra } });
	}

	/**
	 * 取当前会话里某条消息的第 index 张图片（页面历史回显用）。
	 * 被回退移出上下文的旧分支不在 projection 里，取不到就返回 null。
	 */
	function findSessionImage(entryId, index) {
		if (!entryId || index < 0) return null;
		const manager = active?.session?.sessionManager;
		if (typeof manager?.buildSessionProjection !== 'function') return null;
		for (const entry of manager.buildSessionProjection()?.entries ?? []) {
			if ((entry?.sourceEntry?.id ?? '') !== entryId) continue;
			let seen = 0;
			for (const message of entry?.messages ?? []) {
				if (!Array.isArray(message?.content)) continue;
				for (const block of message.content) {
					if (block?.type !== 'image') continue;
					if (seen === index) {
						return typeof block.data === 'string' && block.data
							? { data: block.data, mimeType: typeof block.mimeType === 'string' ? block.mimeType : '' }
							: null;
					}
					seen += 1;
				}
			}
			return null;
		}
		return null;
	}

	/**
	 * 建立（或重建）会话：dispose 旧的，按参数开新的，重新订阅事件。
	 */
	async function boot() {
		// 换会话前先把旧会话手上的对话框交回（否则那些 Promise 永远不会被 resolve）、
		// 把耗时的最后一批落盘、挂着的标题补发、攒着的回显帧补发（都依赖 active，必须在替换前调用）
		ui.settleAllUI();
		telemetry.rateReset();
		ui.flushTitle();
		flushUserEcho();
		timings.flushTimings();
		if (active) {
			try {
				active.unsubscribe();
			} catch {}
			try {
				active.session.dispose();
			} catch {}
		}
		const sessionManager = currentSessionManager();
		const { session, modelFallbackMessage, extensionsResult } = await sdk.createAgentSession({
			cwd,
			sessionManager,
			// 插件的 session_start 分支据此区分“新会话 / 恢复会话”
			sessionStartEvent: { type: 'session_start', reason: sessionPath || mode === 'continue' ? 'resume' : 'new' },
		});
		const unsubscribe = session.subscribe((event) => {
			const type = event?.type;
			if (type === 'agent_start') busy = true;
			if (type === 'agent_settled') busy = false;
			// 速率采样只关心助手输出的开始 / 增量 / 结束
			if (type === 'message_start' && event.message?.role === 'assistant') telemetry.rateStart();
			else if (type === 'message_update' && event.message?.role === 'assistant') telemetry.rateUpdate(event);
			// 用量会变的时点：攒一拍再算（getSessionStats 要遍历整个会话）
			if (type === 'turn_end' || (type === 'message_end' && event.message?.role !== 'user')) telemetry.scheduleUsage();
			if (type === 'message_end' && event.message?.role === 'user') {
				// 用户消息回显要等写库后才能取条目 id，先攒起来
				timings.trackTiming(event);
				deferUserEcho(event.message);
				return;
			}
			const extra = timings.trackTiming(event);
			// 助手这一条模型调用结束：定格平均速率（durationMs 就是同一份实测耗时）
			if (type === 'message_end' && event.message?.role === 'assistant') telemetry.rateEnd(event.message, extra?.durationMs);
			// 回合收尾（中止、报错、正常结束都要经过这里）：实时速率不再有效
			if (type === 'agent_settled') telemetry.rateReset();
			// 先补发攒着的回显帧，再推这一帧，对外顺序与不延迟时一致
			flushUserEcho();
			broadcast(eventFrame(event, extra));
		});
		active = { session, unsubscribe };
		busy = false;
		timings.resetRun();
		pluginErrors = (extensionsResult?.errors ?? []).slice(0, 5).map((item) => ({
			path: String(item?.path ?? ''),
			error: String(item?.error ?? ''),
		}));
		timings.loadTimings();
		broadcastSession({ modelFallbackMessage: modelFallbackMessage || undefined });
		// 新建 / 切换会话后要让页面立即重放历史（history 帧平时只在 SSE 建连时发一次）
		broadcastHistory();
		// 给插件绑定页面 UI：要等历史发完再绑，否则插件的 session_start 一上来就弹对话框、
		// 而页面还是空的。mode 传 'rpc'：这是 pi 给“没有真终端、但有对话框原语”的宿主定的模式，
		// 插件据此走 select / input 降级路径；传 'tui' 会让插件去调只在终端可用的覆盖层（例如
		// pi-mcp-adapter 的面板要求 hasUI && mode === 'tui'，在无终端时那个回调永远不会被调用，命令会挂住）。
		if (pluginUi && typeof session.bindExtensions === 'function') {
			try {
				await session.bindExtensions({
					uiContext: ui.createExtensionUIContext(),
					mode: 'rpc',
					onError: (info) =>
						ui.pushUI({ phase: 'notice', level: 'error', message: `插件出错（${info?.event ?? '未知事件'}）：${info?.error ?? ''}` }),
				});
				pluginUiBound = true;
			} catch (err) {
				pluginUiBound = false;
				ui.pushUI({ phase: 'notice', level: 'error', message: `插件界面绑定失败：${String(err?.message ?? err)}` });
			}
		} else {
			// 启动时用 --no-plugin-ui 关掉了，或老版本 SDK 没有这个入口：页面据 sessionInfo().pluginUi 提示
			pluginUiBound = false;
		}
		return active;
	}

	/** 读取当前会话，供计时、用量和额度模块使用，不暴露 active 容器。 */
	function getSession() { return active?.session; }

	/** 读取回合运行状态，保留 prompt 自动转 steer 的判断来源。 */
	function isBusy() { return busy; }

	/** 清除显式会话路径后新建；旧会话由 boot 先完成收尾。 */
	async function newSession() {
		sessionPath = '';
		mode = 'new';
		return boot();
	}

	/** 切换到已经由路由确认归属的会话文件。 */
	async function switchSession(file) {
		sessionPath = file;
		return boot();
	}

	/** 解除会话订阅并释放 SDK 会话；调用方必须先补发回显和落盘。 */
	function dispose() {
		try { active?.unsubscribe(); } catch {}
		try { active?.session?.dispose(); } catch {}
	}

	return { getSession, isBusy, boot, sessionInfo, currentViews, broadcastHistory, broadcastSession, availableThinkingLevels, sameModel, availableModels, defaultModel, findSessionImage, newSession, switchSession, flushUserEcho, dispose };
}
