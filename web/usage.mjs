/** 用量与额度展示 */
import { enterSheet, leaveSheet } from './sheets.mjs';

/** 创建用量与额度展示；状态由实例自己维护。 */
export function createUsage() {
	const usageEl = document.getElementById('usage');
	const usageOverlayEl = document.getElementById('usageOverlay');
	const usageBodyEl = document.getElementById('usageBody');
	const usageFootEl = document.getElementById('usageFoot');
	const usageCloseEl = document.getElementById('usageClose');

	/** 用量快照（session 帧与 usage 帧都会带来）与速率（实时 / 上一次调用的平均）。 */
	let usageState = null;

	let rateState = { live: null, average: null };

	/** 上一次渲染用量时的会话 id：换会话要丢掉旧的速率与用量。 */
	let usageSessionId = '';

	/** 外部额度（Codex 账号额度 / OpenCode Go 套餐）与浮层状态。 */
	let externalUsage = null;

	let usageOpen = false;

	let usageLoading = false;

	let usageError = '';

	/** 大数字的短格式：1234 → 1.2K、1234567 → 1.2M。 */
	function formatTokens(value) {
		const size = Number(value) || 0;
		if (size >= 1e6) return (size / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
		if (size >= 1000) return (size / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
		return String(size);
	}

	/** 毫秒时间戳 → “2小时13分后重置”。 */
	function formatResetIn(at) {
		if (!Number.isFinite(at)) return '';
		const minutes = Math.floor((at - Date.now()) / 60000);
		if (minutes <= 0) return '即将重置';
		const days = Math.floor(minutes / 1440);
		const hours = Math.floor((minutes % 1440) / 60);
		if (days > 0) return `${days}天${hours}小时后重置`;
		if (hours > 0) return `${hours}小时${minutes % 60}分后重置`;
		return `${minutes}分钟后重置`;
	}

	/** ISO 时间字符串（OpenCode 用）→ 同样的倒计时文案。 */
	function formatResetAt(value) {
		if (!value) return '';
		const at = Date.parse(value);
		return Number.isFinite(at) ? formatResetIn(at) : '';
	}

	/** 行内最短摘要：Codex 剩余最低的窗口、OpenCode Go 用得最多的窗口。 */
	function usageBadgeText() {
		const parts = [];
		const codex = externalUsage?.codex;
		if (codex?.ok) {
			const windows = (codex.windows || []).filter((item) => Number.isFinite(item.remainingPercent));
			if (windows.length) {
				const lowest = windows.reduce((a, b) => (a.remainingPercent <= b.remainingPercent ? a : b));
				parts.push('Codex 剩' + Math.round(lowest.remainingPercent) + '%');
			}
		}
		const opencode = externalUsage?.opencode;
		if (opencode?.ok) {
			const windows = (opencode.windows || []).filter((item) => Number.isFinite(item.usedPercent));
			if (windows.length) {
				const highest = windows.reduce((a, b) => (a.usedPercent >= b.usedPercent ? a : b));
				parts.push('Go 已用' + Math.round(highest.usedPercent) + '%');
			}
		}
		return parts.join(' · ');
	}

	/** 拉外部额度（服务端 60 秒缓存）；完成后刷新行内摘要与浮层。 */
	async function loadExternalUsage(force = false) {
		if (usageLoading) return;
		usageLoading = true;
		if (usageOpen) renderUsageOverlay();
		try {
			const response = await fetch('/api/usage/external' + (force ? '?refresh=1' : ''));
			externalUsage = await response.json();
			usageError = '';
		} catch (err) {
			usageError = '读取失败：' + String((err && err.message) || err);
		}
		usageLoading = false;
		renderUsage();
		if (usageOpen) renderUsageOverlay();
	}

	/** 打开额度浮层；首次打开会现拉一次外部额度（行内摘要可能已经拉过）。 */
	function openUsageOverlay() {
		if (usageOpen) return;
		usageOpen = true;
		usageOverlayEl.hidden = false;
		enterSheet(usageOverlayEl);
		renderUsageOverlay();
		void loadExternalUsage(false);
	}

	/** 关闭额度浮层。 */
	function closeUsageOverlay() {
		if (!usageOpen) return;
		usageOpen = false;
		usageOverlayEl.hidden = true;
		leaveSheet(usageOverlayEl);
	}

	/** 一个指标：淡色标签 + 实色数值（悬停有图例）。 */
	function usageMetric(tag, value, title) {
		const node = document.createElement('span');
		node.className = 'metric';
		if (title) node.title = title;
		node.append(document.createTextNode(tag));
		const strong = document.createElement('b');
		strong.textContent = value;
		node.append(strong);
		return node;
	}

	/** 一行进度：标签 | 条 | 百分比 | 说明（重置倒计时）。percent 为空时条不填。 */
	function usageProgressRow(label, percent, options = {}) {
		const row = document.createElement('div');
		row.className = 'usage-row';
		const name = document.createElement('span');
		name.className = 'usage-label';
		name.textContent = label;
		name.title = label;
		const bar = document.createElement('span');
		bar.className = 'usage-bar';
		const fill = document.createElement('span');
		fill.className = 'usage-fill' + (options.level ? ' ' + options.level : '');
		const filled = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
		fill.style.width = filled + '%';
		bar.append(fill);
		const value = document.createElement('span');
		value.className = 'usage-value';
		value.textContent = options.valueText || (Number.isFinite(percent) ? percent.toFixed(1) + '%' : '?');
		const when = document.createElement('span');
		when.className = 'usage-when';
		when.textContent = options.when || '';
		row.append(name, bar, value, when);
		return row;
	}

	/** 已用百分比的档位：≥90% 危险、≥70% 警告。 */
	function usedLevel(percent) {
		if (!Number.isFinite(percent)) return '';
		if (percent >= 90) return 'danger';
		if (percent >= 70) return 'warn';
		return '';
	}

	/** 剩余百分比的档位：≤10% 危险、≤30% 警告。 */
	function remainLevel(percent) {
		if (!Number.isFinite(percent)) return '';
		if (percent <= 10) return 'danger';
		if (percent <= 30) return 'warn';
		return '';
	}

	/** 把本会话用量 + Codex 额度 + OpenCode Go 套餐用量画进浮层。 */
	function renderUsageOverlay() {
		usageBodyEl.replaceChildren();
		/** 为会话或额度来源创建独立统计分区。 */
		const section = (title) => {
			const node = document.createElement('div');
			node.className = 'usage-section';
			const head = document.createElement('h4');
			head.textContent = title;
			node.append(head);
			usageBodyEl.append(node);
			return node;
		};
		/** 追加数值说明、读取状态或失败原因。 */
		const line = (parent, text, className) => {
			const node = document.createElement('div');
			node.className = className || 'usage-line';
			node.textContent = text;
			parent.append(node);
		};

		// 本会话（pi）
		const session = section('本会话');
		if (usageState) {
			const metrics = document.createElement('div');
			metrics.className = 'usage-metrics';
			metrics.append(
				usageMetric('↑', formatTokens(usageState.input), '输入 tokens'),
				usageMetric('↓', formatTokens(usageState.output), '输出 tokens'),
				usageMetric('R', formatTokens(usageState.cacheRead), '缓存读 tokens'),
				usageMetric('W', formatTokens(usageState.cacheWrite), '缓存写 tokens'),
				usageMetric('$', (Number(usageState.cost) || 0).toFixed(3), '本会话累计费用'),
			);
			session.append(metrics);
			const context = usageState.context || null;
			const percent = context && Number.isFinite(context.percent) ? context.percent : null;
			const windowSize = context && Number.isFinite(context.contextWindow) ? formatTokens(context.contextWindow) : '?';
			session.append(
				usageProgressRow('上下文', percent, {
					level: usedLevel(percent),
					valueText: (percent === null ? '?' : percent.toFixed(1) + '%') + ' / ' + windowSize,
				}),
			);
		} else {
			line(session, '用量 —', 'usage-note');
		}
		const rates = document.createElement('div');
		rates.className = 'usage-metrics';
		if (Number.isFinite(rateState.live)) rates.append(usageMetric('实', rateState.live.toFixed(1) + ' t/s', '实时输出速率（2 秒窗口）'));
		if (Number.isFinite(rateState.average)) rates.append(usageMetric('均', rateState.average.toFixed(1) + ' t/s', '上一次模型调用的平均速率'));
		if (rates.children.length) session.append(rates);

		// Codex 账号额度（条 = 剩余，越少越危险）
		const codexSection = section('Codex 额度');
		const codex = externalUsage?.codex;
		if (!codex) line(codexSection, usageLoading ? '读取中…' : '尚未读取', 'usage-note');
		else if (!codex.ok) line(codexSection, codex.error || '读取失败', 'usage-note error');
		else {
			if (!(codex.windows || []).length) line(codexSection, '接口没有返回窗口数据', 'usage-note');
			for (const window of codex.windows || []) {
				const remain = Number.isFinite(window.remainingPercent) ? window.remainingPercent : null;
				codexSection.append(
					usageProgressRow(window.label, remain, {
						level: remainLevel(remain),
						valueText: remain === null ? '?' : remain.toFixed(1) + '%',
						when: formatResetIn(window.resetAt),
					}),
				);
			}
			if (codex.credits) line(codexSection, '可用额度 ' + codex.credits);
			if (codex.limitReached) line(codexSection, '当前窗口额度已用尽', 'usage-note error');
		}

		// OpenCode Go（接口给的 percent 是已用）
		const goSection = section('OpenCode Go');
		const opencode = externalUsage?.opencode;
		if (!opencode) line(goSection, usageLoading ? '读取中…' : '尚未读取', 'usage-note');
		else if (!opencode.ok) line(goSection, opencode.error || '读取失败', 'usage-note error');
		else {
			if (!(opencode.windows || []).length) line(goSection, '接口没有返回窗口数据', 'usage-note');
			for (const window of opencode.windows || []) {
				const used = Number.isFinite(window.usedPercent) ? window.usedPercent : null;
				goSection.append(
					usageProgressRow(window.label, used, {
						level: usedLevel(used),
						valueText: used === null ? '?' : used.toFixed(1) + '%',
						when: formatResetAt(window.resetsAt),
					}),
				);
			}
			for (const window of opencode.windows || []) {
				if (window.status && window.status !== 'ok') {
					line(goSection, `${window.label} 状态：${window.status}`, 'usage-note warn');
				}
			}
		}

		if (usageError) line(usageBodyEl, usageError, 'usage-note error');

		// 底部：更新时间 + 手动刷新（刷新会绕过服务端的 60 秒缓存）
		usageFootEl.replaceChildren();
		const updated = externalUsage && Number.isFinite(externalUsage.fetchedAt) ? new Date(externalUsage.fetchedAt) : null;
		const time = document.createElement('span');
		time.textContent = `${updated ? '更新于 ' + updated.toLocaleTimeString('zh-CN', { hour12: false }) : '尚未读取'}（缓存 60 秒）`;
		const refresh = document.createElement('button');
		refresh.type = 'button';
		refresh.className = 'sheet-btn';
		refresh.textContent = usageLoading ? '刷新中…' : '刷新';
		refresh.disabled = usageLoading;
		refresh.addEventListener('click', () => void loadExternalUsage(true));
		usageFootEl.append(time, refresh);
	}

	/** 渲染输入区下方的用量与速率行；没有任何数据时退化成占位。 */
	function renderUsage() {
		usageEl.replaceChildren();
		if (!usageState) {
			// 本会话统计拿不到时，外部额度摘要仍然可以显示
			const fallback = usageBadgeText();
			usageEl.textContent = fallback ? `用量 — · ${fallback}` : '用量 —';
			return;
		}
		const head = document.createElement('span');
		head.textContent = [
			'↑' + formatTokens(usageState.input),
			'↓' + formatTokens(usageState.output),
			'R' + formatTokens(usageState.cacheRead),
			'W' + formatTokens(usageState.cacheWrite),
			'$' + (Number(usageState.cost) || 0).toFixed(3),
		].join(' ');
		usageEl.append(head);

		const context = usageState.context || null;
		const percent = context && Number.isFinite(context.percent) ? context.percent : null;
		const windowSize =
			context && Number.isFinite(context.contextWindow) ? formatTokens(context.contextWindow) : '?';
		const contextNode = document.createElement('span');
		contextNode.textContent =
			'上下文 ' + (percent === null ? '?' : percent.toFixed(1) + '%') + '/' + windowSize;
		// 占用过高时变色提醒（70% 警告、90% 危险）
		if (percent !== null && percent >= 90) contextNode.className = 'danger';
		else if (percent !== null && percent >= 70) contextNode.className = 'warn';
		usageEl.append(contextNode);

		/** 仅为有效速率创建行内指标，未知值不占位。 */
		const rate = (value, label) => {
			if (!Number.isFinite(value)) return;
			const node = document.createElement('span');
			node.className = 'rate';
			node.textContent = label + ' ' + value.toFixed(1) + ' t/s';
			usageEl.append(node);
		};
		rate(rateState.live, '实');
		rate(rateState.average, '均');

		// 行内最短摘要：外部额度拿到了才显示（未登录/失败就不占位置）
		const badge = usageBadgeText();
		if (badge) {
			const node = document.createElement('span');
			node.className = 'badge';
			node.textContent = badge;
			usageEl.append(node);
		}
	}

	/** 换会话时清除速率，同一会话的刷新与切模型保留速率。 */
	function setContext(context) {
		const sessionKey = String(context.sessionId || context.sessionFile || '');
		if (sessionKey !== usageSessionId) {
			usageSessionId = sessionKey;
			rateState = { live: null, average: null };
		}
		usageState = context.usage || null;
		renderUsage();
	}

	/** 接收用量和速率帧，缺少本次平均值时保留上一次平均值。 */
	function handleFrame(frame) {
		if (frame.kind === 'usage') usageState = frame.usage || null;
		else if (frame.kind === 'rate') {
			if (frame.phase === 'live') rateState.live = Number.isFinite(frame.live) ? frame.live : null;
			else if (frame.phase === 'idle') rateState.live = null;
			else if (frame.phase === 'end') {
				rateState.live = null;
				if (Number.isFinite(frame.average)) rateState.average = frame.average;
			}
		} else return false;
		renderUsage();
		return true;
	}

	/** 初始化额度浮层，首屏完成后按原约定读取一次外部额度。 */
	function init() {
		usageEl.addEventListener('click', openUsageOverlay);
		usageEl.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openUsageOverlay(); }
		});
		usageOverlayEl.addEventListener('click', (event) => { if (event.target === usageOverlayEl) closeUsageOverlay(); });
		usageCloseEl.addEventListener('click', closeUsageOverlay);
		document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && usageOpen) closeUsageOverlay(); });
		renderUsage();
		setTimeout(() => void loadExternalUsage(false), 1000);
	}

	return { init, setContext, handleFrame };
}
