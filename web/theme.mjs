/** 页面主题切换与系统偏好同步；首屏预初始化保留在 HTML。 */
const themeToggleEl = document.getElementById('themeToggle');
const themeRoot = document.documentElement;
const themeMedia = window.matchMedia('(prefers-color-scheme: dark)');

/** 应用页面主题并同步按钮的目标文案，不触碰会话或编辑器内容。 */
function applyTheme(theme) {
	themeRoot.dataset.theme = theme;
	const target = theme === 'dark' ? '浅色' : '深色';
	const current = theme === 'dark' ? '深色' : '浅色';
	themeToggleEl.textContent = target;
	themeToggleEl.setAttribute('aria-label', '切换到' + target + '主题');
	themeToggleEl.title = '当前：' + current + ' · 切换到' + target + '主题';
}

/** 绑定主题操作并应用首屏偏好，不改变会话。 */
export function initTheme() {
	// 手动选择立即生效；存储受限时只保留本页选择，不阻断聊天功能。
	themeToggleEl.addEventListener('click', () => {
		const theme = themeRoot.dataset.theme === 'dark' ? 'light' : 'dark';
		themeRoot.dataset.themePreference = theme;
		applyTheme(theme);
		try {
			localStorage.setItem('pigui.theme', theme);
		} catch {
			// 页面仍按手动选择显示，但下次加载会重新跟随系统。
		}
	});
	// 只有尚未手动选择的页面才跟随系统变化，避免覆盖用户偏好。
	themeMedia.addEventListener('change', (event) => {
		if (themeRoot.dataset.themePreference === 'system') applyTheme(event.matches ? 'dark' : 'light');
	});
	applyTheme(themeRoot.dataset.themePreference === 'system'
		? (themeMedia.matches ? 'dark' : 'light')
		: themeRoot.dataset.theme);
}
