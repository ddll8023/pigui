/** 会话选择、新建与回退 */
import { apiPath } from './conversation.mjs';
import { enterSheet, leaveSheet, bindSheetKeys } from './sheets.mjs';

/** 创建会话选择、新建与回退；状态仅在实例内维护。 */
export function createSessions({ addStatusRow, clearMessages, setEditorText, isBusy }) {
	const messagesEl = document.getElementById('messages');
	const overlayEl = document.getElementById('overlay');
	const pickerListEl = document.getElementById('pickerList');
	const pickerCloseEl = document.getElementById('pickerClose');
	const rewindCloseEl = document.getElementById('rewindClose');
	const rewindOverlayEl = document.getElementById('rewindOverlay');
	const rewindListEl = document.getElementById('rewindList');

	/** 当前会话文件路径（用于在选择器里标记当前项）。 */
	let currentSessionPath = '';

	/** 会话选择器（/resume）状态。 */
	let pickerOpen = false;

	let pickerItems = [];

	let pickerIndex = 0;

	/** 回退浮层（/rewind）状态。 */
	let rewindOpen = false;

	let rewindItems = [];

	let rewindIndex = 0;

	/** 归一化路径，用于判断两个会话是否同一个文件。 */
	function samePath(a, b) {
		return (
			String(a || '').replace(/\\/g, '/').toLowerCase() ===
			String(b || '').replace(/\\/g, '/').toLowerCase()
		);
	}

	/** 会话时间的短格式：今天只显示时分，其它显示月-日 时分。 */
	function shortTime(value) {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return '';
		/** 将日期和时间字段补齐两位。 */
		const pad = (n) => String(n).padStart(2, '0');
		const clock = pad(date.getHours()) + ':' + pad(date.getMinutes());
		const sameDay = date.toDateString() === new Date().toDateString();
		return sameDay ? clock : pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + clock;
	}

	/** 会话列表按修改时间分组：今天 / 昨天 / 更早。 */
	function sessionGroupOf(value) {
		const at = new Date(value || 0).getTime();
		if (!Number.isFinite(at)) return '更早';
		const now = new Date();
		const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
		if (at >= todayStart) return '今天';
		if (at >= todayStart - 86400000) return '昨天';
		return '更早';
	}

	/** 渲染会话选择器：两行式条目（标题 + 时间/条数），并按时间分组。 */
	function renderPicker(message) {
		pickerListEl.replaceChildren();
		/** 在会话列表中显示加载、空态或失败提示。 */
		const plain = (text) => {
			const item = document.createElement('li');
			item.className = 'picker-item plain';
			item.textContent = text;
			pickerListEl.append(item);
		};
		if (message) return plain(message);
		if (!pickerItems.length) return plain('这个目录还没有历史会话');
		let group = '';
		pickerItems.forEach((info, index) => {
			const nextGroup = sessionGroupOf(info.modified);
			if (nextGroup !== group) {
				group = nextGroup;
				const head = document.createElement('li');
				head.className = 'picker-group';
				head.textContent = group;
				pickerListEl.append(head);
			}
			const item = document.createElement('li');
			item.className = 'picker-item two-line';
			item.dataset.index = String(index);
			item.dataset.active = String(index === pickerIndex);
			const mark = document.createElement('span');
			mark.className = 'mark';
			mark.textContent = samePath(info.path, currentSessionPath) ? '●' : '';
			const main = document.createElement('span');
			main.className = 'main';
			const title = document.createElement('span');
			title.className = 'title';
			title.textContent = String(info.name || info.firstMessage || info.id || '(空会话)').slice(0, 120);
			title.title = title.textContent;
			const meta = document.createElement('span');
			meta.className = 'meta';
			meta.textContent = shortTime(info.modified) + ' · ' + (info.messageCount || 0) + ' 条';
			main.append(title, meta);
			item.append(mark, main);
			item.addEventListener('click', () => void switchSession(info.path));
			pickerListEl.append(item);
		});
		// 列表里插了分组标题，不能按下标取 child，按 data-index 找
		const active = pickerListEl.querySelector('.picker-item[data-index="' + pickerIndex + '"]');
		if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
	}

	/** 打开会话选择器（输入 /resume 触发）。 */
	async function openSessionPicker() {
		pickerOpen = true;
		overlayEl.hidden = false;
		enterSheet(overlayEl);
		pickerItems = [];
		pickerIndex = 0;
		renderPicker('正在读取会话列表…');
		let sessions = [];
		try {
			const response = await fetch('/api/sessions');
			const data = await response.json();
			sessions = Array.isArray(data.sessions) ? data.sessions : [];
		} catch {
			renderPicker('读取会话列表失败');
			return;
		}
		sessions.sort((a, b) => new Date(b.modified || 0) - new Date(a.modified || 0));
		pickerItems = sessions;
		const at = sessions.findIndex((info) => samePath(info.path, currentSessionPath));
		pickerIndex = at >= 0 ? at : 0;
		renderPicker();
	}

	/** 关闭会话选择器。 */
	function closeSessionPicker() {
		pickerOpen = false;
		overlayEl.hidden = true;
		leaveSheet(overlayEl);
	}

	/** 上下键移动高亮。 */
	function movePicker(delta) {
		if (!pickerItems.length) return;
		pickerIndex = (pickerIndex + delta + pickerItems.length) % pickerItems.length;
		renderPicker();
	}

	/** 切换到指定会话（服务端把历史发给本对话的页面，页面自动重放）。 */
	async function switchSession(sessionFile) {
		if (!sessionFile) return;
		if (samePath(sessionFile, currentSessionPath)) {
			closeSessionPicker();
			return;
		}
		// 不论成功还是失败都要收起浮层，否则遮罩会一直盖住页面
		try {
			const response = await fetch(apiPath('/api/switch'), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ sessionFile }),
			});
			if (!response.ok) {
				addStatusRow('切换会话失败（HTTP ' + response.status + '）', 'error');
			}
		} catch (err) {
			addStatusRow('切换会话失败：' + String((err && err.message) || err), 'error');
		} finally {
			closeSessionPicker();
		}
	}

	/** 在当前页签新建会话（/new 命令与命令提示条共用；顶栏按钮改为开新页签）。 */
	async function newSession() {
		await fetch(apiPath('/api/new'), { method: 'POST' }).catch(() => {});
		clearMessages();
		addStatusRow('已开始新会话');
	}

	/** 在新页签里开一个新对话；新页签没有 ?c=，由页面自己新建一个会话。 */
	function openNewConversation() {
		window.open('/', '_blank');
	}

	/** 收集可回退的用户提问：只取有会话条目 id 的行；本地回显尚未拿到 id、或旧版本 SDK 不给 id 时不参与。 */
	function collectRewindItems() {
		const rows = [...messagesEl.querySelectorAll('.row.user[data-entry-id]')];
		return rows.map((row, index) => ({
			row,
			entryId: row.dataset.entryId,
			idx: row.querySelector('.idx') ? row.querySelector('.idx').textContent : '',
			// 回退到这条之前，后面这些提问都会被移出上下文
			after: rows.length - index - 1,
			text:
				String(row.querySelector('.body') ? row.querySelector('.body').textContent : '')
					.replace(/\s+/g, ' ')
					.trim()
					.slice(0, 90) || '(空)',
		}));
	}

	/** 渲染回退列表。 */
	function renderRewind(message) {
		rewindListEl.replaceChildren();
		/** 在回退列表中显示无可用提问提示。 */
		const plain = (text) => {
			const item = document.createElement('li');
			item.className = 'picker-item plain';
			item.textContent = text;
			rewindListEl.append(item);
		};
		if (message) return plain(message);
		if (!rewindItems.length) return plain('这个会话还没有可以回退的提问');
		rewindItems.forEach((item, index) => {
			const li = document.createElement('li');
			li.className = 'picker-item two-line';
			li.dataset.active = String(index === rewindIndex);
			const mark = document.createElement('span');
			mark.className = 'mark idx';
			mark.textContent = item.idx;
			const main = document.createElement('span');
			main.className = 'main';
			const title = document.createElement('span');
			title.className = 'title clamp-2';
			title.textContent = item.text;
			const meta = document.createElement('span');
			meta.className = 'meta';
			meta.textContent =
				'第 ' + (index + 1) + ' 条' + (item.after > 0 ? ' · 之后还有 ' + item.after + ' 条提问' : ' · 最后一条');
			main.append(title, meta);
			li.append(mark, main);
			li.addEventListener('click', () => void confirmRewind(item));
			rewindListEl.append(li);
		});
		const active = rewindListEl.children[rewindIndex];
		if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
	}

	/** 打开回退浮层（/rewind 触发）；默认高亮最近一条提问，回合运行中不允许回退。 */
	function openRewind() {
		if (isBusy()) {
			addStatusRow('回合运行中，先点「中止」再回退', 'error');
			return;
		}
		rewindItems = collectRewindItems();
		rewindIndex = rewindItems.length ? rewindItems.length - 1 : 0;
		rewindOpen = true;
		rewindOverlayEl.hidden = false;
		enterSheet(rewindOverlayEl);
		renderRewind();
	}

	/** 关闭回退浮层，把焦点还给打开它的地方。 */
	function closeRewind() {
		if (!rewindOpen) return;
		rewindOpen = false;
		rewindOverlayEl.hidden = true;
		leaveSheet(rewindOverlayEl);
	}

	/** 上下键移动回退高亮。 */
	function moveRewind(delta) {
		if (!rewindItems.length) return;
		rewindIndex = (rewindIndex + delta + rewindItems.length) % rewindItems.length;
		renderRewind();
	}

	/** 执行回退：服务端移动会话叶子并把历史发给本对话的页面，原提问文本回到输入框供编辑重发。 */
	async function confirmRewind(item) {
		if (!item || !item.entryId) return;
		try {
			const response = await fetch(apiPath('/api/rewind'), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ entryId: item.entryId }),
			});
			const data = await response.json().catch(() => ({}));
			if (!response.ok) {
				addStatusRow('回退失败：' + (data.error || 'HTTP ' + response.status), 'error');
				return;
			}
			closeRewind();
			setEditorText(String(data.editorText || ''), { caret: true });
			addStatusRow('已回退到该提问之前，原消息已放回输入框');
		} catch (err) {
			addStatusRow('回退失败：' + String((err && err.message) || err), 'error');
		}
	}

	/** 同步选择器的当前会话标记，不改会话内容。 */
	function setContext(context) { currentSessionPath = context.sessionFile || ''; }

	/** 会话选择器打开时命令补全应收起。 */
	function isPickerOpen() { return pickerOpen; }

	/** 会话或回退浮层打开时文件补全应让位。 */
	function isOpen() { return pickerOpen || rewindOpen; }

	/** 保留输入框对会话选择器和回退浮层的键位优先级。 */
	function handleInputKey(event) {
		if (pickerOpen) {
			if (event.key === 'Escape') { event.preventDefault(); closeSessionPicker(); }
			else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault(); movePicker(event.key === 'ArrowDown' ? 1 : -1);
			} else if (event.key === 'Enter') {
				event.preventDefault();
				const info = pickerItems[pickerIndex];
				if (info) void switchSession(info.path);
			}
			return true;
		}
		if (!rewindOpen) return false;
		if (event.key === 'Escape') { event.preventDefault(); closeRewind(); }
		else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault(); moveRewind(event.key === 'ArrowDown' ? 1 : -1);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			const item = rewindItems[rewindIndex];
			if (item) void confirmRewind(item);
		}
		return true;
	}

	/** 注册会话和回退浮层，以及顶栏新对话（开新页签）操作。 */
	function init() {
		pickerCloseEl.addEventListener('click', closeSessionPicker);
		rewindCloseEl.addEventListener('click', closeRewind);
		overlayEl.addEventListener('click', (event) => { if (event.target === overlayEl) closeSessionPicker(); });
		rewindOverlayEl.addEventListener('click', (event) => { if (event.target === rewindOverlayEl) closeRewind(); });
		document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && pickerOpen) closeSessionPicker(); });
		document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && rewindOpen) closeRewind(); });
		bindSheetKeys(overlayEl, movePicker, () => {
			const info = pickerItems[pickerIndex];
			if (info) void switchSession(info.path);
		});
		bindSheetKeys(rewindOverlayEl, moveRewind, () => {
			const item = rewindItems[rewindIndex];
			if (item) void confirmRewind(item);
		});
		document.getElementById('new').addEventListener('click', openNewConversation);
	}

	return { init, setContext, isPickerOpen, isOpen, handleInputKey, openSessionPicker, openRewind, newSession, openNewConversation };
}
