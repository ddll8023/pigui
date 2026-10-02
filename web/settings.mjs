/** 页面设置浮层：主题、字号与输入区状态栏的项目开关；偏好只存在本页。 */
import { enterSheet, leaveSheet } from './sheets.mjs';

/** 字号档位与基准值：档位即正文 px，基准 14px 对应 --font-scale: 1，默认档位 16px。 */
const FONT_SIZES = [12, 13, 14, 15, 16, 17, 18];
const BASE_FONT_SIZE = 14;

/** 页面默认外观：没有存过本地偏好时用浅色 + 16px。 */
const DEFAULT_THEME = 'light';
const DEFAULT_FONT_SIZE = 16;

/** 主题切换的一次性过渡时长，与 base.css 里 .theme-transition 的 300ms 对应。 */
const THEME_TRANSITION_MS = 300;

/** 主题三态：跟随系统 / 浅色 / 深色。 */
const THEMES = [
	{ value: 'system', label: '跟随系统' },
	{ value: 'light', label: '浅色' },
	{ value: 'dark', label: '深色' },
];

/** 状态栏开关：用量行的四项明细 + 插件状态槽；默认全开。 */
const STATUS_ITEMS = [
	{ key: 'tokens', label: 'tokens 计数', note: '↑↓ R W $ 累计输入 / 输出 / 缓存与费用' },
	{ key: 'context', label: '上下文占用', note: '百分比与窗口大小；占用过高时变色' },
	{ key: 'rate', label: '输出速率', note: '生成中的实时速率与上次调用的平均速率' },
	{ key: 'badge', label: '外部额度摘要', note: '行尾的 Codex 剩余 / OpenCode Go 已用短摘要' },
	{ key: 'plugin', label: '插件状态', note: '插件通过 setStatus 写的状态槽' },
];

/** 创建设置浮层；主题与字号立即生效，状态栏开关通过 subscribe 通知使用方。 */
export function createSettings({ openUsage } = {}) {
	const settingsOverlayEl = document.getElementById('settingsOverlay');
	const settingsBodyEl = document.getElementById('settingsBody');
	const settingsCloseEl = document.getElementById('settingsClose');
	const settingsToggleEl = document.getElementById('settingsToggle');
	const themeRoot = document.documentElement;
	const themeMedia = window.matchMedia('(prefers-color-scheme: dark)');

	/** 浮层开关状态。 */
	let open = false;

	/** 当前偏好：主题、字号（px）与状态栏各开关。 */
	let themePreference = DEFAULT_THEME;

	let fontSize = DEFAULT_FONT_SIZE;

	let statusBar = {};

	/** 状态栏开关的订阅者：设置变化时把最新值推给用量行与插件状态。 */
	const subscribers = new Set();

	/** 主题过渡的收尾定时器：连续切主题时只保留最后一次。 */
	let themeTransitionTimer = 0;

	/** 本地存储可用性未知，读写都降级为“本次会话内有效”。 */
	function readStored(key) {
		try {
			return localStorage.getItem(key);
		} catch {
			return null;
		}
	}

	/** 写入本地存储；被禁用时静默跳过，不影响本次会话的显示。 */
	function writeStored(key, value) {
		try {
			localStorage.setItem(key, value);
		} catch {
			// 偏好只在本次会话内有效。
		}
	}

	/** 状态栏开关：只接受布尔值，缺项与脏数据一律回落到默认开启。 */
	function readStatusBar() {
		const defaults = Object.fromEntries(STATUS_ITEMS.map((item) => [item.key, true]));
		let saved = null;
		try {
			saved = JSON.parse(readStored('pigui.statusBar') || 'null');
		} catch {
			saved = null;
		}
		if (!saved || typeof saved !== 'object') return defaults;
		for (const item of STATUS_ITEMS) {
			if (typeof saved[item.key] === 'boolean') defaults[item.key] = saved[item.key];
		}
		return defaults;
	}

	/** 首屏脚本已把主题与字号写在根元素上，这里只做校验与回读。 */
	function readState() {
		const preference = themeRoot.dataset.themePreference;
		themePreference = THEMES.some((item) => item.value === preference) ? preference : DEFAULT_THEME;
		const size = Number(themeRoot.dataset.fontSize);
		fontSize = FONT_SIZES.includes(size) ? size : DEFAULT_FONT_SIZE;
		statusBar = readStatusBar();
	}

	/**
	 * 给这一次主题变更开一个 300ms 的颜色过渡窗口。
	 * 只挂一次性 class：常驻 hover 动效仍是 160ms，首屏也没挂 class；
	 * 是否真的播过渡由 CSS 的 prefers-reduced-motion 决定，这里不重复判断。
	 */
	function beginThemeTransition() {
		themeRoot.classList.add('theme-transition');
		clearTimeout(themeTransitionTimer);
		themeTransitionTimer = setTimeout(() => {
			themeRoot.classList.remove('theme-transition');
		}, THEME_TRANSITION_MS);
	}

	/** 应用主题；跟随系统时由系统偏好实时决定浓淡。 */
	function applyTheme() {
		themeRoot.dataset.themePreference = themePreference;
		themeRoot.dataset.theme =
			themePreference === 'system' ? (themeMedia.matches ? 'dark' : 'light') : themePreference;
	}

	/** 应用字号：只写倍率变量，各处 font-size 按它缩放。 */
	function applyFontSize() {
		themeRoot.dataset.fontSize = String(fontSize);
		themeRoot.style.setProperty('--font-scale', String(fontSize / BASE_FONT_SIZE));
	}

	/** 把状态栏开关推给用量行与插件状态；传入副本，避免使用方改到内部状态。 */
	function publishStatusBar() {
		for (const subscriber of subscribers) subscriber({ ...statusBar });
	}

	/** 切换主题并落盘；跟随系统时同时把当前浓淡写进页面。 */
	function setTheme(value) {
		if (!THEMES.some((item) => item.value === value) || value === themePreference) return;
		themePreference = value;
		beginThemeTransition();
		applyTheme();
		writeStored('pigui.theme', value);
	}

	/** 切换字号并落盘；改动立即影响已渲染的全部内容。 */
	function setFontSize(size) {
		if (!FONT_SIZES.includes(size) || size === fontSize) return;
		fontSize = size;
		applyFontSize();
		writeStored('pigui.fontSize', String(size));
	}

	/** 切换状态栏某一项的显示；勾选状态即最终状态。 */
	function setStatusItem(key, visible) {
		if (!(key in statusBar) || statusBar[key] === visible) return;
		statusBar[key] = visible;
		writeStored('pigui.statusBar', JSON.stringify(statusBar));
		publishStatusBar();
	}

	/** 一个分组容器：标题 + 内容，供设置项按语义分区。 */
	function renderGroup(title) {
		const group = document.createElement('div');
		group.className = 'settings-group';
		const head = document.createElement('h4');
		head.className = 'settings-group-title';
		head.textContent = title;
		group.append(head);
		settingsBodyEl.append(group);
		return group;
	}

	/** 一行分段选项（主题 / 字号），点击即生效；只改本行选中标记，不重建浮层（避免丢焦点）。 */
	function renderChips(group, label, options, activeValue, onPick) {
		const row = document.createElement('div');
		row.className = 'settings-row';
		const text = document.createElement('span');
		text.className = 'settings-row-label';
		text.textContent = label;
		row.append(text);
		for (const option of options) {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'think-chip';
			button.textContent = option.label;
			button.dataset.active = String(option.value === activeValue);
			button.setAttribute('aria-pressed', String(option.value === activeValue));
			if (option.title) button.title = option.title;
			button.addEventListener('click', () => {
				onPick(option.value);
				for (const chip of row.querySelectorAll('.think-chip')) {
					const selected = String(chip === button);
					chip.dataset.active = selected;
					chip.setAttribute('aria-pressed', selected);
				}
			});
			row.append(button);
		}
		group.append(row);
	}

	/** 一行复选项：勾选即切换对应内容在状态栏里的显示。 */
	function renderCheck(group, item) {
		const label = document.createElement('label');
		label.className = 'settings-check';
		const box = document.createElement('input');
		box.type = 'checkbox';
		box.checked = Boolean(statusBar[item.key]);
		box.addEventListener('change', () => setStatusItem(item.key, box.checked));
		const text = document.createElement('span');
		text.className = 'text';
		const name = document.createElement('span');
		name.className = 'name';
		name.textContent = item.label;
		const note = document.createElement('span');
		note.className = 'note';
		note.textContent = item.note;
		text.append(name, note);
		label.append(box, text);
		group.append(label);
	}

	/** 重绘设置内容；每次打开都按磁盘上的偏好重建，避免两处状态不同步。 */
	function render() {
		settingsBodyEl.replaceChildren();

		const appearance = renderGroup('外观');
		renderChips(appearance, '主题', THEMES, themePreference, setTheme);
		renderChips(
			appearance,
			'字号',
			FONT_SIZES.map((size) => ({
				value: size,
				label: size + 'px',
				title: size === DEFAULT_FONT_SIZE ? '默认字号（16px）' : size + 'px 正文，代码与浮层同比缩放',
			})),
			fontSize,
			setFontSize,
		);

		const status = renderGroup('状态栏');
		for (const item of STATUS_ITEMS) renderCheck(status, item);
		// 用量行被关掉后没有别的入口，这里补一个稳定入口
		const entry = document.createElement('div');
		entry.className = 'settings-row';
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'sheet-btn';
		button.textContent = '打开用量与额度';
		button.addEventListener('click', () => {
			closeSettings();
			if (typeof openUsage === 'function') openUsage();
		});
		entry.append(button);
		status.append(entry);
	}

	/** 打开设置浮层（顶栏按钮与 /settings 命令共用）。 */
	function openSettings() {
		if (open) return;
		open = true;
		readState();
		render();
		settingsOverlayEl.hidden = false;
		enterSheet(settingsOverlayEl, settingsCloseEl);
	}

	/** 关闭设置浮层，把焦点还给打开它的地方。 */
	function closeSettings() {
		if (!open) return;
		open = false;
		settingsOverlayEl.hidden = true;
		leaveSheet(settingsOverlayEl);
	}

	/** 订阅状态栏开关变化；返回取消订阅的函数。 */
	function subscribe(subscriber) {
		if (typeof subscriber !== 'function') return () => {};
		subscribers.add(subscriber);
		return () => subscribers.delete(subscriber);
	}

	/** 状态栏开关的当前值（副本）。 */
	function getStatusBar() {
		return { ...statusBar };
	}

	/** 字号倍率：输入框高度上限等按它等比换算。 */
	function getFontScale() {
		return fontSize / BASE_FONT_SIZE;
	}

	/** 设置浮层打开时文件补全与其它浮层键位让位。 */
	function isOpen() {
		return open;
	}

	/** 应用首屏偏好并绑定入口、关闭与系统主题变化。 */
	function init() {
		readState();
		applyTheme();
		applyFontSize();
		publishStatusBar();
		settingsToggleEl.addEventListener('click', openSettings);
		settingsCloseEl.addEventListener('click', closeSettings);
		settingsOverlayEl.addEventListener('click', (event) => {
			if (event.target === settingsOverlayEl) closeSettings();
		});
		document.addEventListener('keydown', (event) => {
			if (event.key === 'Escape' && open) closeSettings();
		});
		// 只有仍然跟随系统时才响应系统浓淡变化，手动选择不被覆盖
		themeMedia.addEventListener('change', () => {
			if (themePreference !== 'system') return;
			beginThemeTransition();
			applyTheme();
		});
	}

	return { init, isOpen, openSettings, getStatusBar, getFontScale, subscribe };
}
