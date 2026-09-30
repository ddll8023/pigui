/** 消息目录与滚动导航 */
import { enterSheet, leaveSheet, bindSheetKeys, chip } from './sheets.mjs';

/** 创建消息目录与滚动导航；状态仅在实例内维护。 */
export function createNavigation() {
	const messagesEl = document.getElementById('messages');
	const navCloseEl = document.getElementById('navClose');
	const composerEl = document.getElementById('composer');
	const jumpsEl = document.getElementById('jumps');
	const jumpTopEl = document.getElementById('jumpTop');
	const jumpBottomEl = document.getElementById('jumpBottom');
	const navOverlayEl = document.getElementById('navOverlay');
	const navListEl = document.getElementById('navList');

	/** 消息目录（跳转）状态。 */
	let navOpen = false;

	let navItems = [];

	let navIndex = 0;

	/** 打开目录时当前可视区域最靠上的那条（只用于标记“当前位置”，不随方向键变）。 */
	let navViewportIndex = 0;

	/** 滚动节流的 rAF 句柄。 */
	let jumpFrame = 0;

	/** 收集导航节点：只收用户自己的消息，助手回复不进目录。 */
	function collectNavItems() {
		return [...messagesEl.querySelectorAll('.row.user')]
			.filter((row) => row.querySelector('.idx'))
			.map((row) => ({
				row,
				idx: row.querySelector('.idx').textContent,
				text:
					String(row.querySelector('.body') ? row.querySelector('.body').textContent : '')
						.replace(/\s+/g, ' ')
						.trim()
						.slice(0, 90) || '(空)',
			}));
	}

	/** 渲染目录列表。 */
	function renderNav(message) {
		navListEl.replaceChildren();
		/** 在目录中显示没有消息时的空态提示。 */
		const plain = (text) => {
			const item = document.createElement('li');
			item.className = 'picker-item plain';
			item.textContent = text;
			navListEl.append(item);
		};
		if (message) return plain(message);
		if (!navItems.length) return plain('这个会话还没有消息');
		navItems.forEach((item, index) => {
			const li = document.createElement('li');
			li.className = 'picker-item two-line';
			li.dataset.active = String(index === navIndex);
			li.dataset.viewport = String(index === navViewportIndex);
			const mark = document.createElement('span');
			mark.className = 'mark idx';
			mark.textContent = item.idx;
			const main = document.createElement('span');
			main.className = 'main';
			const title = document.createElement('span');
			title.className = 'title clamp-2';
			title.textContent = item.text;
			main.append(title);
			// 标一下打开目录时视图所在的位置，和方向键高亮是两回事
			if (index === navViewportIndex) {
				const meta = document.createElement('span');
				meta.className = 'meta';
				meta.append(chip('当前位置', true, 'accent'));
				main.append(meta);
			}
			li.append(mark, main);
			li.addEventListener('click', () => jumpToRow(item.row));
			navListEl.append(li);
		});
		const active = navListEl.children[navIndex];
		if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
	}

	/** 打开消息目录（默认高亮当前视口最靠上的那条）。 */
	function openNav() {
		navItems = collectNavItems();
		const top = messagesEl.scrollTop;
		const at = navItems.findIndex((item) => item.row.offsetTop >= top - 4);
		navViewportIndex = at >= 0 ? at : 0;
		navIndex = navViewportIndex;
		navOpen = true;
		navOverlayEl.hidden = false;
		enterSheet(navOverlayEl);
		renderNav();
	}

	/** 关闭消息目录。 */
	function closeNav() {
		navOpen = false;
		navOverlayEl.hidden = true;
		leaveSheet(navOverlayEl);
	}

	/** 上下键移动目录高亮。 */
	function moveNav(delta) {
		if (!navItems.length) return;
		navIndex = (navIndex + delta + navItems.length) % navItems.length;
		renderNav();
	}

	/** 跳到某条消息：滚到视口中间并闪一下。 */
	function jumpToRow(row) {
		if (!row) return;
		closeNav();
		row.scrollIntoView({ block: 'center', behavior: 'smooth' });
		row.classList.remove('flash');
		void row.offsetWidth; // 强制重排，让动画能重复触发
		row.classList.add('flash');
		setTimeout(() => row.classList.remove('flash'), 1600);
	}

	/** 根据滚动位置显隐跳转按钮。 */
	function syncJumpButtons() {
		const top = messagesEl.scrollTop;
		const max = messagesEl.scrollHeight - messagesEl.clientHeight;
		jumpTopEl.hidden = top < 240;
		jumpBottomEl.hidden = max - top < 80;
	}

	/** 跳转按钮容器跟随输入区高度，避免被长高的输入框盖住。 */
	function syncJumpPosition() {
		jumpsEl.style.bottom = composerEl.offsetHeight + 12 + 'px';
	}

	/** 输入框仍持焦点时，优先将目录键位交给已打开的目录。 */
	function handleInputKey(event) {
		if (!navOpen) return false;
		if (event.key === 'Escape') { event.preventDefault(); closeNav(); }
		else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault(); moveNav(event.key === 'ArrowDown' ? 1 : -1);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			const item = navItems[navIndex];
			if (item) jumpToRow(item.row);
		}
		return true;
	}

	/** 告知文件补全是否应让位给目录浮层。 */
	function isOpen() { return navOpen; }

	/** 注册目录和滚动操作；每个遮罩关闭事件只注册一次。 */
	function init() {
		document.getElementById('nav').addEventListener('click', () => (navOpen ? closeNav() : openNav()));
		navCloseEl.addEventListener('click', closeNav);
		navOverlayEl.addEventListener('click', (event) => {
			if (event.target === navOverlayEl) closeNav();
		});
		document.addEventListener('keydown', (event) => {
			if (event.key === 'Escape' && navOpen) closeNav();
		});
		bindSheetKeys(navOverlayEl, moveNav, () => {
			const item = navItems[navIndex];
			if (item) jumpToRow(item.row);
		});
		jumpTopEl.addEventListener('click', () => messagesEl.scrollTo({ top: 0, behavior: 'smooth' }));
		jumpBottomEl.addEventListener('click', () => messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' }));
		messagesEl.addEventListener('scroll', () => {
			if (jumpFrame) return;
			jumpFrame = requestAnimationFrame(() => { jumpFrame = 0; syncJumpButtons(); });
		});
		messagesEl.addEventListener('toggle', syncJumpButtons, true);
		window.addEventListener('resize', syncJumpPosition);
		syncJumpButtons();
	}

	return { init, isOpen, handleInputKey, syncJumpButtons, syncJumpPosition };
}
