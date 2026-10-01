/** 插件页面交互 */
import { enterSheet, leaveSheet, bindSheetKeys } from './sheets.mjs';

/** 创建插件页面交互；状态由实例自己维护。 */
export function createPlugins({ addStatusRow, setEditorText }) {
	const inputEl = document.getElementById('input');
	const uiCloseEl = document.getElementById('uiClose');
	const uiOverlayEl = document.getElementById('uiOverlay');
	const uiTitleEl = document.getElementById('uiTitle');
	const uiKeyEl = document.getElementById('uiKey');
	const uiMessageEl = document.getElementById('uiMessage');
	const uiListEl = document.getElementById('uiList');
	const uiInputEl = document.getElementById('uiInput');
	const uiEditorEl = document.getElementById('uiEditor');
	const uiFootEl = document.getElementById('uiFoot');
	const pluginStatusEl = document.getElementById('pluginStatus');
	const widgetAboveEl = document.getElementById('widgetAbove');
	const widgetBelowEl = document.getElementById('widgetBelow');

	/** 插件对话框队列（扩展的 select / confirm / input / editor 会阻塞等待页面回答）。 */
	let uiQueue = [];

	let uiActive = null;

	let uiIndex = 0;

	let uiTimeoutTimer = 0;

	let uiDeadline = 0;

	/** 插件状态槽与部件：按 key 覆盖，空值删除（由插件自己维护生命周期）。 */
	const pluginStatus = new Map();

	const pluginWidgets = new Map();

	/** 插件加载情况的提示签名，避免每次 session 帧重复刷屏。 */
	let pluginNoticeKey = '';

	/** 状态栏里的插件状态是否显示；由设置浮层下推，默认显示。 */
	let showPluginStatus = true;

	/** 页面原始标题（插件改过标题后用于还原）。 */
	const defaultTitle = document.title;

	/** 插件界面帧：重置、对话框、通知、状态、部件、标题、写入输入框。 */
	function handleUIFrame(frame) {
		const phase = frame.phase;
		if (phase === 'reset') {
			uiQueue = [];
			hideUI();
			pluginStatus.clear();
			pluginWidgets.clear();
			paintPluginStatus();
			paintPluginWidgets();
			pluginNoticeKey = '';
			document.title = defaultTitle;
			return;
		}
		if (phase === 'ask') {
			// 重连时服务端会把未决对话框重发一遍，同一个 id 只留一份
			if (uiQueue.some((item) => item.id === frame.id)) return;
			uiQueue.push(frame);
			if (!uiActive) showNextUI();
			return;
		}
		if (phase === 'resolved') {
			uiQueue = uiQueue.filter((item) => item.id !== frame.id);
			if (uiActive && uiActive.id === frame.id) {
				hideUI();
				showNextUI();
			}
			return;
		}
		if (phase === 'notice') {
			const kind = frame.level === 'error' ? 'error' : frame.level === 'warning' ? 'warn' : undefined;
			if (frame.message) addStatusRow(frame.message, kind);
			return;
		}
		if (phase === 'status') {
			if (frame.text === null || frame.text === undefined) pluginStatus.delete(frame.key);
			else pluginStatus.set(frame.key, String(frame.text));
			paintPluginStatus();
			return;
		}
		if (phase === 'widget') {
			if (Array.isArray(frame.lines) && frame.lines.length) {
				pluginWidgets.set(frame.key, { lines: frame.lines, placement: frame.placement });
			} else {
				pluginWidgets.delete(frame.key);
			}
			paintPluginWidgets();
			return;
		}
		if (phase === 'title') {
			document.title = frame.title ? `${frame.title} · pigui` : defaultTitle;
			return;
		}
		if (phase === 'editor') {
			setEditorText(String(frame.text || ''));
		}
	}

	/** 重画插件状态槽（在输入区下方，多个键并排）；没内容或被设置关掉时整块隐藏。 */
	function paintPluginStatus() {
		pluginStatusEl.replaceChildren();
		for (const [key, text] of pluginStatus) {
			const span = document.createElement('span');
			span.className = 'item';
			span.textContent = text;
			span.title = `${key}: ${text}`;
			pluginStatusEl.append(span);
		}
		pluginStatusEl.hidden = pluginStatus.size === 0 || !showPluginStatus;
	}

	/** 应用设置里的状态栏开关；插件状态仍继续缓存，只是不画出来。 */
	function setStatusBarVisibility(next) {
		const nextShown = !next || next.plugin !== false;
		if (nextShown === showPluginStatus) return;
		showPluginStatus = nextShown;
		paintPluginStatus();
	}

	/** 重画插件部件（setWidget 的字符串数组）；按 placement 放到输入区上方或下方。 */
	function paintPluginWidgets() {
		const above = [];
		const below = [];
		for (const [key, item] of pluginWidgets) (item.placement === 'belowEditor' ? below : above).push([key, item]);
		for (const [el, list] of [
			[widgetAboveEl, above],
			[widgetBelowEl, below],
		]) {
			el.replaceChildren();
			for (const [key, item] of list) {
				const block = document.createElement('div');
				// 插件可能已经给文本上过 ANSI 颜色，页面里直接显示转义序列，这里剥掉
				block.textContent = item.lines.join('\n').replace(/\u001b\[[0-9;]*m/g, '');
				block.title = key;
				el.append(block);
			}
			el.hidden = list.length === 0;
		}
	}

	/** 关闭当前对话框（本地收尾；不代表已经回答）。 */
	function hideUI() {
		uiActive = null;
		uiIndex = 0;
		if (uiTimeoutTimer) {
			clearInterval(uiTimeoutTimer);
			uiTimeoutTimer = 0;
		}
		uiOverlayEl.hidden = true;
		leaveSheet(uiOverlayEl);
	}

	/** 弹出队首对话框；队列空了就把焦点还给输入框。 */
	function showNextUI() {
		uiActive = uiQueue[0] || null;
		if (!uiActive) {
			hideUI();
			inputEl.focus();
			return;
		}
		renderUI();
	}

	/** 渲染当前对话框：列表选择 / 确认 / 单行输入 / 多行编辑。 */
	function renderUI() {
		const item = uiActive;
		const isList = item.method === 'select' || item.method === 'confirm';
		uiOverlayEl.hidden = false;
		// 记下来源焦点与栈；具体把焦点放哪个控件由下面按 method 决定
		enterSheet(uiOverlayEl);
		uiTitleEl.textContent =
			{ input: '插件提问', select: '插件选择', confirm: '插件确认', editor: '插件编辑' }[item.method] || '插件请求';
		// 完整提问可能连同编号说明放在 title 中，移到正文展示，不截断内容。
		const message = [item.title, item.message].filter(Boolean).join('\n\n');
		uiMessageEl.hidden = !message;
		uiMessageEl.textContent = message;
		uiListEl.hidden = !isList;
		uiInputEl.hidden = item.method !== 'input';
		uiEditorEl.hidden = item.method !== 'editor';
		uiIndex = 0;
		if (isList) {
			// 确认对话当成两项列表（确认 / 取消），键位与选择一致
			const options = item.method === 'confirm' ? ['确认', '取消'] : item.options || [];
			uiListEl.replaceChildren();
			options.forEach((option, index) => {
				const li = document.createElement('li');
				li.className =
					'picker-item two-line' + (item.method === 'confirm' && index === 0 ? ' confirm-primary' : '');
				li.dataset.active = String(index === 0);
				const mark = document.createElement('span');
				mark.className = 'mark idx';
				mark.textContent = String(index + 1);
				const main = document.createElement('span');
				main.className = 'main';
				const title = document.createElement('span');
				// 选项常带一句说明，select 允许换行（confirm 只有“确认 / 取消”，保持单行）
				title.className = item.method === 'select' ? 'title clamp-3' : 'title';
				title.textContent = String(option);
				title.title = String(option);
				main.append(title);
				li.append(mark, main);
				li.addEventListener('click', () => answerUIList(index));
				uiListEl.append(li);
			});
			// 没有选项可选的 select 直接把选择框收起来，只能 Esc 取消
			uiListEl.hidden = options.length === 0;
			if (options.length) uiListEl.focus();
		} else if (item.method === 'input') {
			uiInputEl.value = '';
			uiInputEl.placeholder = item.placeholder || '';
			uiInputEl.focus();
		} else {
			uiEditorEl.value = item.prefill || '';
			uiEditorEl.focus();
		}
		uiKeyEl.textContent =
			item.method === 'select'
				? '↑↓ 选择 · Enter 确认 · Esc 取消'
				: item.method === 'confirm'
					? 'Enter 确认 · Esc 取消'
					: item.method === 'editor'
						? 'Ctrl+Enter 提交 · Esc 取消'
						: 'Enter 提交 · Esc 取消';
		uiFootEl.textContent = '由插件发起：回答会直接交回该插件，超时或关闭页面会按默认值处理';
		startUITimeout(item);
	}

	/** 列表选项被选中：select 回选项文本，confirm 回布尔。 */
	function answerUIList(index) {
		const item = uiActive;
		if (!item) return;
		if (item.method === 'confirm') return answerUI(item, { confirmed: index === 0 });
		return answerUI(item, { value: String((item.options || [])[index] ?? '') });
	}

	/** 上下键移动列表高亮。 */
	function moveUI(delta) {
		const item = uiActive;
		if (!item || (item.method !== 'select' && item.method !== 'confirm')) return;
		const count = uiListEl.children.length;
		if (!count) return;
		uiIndex = (uiIndex + delta + count) % count;
		[...uiListEl.children].forEach((li, index) => {
			li.dataset.active = String(index === uiIndex);
		});
		const active = uiListEl.children[uiIndex];
		if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
	}

	/** 回答或取消当前对话框：先本地收尾，再上报服务端（失败也不把队列卡住）。 */
	function answerUI(item, response) {
		if (!item) return;
		uiQueue = uiQueue.filter((entry) => entry.id !== item.id);
		hideUI();
		showNextUI();
		void fetch('/api/ui-response', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id: item.id, ...response }),
		}).catch(() => addStatusRow('插件对话框回答发送失败：本地服务没有响应', 'error'));
	}

	/** 超时倒计时：到点时服务端会按默认值收尾，这里只把剩余时间显示出来。 */
	function startUITimeout(item) {
		if (uiTimeoutTimer) {
			clearInterval(uiTimeoutTimer);
			uiTimeoutTimer = 0;
		}
		if (!Number.isFinite(item.timeout) || item.timeout <= 0) return;
		const total = item.timeout;
		uiDeadline = Date.now() + total;
		// foot 换成“进度条 + 文字”，倒计时长短一眼可见
		uiFootEl.replaceChildren();
		const wrap = document.createElement('div');
		wrap.className = 'ui-timeout';
		const track = document.createElement('span');
		track.className = 'ui-timeout-track';
		const fill = document.createElement('span');
		fill.className = 'ui-timeout-fill';
		track.append(fill);
		const text = document.createElement('span');
		wrap.append(track, text);
		uiFootEl.append(wrap);
		/** 刷新剩余秒数与进度条，到点停表但不替服务端回答。 */
		const tick = () => {
			const leftMs = Math.max(0, uiDeadline - Date.now());
			const left = Math.ceil(leftMs / 1000);
			fill.style.width = Math.max(0, Math.min(100, (leftMs / total) * 100)) + '%';
			text.textContent = `还有 ${left}s 将按默认值处理（${item.method === 'confirm' ? '取消' : '不选择'}）`;
			if (left <= 0) {
				clearInterval(uiTimeoutTimer);
				uiTimeoutTimer = 0;
			}
		};
		uiTimeoutTimer = setInterval(tick, 1000);
		tick();
	}

	/** 插件加载情况只提示一次，签名变化（换会话后结果不同）才重新提示。 */
	function noticePlugins(context) {
		const key = `${context.pluginUi}|${(context.pluginErrors || []).map((item) => item.path).join(',')}`;
		if (key === pluginNoticeKey) return;
		pluginNoticeKey = key;
		if (context.pluginUi === false) addStatusRow('插件界面不可用（已用 --no-plugin-ui 关闭，或 pi SDK 版本过旧）：插件里的确认框与选择菜单不会出现', 'warn');
		for (const item of context.pluginErrors || []) addStatusRow(`插件加载失败：${item.path || '(未知)'} — ${item.error || ''}`, 'error');
	}

	/** 插件对话框打开时文件补全应让位。 */
	function isOpen() { return Boolean(uiActive); }

	/** 初始化回答键位；遮罩点击不取消插件请求。 */
	function init() {
		uiCloseEl.addEventListener('click', () => answerUI(uiActive, { cancelled: true }));
		bindSheetKeys(uiOverlayEl, moveUI, () => {
			const item = uiActive;
			if (!item) return;
			if (item.method === 'select' || item.method === 'confirm') answerUIList(uiIndex);
			else if (item.method === 'input') answerUI(item, { value: uiInputEl.value });
			else answerUI(item, { value: uiEditorEl.value });
		});
		uiListEl.addEventListener('keydown', (event) => {
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault(); moveUI(event.key === 'ArrowDown' ? 1 : -1);
			} else if (event.key === 'Enter') { event.preventDefault(); answerUIList(uiIndex); }
			else if (event.key === 'Escape') { event.preventDefault(); answerUI(uiActive, { cancelled: true }); }
		});
		uiInputEl.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' && !event.shiftKey) {
				event.preventDefault(); answerUI(uiActive, { value: uiInputEl.value });
			} else if (event.key === 'Escape') { event.preventDefault(); answerUI(uiActive, { cancelled: true }); }
		});
		uiEditorEl.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
				event.preventDefault(); answerUI(uiActive, { value: uiEditorEl.value });
			} else if (event.key === 'Escape') { event.preventDefault(); answerUI(uiActive, { cancelled: true }); }
		});
	}

	return { init, isOpen, handleUIFrame, noticePlugins, setStatusBarVisibility };
}
