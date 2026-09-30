/** 插件 UI 桥接与请求收尾 */

/** 页面全断开后，还等这么久再把手上的插件对话框按默认值收尾，避免刷新页面把回合挂死。 */
const UI_DISCONNECT_GRACE_MS = 30000;

/** 单个插件对话框的总上限：插件自己没设超时、或干脆不 await（fire-and-forget）时，超过就按默认值收尾。 */
const UI_ANSWER_TIMEOUT_MS = 10 * 60 * 1000;

/** 1 秒内重复的插件通知只保留第一条（扩展可能在循环里反复通知同一件事）。 */
const UI_NOTICE_DEDUPE_MS = 1000;

/** 标题尾随去抖：有的扩展用动画标题（每十几毫秒改一次），不该每一帧都发到页面。 */
const UI_TITLE_DEBOUNCE_MS = 800;

/**
 * 不转发给页面的插件状态键：有些键在终端状态栏里有意义，在页面里只是噪声。
 * 默认隐藏 mcp（pi-mcp-adapter 的常驻状态）；PIGUI_HIDE_STATUS 设成空串即全部显示。
 */
const HIDDEN_STATUS_KEYS = new Set(
	String(process.env.PIGUI_HIDE_STATUS ?? 'mcp')
		.split(',')
		.map((key) => key.trim().toLowerCase())
		.filter(Boolean),
);

/** 创建插件 UI 桥接与请求收尾；资源和状态由实例持有。 */
export function createPluginUI({ broadcast, getClientCount }) {
	/**
	 * 等待页面回答的插件对话框：id → { resolve, method, request, timer, signal, onAbort }。
	 * 一个回合里可能同时有多个（例如先选权限模式、再确认本次修改），在页面里按到达顺序排队。
	 */
	const pendingUI = new Map();

	/** 页面全断开后的收尾计时器。 */
	let uiGraceTimer = null;

	/** 最近一条插件通知，用于 1 秒内相同通知去重。 */
	let lastNotice = { key: '', at: 0 };

	/** 标题去抖的句柄与待发标题。 */
	let uiTitleTimer = null;

	let uiPendingTitle = '';

	/** 对话框 id 的自增序号。 */
	let uiSeq = 0;

	/**
	 * 给插件的主题占位：页面用 CSS 上色，这里不做 ANSI 着色，
	 * 只保证插件调用 theme.fg() / bold() 之类不会报错（返回值是纯文本）。
	 */
	const plainTheme = {
		name: 'pigui-plain',
		/** 忽略终端前景色，返回可供页面展示的文本。 */
		fg: (_color, text) => String(text),
		/** 忽略终端背景色，返回原始文本。 */
		bg: (_color, text) => String(text),
		/** 网页不生成 ANSI 粗体标记。 */
		bold: (text) => String(text),
		/** 网页不生成 ANSI 斜体标记。 */
		italic: (text) => String(text),
		/** 网页不生成 ANSI 下划线标记。 */
		underline: (text) => String(text),
		/** 网页不生成 ANSI 反色标记。 */
		inverse: (text) => String(text),
		/** 网页不生成 ANSI 删除线标记。 */
		strikethrough: (text) => String(text),
		/** 页面前景色由 CSS 控制，不提供终端转义序列。 */
		getFgAnsi: () => '',
		/** 页面背景色由 CSS 控制，不提供终端转义序列。 */
		getBgAnsi: () => '',
		/** 提供插件需要的颜色模式标识，不生成 ANSI 颜色。 */
		getColorMode: () => 'truecolor',
		/** 返回思考边框的纯文本转换函数。 */
		getThinkingBorderColor: () => (text) => String(text),
		/** 返回 Bash 边框的纯文本转换函数。 */
		getBashModeBorderColor: () => (text) => String(text),
	};

	/** 对话框被超时、中止或页面断开时的默认返回值（与 pi 的 RPC 模式一致）。 */
	function uiDefault(method) {
		return method === 'confirm' ? false : undefined;
	}

	/** 生成一个对话框 id。 */
	function newUIId() {
		uiSeq += 1;
		return `ui-${uiSeq.toString(36)}-${Date.now().toString(36)}`;
	}

	/** 结束一个挂起的对话框：清掉计时与中止监听，把结果交回插件，并让页面关掉它。 */
	function settleUI(id, value) {
		const entry = pendingUI.get(id);
		if (!entry) return false;
		pendingUI.delete(id);
		if (entry.timer) clearTimeout(entry.timer);
		if (entry.onAbort) entry.signal?.removeEventListener('abort', entry.onAbort);
		broadcast({ kind: 'ui', phase: 'resolved', id });
		entry.resolve(value);
		return true;
	}

	/** 把所有挂起对话框按默认值收尾（页面全断开、进程退出时用）。 */
	function settleAllUI() {
		for (const [id, entry] of [...pendingUI]) settleUI(id, uiDefault(entry.method));
	}

	/** 没有页面接上时启动收尾计时（每次新的等待都重新计时）；有页面接上就取消。 */
	function scheduleUIGrace() {
		if (uiGraceTimer) clearTimeout(uiGraceTimer);
		uiGraceTimer = setTimeout(() => {
			uiGraceTimer = null;
			settleAllUI();
		}, UI_DISCONNECT_GRACE_MS);
	}

	/** 有页面接上：取消收尾计时。 */
	function cancelUIGrace() {
		if (!uiGraceTimer) return;
		clearTimeout(uiGraceTimer);
		uiGraceTimer = null;
	}

	/** 广播一帧单向的插件界面更新（通知、状态、部件、标题、输入框），不需要页面回答。 */
	function pushUI(frame) {
		if (frame.phase === 'notice') {
			// 扩展可能在循环里反复通知同一件事，短时间内的重复只发第一条
			const key = `${frame.level}|${frame.message}`;
			const now = Date.now();
			if (key === lastNotice.key && now - lastNotice.at < UI_NOTICE_DEDUPE_MS) return;
			lastNotice = { key, at: now };
		}
		broadcast({ kind: 'ui', ...frame });
	}

	/**
	 * setTitle 的尾随去抖：只在标题停止变化 800ms 后才发一帧。
	 * 动画标题（例如 Orca 的标题栏 spinner）因此完全不产生帧，而静态标题（会话名、目录名）照常显示。
	 */
	function pushTitle(title) {
		uiPendingTitle = String(title ?? '');
		if (uiTitleTimer) clearTimeout(uiTitleTimer);
		uiTitleTimer = setTimeout(() => {
			uiTitleTimer = null;
			pushUI({ phase: 'title', title: uiPendingTitle });
		}, UI_TITLE_DEBOUNCE_MS);
	}

	/** 立刻补发挂着的标题（换会话前调用，否则那一帧会被丢掉）。 */
	function flushTitle() {
		if (!uiTitleTimer) return;
		clearTimeout(uiTitleTimer);
		uiTitleTimer = null;
		pushUI({ phase: 'title', title: uiPendingTitle });
	}

	/**
	 * 请求页面回答一个对话框（select / confirm / input / editor）。
	 * 没有任何页面能回答时不会当场返回默认值，而是走同一套宽限（见 scheduleUIGrace），
	 * 这样启动阶段（boot 发生在 listen 之前）插件的提问也有机会等到人。
	 */
	function askUI(method, payload, opts) {
		const fallback = uiDefault(method);
		const id = newUIId();
		const request = {
			kind: 'ui',
			phase: 'ask',
			id,
			method,
			...payload,
			timeout: Number.isFinite(opts?.timeout) ? opts.timeout : null,
		};
		// 页面还没接上：先等一段时间，而不是让插件当场拿到默认值
		if (getClientCount() === 0) scheduleUIGrace();
		return new Promise((resolve) => {
			// 已经中止了就别登记，直接给默认值
			if (opts?.signal?.aborted) {
				resolve(fallback);
				return;
			}
			const entry = { resolve, method, request, signal: opts?.signal, timer: null, onAbort: null };
			// 插件自己的超时优先，但不会超过总上限
			const pluginTimeout = Number.isFinite(opts?.timeout) && opts.timeout > 0 ? opts.timeout : 0;
			entry.timer = setTimeout(
				() => settleUI(id, fallback),
				pluginTimeout ? Math.min(pluginTimeout, UI_ANSWER_TIMEOUT_MS) : UI_ANSWER_TIMEOUT_MS,
			);
			if (opts?.signal) {
				entry.onAbort = () => settleUI(id, fallback);
				opts.signal.addEventListener('abort', entry.onAbort, { once: true });
			}
			pendingUI.set(id, entry);
			broadcast(request);
		});
	}

	/**
	 * 给插件的 UI 上下文：只实现能真的搬到页面上的部分。
	 * 不支持的那部分（TUI 组件工厂、自定义底部栏/头栏、主题切换、自定义编辑器）保持空实现，
	 * 与 pi 的 RPC 模式一致：插件据此走降级路径，而不是以为有真终端、把命令卡在一个永远不会被调用的回调上。
	 */
	function createExtensionUIContext() {
		return {
			/** 请求页面选择一项，取消时返回 undefined。 */
			select: (title, options, opts) => askUI('select', { title, options: (options ?? []).map(String) }, opts),
			/** 请求页面确认，取消或超时返回 false。 */
			confirm: (title, message, opts) => askUI('confirm', { title, message }, opts),
			/** 请求单行文本，取消时返回 undefined。 */
			input: (title, placeholder, opts) => askUI('input', { title, placeholder }, opts),
			/** 请求多行编辑，保留插件提供的预填正文。 */
			editor: (title, prefill, opts) => askUI('editor', { title, prefill }, opts),
			/** 将插件通知转换为页面状态行。 */
			notify: (message, type) =>
				pushUI({ phase: 'notice', level: type === 'warning' || type === 'error' ? type : 'info', message: String(message ?? '') }),
			// 页面里的输入框只接受完整文本，不支持逐键拦截
			onTerminalInput: () => () => {},
			/** 按 key 更新页面状态槽，过滤配置要求隐藏的状态。 */
			setStatus: (key, text) => {
				if (HIDDEN_STATUS_KEYS.has(String(key).trim().toLowerCase())) return;
				pushUI({ phase: 'status', key: String(key), text: text === undefined ? null : String(text) });
			},
			/** 网页不接管终端工作提示文案。 */
			setWorkingMessage: () => {},
			/** 网页运行状态由会话事件维护。 */
			setWorkingVisible: () => {},
			/** 网页不渲染终端工作指示器。 */
			setWorkingIndicator: () => {},
			/** 思考块标题由网页渲染器维护。 */
			setHiddenThinkingLabel: () => {},
			/** 只桥接字符串数组部件，不调用终端组件工厂。 */
			setWidget: (key, content, options) => {
				// 组件工厂要真终端才能渲染，这里只支持字符串数组（与 pi 的 RPC 模式一致）
				if (content !== undefined && !Array.isArray(content)) return;
				pushUI({
					phase: 'widget',
					key: String(key),
					lines: content ?? null,
					placement: options?.placement === 'belowEditor' ? 'belowEditor' : 'aboveEditor',
				});
			},
			/** 网页没有可替换的终端底栏。 */
			setFooter: () => {},
			/** 网页没有可替换的终端头栏。 */
			setHeader: () => {},
			/** 合并高频标题变化后更新页面标题。 */
			setTitle: (title) => pushTitle(title),
			// 页面里没有 TUI 覆盖层：返回 undefined，让插件走 select / input 降级路径
			custom: async () => undefined,
			/** 保留原有整段替换语义，不模拟终端粘贴按键。 */
			pasteToEditor: (text) => pushUI({ phase: 'editor', text: String(text ?? '') }),
			/** 请求页面写入编辑器正文。 */
			setEditorText: (text) => pushUI({ phase: 'editor', text: String(text ?? '') }),
			/** 服务端不镜像页面草稿，保留空字符串降级返回。 */
			getEditorText: () => '',
			/** 网页补全固定由编辑器模块维护。 */
			addAutocompleteProvider: () => {},
			/** 网页不安装终端自定义编辑器。 */
			setEditorComponent: () => {},
			/** 没有终端编辑器组件可返回。 */
			getEditorComponent: () => undefined,
			/** 返回不生成终端转义序列的占位主题。 */
			get theme() {
				return plainTheme;
			},
			/** 网页没有插件可枚举的终端主题。 */
			getAllThemes: () => [],
			/** 网页不提供按名称查找终端主题。 */
			getTheme: () => undefined,
			/** 显式拒绝插件主题切换，不影响页面自身主题。 */
			setTheme: () => ({ success: false, error: 'pigui 页面不支持切换插件主题' }),
			/** 工具展开态仅在页面保存，终端 API 返回默认值。 */
			getToolsExpanded: () => false,
			/** 网页不接受终端工具展开态控制。 */
			setToolsExpanded: () => {},
		};
	}

	/** 页面重连时把还在等回答的对话框重发一遍，否则刷新之后就没法回答它了。 */
	function resendPendingUI(res) {
		for (const entry of pendingUI.values()) {
			try {
				res.write(`data: ${JSON.stringify(entry.request)}\n\n`);
			} catch {}
		}
	}

	/** 处理页面回答，先到的有效回答生效，保留原有状态码与取消语义。 */
	function respond(body) {
		const id = typeof body?.id === 'string' ? body.id : '';
		if (!id) return { status: 400, body: { error: '缺少对话框 id' } };
		const entry = pendingUI.get(id);
		if (!entry) return { status: 404, body: { error: '该对话框已结束或不存在' } };
		if (body?.cancelled === true) settleUI(id, uiDefault(entry.method));
		else if (typeof body?.confirmed === 'boolean') settleUI(id, body.confirmed);
		else if (typeof body?.value === 'string') settleUI(id, body.value);
		else settleUI(id, uiDefault(entry.method));
		return { status: 200, body: { ok: true } };
	}

	/** 关闭全部等待请求和定时器，确保插件 Promise 不悬挂。 */
	function close() {
		settleAllUI();
		cancelUIGrace();
		if (uiTitleTimer) clearTimeout(uiTitleTimer);
		uiTitleTimer = null;
	}

	return { settleAllUI, scheduleUIGrace, cancelUIGrace, pushUI, flushTitle, createExtensionUIContext, resendPendingUI, respond, close };
}
