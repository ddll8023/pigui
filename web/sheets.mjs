/** 浮层焦点、列表键位与共享标签；不拥有业务浮层状态。 */
const inputEl = document.getElementById('input');

/** 可聚焦元素（Tab 圈定用）。 */
const FOCUSABLE =
	'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** 当前打开的纸面浮层：{ overlay, restore }，用于 Tab 圈定与关闭后还焦点。 */
let sheetStack = [];

/** 小标签胶囊；when 为假时返回 null，方便和别的节点一起 append 时过滤。 */
export function chip(text, when = true, extraClass = '') {
	if (!when) return null;
	const node = document.createElement('span');
	node.className = 'chip' + (extraClass ? ' ' + extraClass : '');
	node.textContent = text;
	return node;
}

/** 打开浮层：记下来源焦点并把焦点移进去（没有可聚焦控件时落在容器上）。 */
export function enterSheet(overlayEl, initialEl) {
	const picker = overlayEl && overlayEl.querySelector('.picker');
	if (!picker) return;
	if (!sheetStack.some((item) => item.overlay === overlayEl)) {
		sheetStack.push({ overlay: overlayEl, restore: document.activeElement });
	}
	const target = initialEl || picker.querySelector(FOCUSABLE) || picker;
	if (target && typeof target.focus === 'function') target.focus();
}

/** 关闭浮层：把焦点还给打开它的地方（拿不到就回输入框）。 */
export function leaveSheet(overlayEl) {
	const at = sheetStack.findIndex((item) => item.overlay === overlayEl);
	const entry = at >= 0 ? sheetStack.splice(at, 1)[0] : null;
	const restore = entry && entry.restore;
	if (restore && typeof restore.focus === 'function' && document.contains(restore)) {
		restore.focus();
		return;
	}
	inputEl.focus();
}

/** Tab 在浮层内循环，不让焦点跑到背后的页面。 */
function trapSheetTab(event) {
	const overlayEl = sheetStack.length ? sheetStack[sheetStack.length - 1].overlay : null;
	const picker = overlayEl && overlayEl.querySelector('.picker');
	if (!picker) return;
	// hidden 的控件 offsetParent 为 null，直接滤掉
	const items = [...picker.querySelectorAll(FOCUSABLE)].filter(
		(item) => !item.hidden && item.offsetParent !== null,
	);
	if (!items.length) {
		event.preventDefault();
		picker.focus();
		return;
	}
	const first = items[0];
	const last = items[items.length - 1];
	const active = document.activeElement;
	if (event.shiftKey && (active === first || !picker.contains(active))) {
		event.preventDefault();
		last.focus();
		return;
	}
	if (!event.shiftKey && (active === last || !picker.contains(active))) {
		event.preventDefault();
		first.focus();
	}
}

/**
 * 把列表类浮层的键位挂到浮层自己身上。
 * 焦点被圈进浮层后，方向键/Enter 就不再到输入框上了，所以这些键得在浮层里再绑一遍；
 * 内部控件（模型搜索框、插件输入框等）已经处理过的按键用 defaultPrevented 跳过，避免重复触发。
 */
export function bindSheetKeys(overlayEl, onMove, onConfirm, onHorizontal) {
	overlayEl.addEventListener('keydown', (event) => {
		if (event.defaultPrevented) return;
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			onMove(event.key === 'ArrowDown' ? 1 : -1);
			return;
		}
		if (onHorizontal && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
			event.preventDefault();
			onHorizontal(event.key === 'ArrowRight' ? 1 : -1);
			return;
		}
		if (event.key === 'Enter') {
			event.preventDefault();
			onConfirm(event);
		}
	});
}

/** 页面启动时注册一次浮层 Tab 圈定。 */
export function initSheets() {
	// 只将 Tab 留在最上层浮层内部。
	document.addEventListener('keydown', (event) => {
		if (event.key === 'Tab' && sheetStack.length) trapSheetTab(event);
	});
}
