/** 插件与 Skill 的会话级悬浮汇总；可拖拽，不插入消息、不占阅读区布局。 */
const POSITION_KEY = 'pigui.resourceUsagePosition';
const EDGE_MARGIN = 12;
const PANEL_GAP = 8;
const DRAG_THRESHOLD = 5;

export function createResourceUsage() {
	const root = document.getElementById('resourceUsage');
	const toggle = document.getElementById('resourceUsageToggle');
	const panel = document.getElementById('resourceUsagePanel');
	const close = document.getElementById('resourceUsageClose');
	const body = document.getElementById('resourceUsageBody');
	const foot = document.getElementById('resourceUsageFoot');
	const messages = document.getElementById('messages');
	const head = root.querySelector('.resource-head');
	const labels = { tool: '工具调用', command: '命令调用', explicit: '显式调用', read: '已读取' };
	let sessionId = null;
	let serialized = '';
	let positionFrame = 0;
	let manualPosition = null;
	let drag = null;
	let suppressClickUntil = 0;

	/** 将坐标限制在可见范围；极小视口仍优先保留左上边界。 */
	function clamp(value, min, max) {
		return Math.min(Math.max(value, min), Math.max(min, max));
	}

	/** 位置偏好只属于当前访问地址；脏数据或存储被禁用时使用默认位置。 */
	function readPosition() {
		try {
			const saved = JSON.parse(localStorage.getItem(POSITION_KEY) || 'null');
			if (saved?.version === 1 && Number.isFinite(saved.x) && Number.isFinite(saved.y) && saved.x >= 0 && saved.y >= 0) {
				return { x: saved.x, y: saved.y };
			}
		} catch {
			// 不可读取本地偏好时仍支持本页拖拽。
		}
		return null;
	}

	/** 仅在一次拖拽成功结束后保存，不在每个 pointermove 上写存储。 */
	function savePosition() {
		if (!manualPosition) return;
		try {
			localStorage.setItem(POSITION_KEY, JSON.stringify({ version: 1, ...manualPosition }));
		} catch {
			// 存储不可用时，位置仍在当前页面与会话切换间保留。
		}
	}

	/** 默认锚点跟随消息区，手动锚点仅校正边界；卡片自适应展开方向。 */
	function position() {
		if (positionFrame) cancelAnimationFrame(positionFrame);
		positionFrame = 0;
		const rect = messages.getBoundingClientRect();
		const width = toggle.offsetWidth;
		const height = toggle.offsetHeight;
		const viewportWidth = window.innerWidth;
		const viewportHeight = window.innerHeight;
		let x = manualPosition?.x ?? rect.right - 22 - width;
		let y = manualPosition?.y ?? rect.top + 10;
		x = clamp(x, EDGE_MARGIN, viewportWidth - EDGE_MARGIN - width);
		y = clamp(y, EDGE_MARGIN, viewportHeight - EDGE_MARGIN - height);
		const panelWidth = Math.min(280, Math.max(0, viewportWidth - 2 * EDGE_MARGIN));
		let panelOffset;
		let side;
		let space;
		if (drag?.moved && !panel.hidden) {
			// 拖标题栏时固定卡片方向及相对偏移，整块一起移动，避免抓手突然跳开。
			panelOffset = clamp(drag.panelOffset, Math.min(0, width - panelWidth), 0);
			side = drag.side;
			space = Math.min(drag.panelSpace, Math.max(0, viewportHeight - 2 * EDGE_MARGIN - height - PANEL_GAP));
			root.style.setProperty('--resource-panel-space', space + 'px');
			const panelHeight = panel.offsetHeight;
			x = clamp(x, EDGE_MARGIN - Math.min(0, panelOffset), viewportWidth - EDGE_MARGIN - Math.max(width, panelOffset + panelWidth));
			y = side === 'up'
				? clamp(y, EDGE_MARGIN + PANEL_GAP + panelHeight, viewportHeight - EDGE_MARGIN - height)
				: clamp(y, EDGE_MARGIN, viewportHeight - EDGE_MARGIN - height - PANEL_GAP - panelHeight);
		} else {
			const panelLeft = clamp(x + width - panelWidth, EDGE_MARGIN, viewportWidth - EDGE_MARGIN - panelWidth);
			panelOffset = panelLeft - x;
			const below = Math.max(0, viewportHeight - EDGE_MARGIN - y - height - PANEL_GAP);
			const above = Math.max(0, y - EDGE_MARGIN - PANEL_GAP);
			const naturalHeight = panel.hidden ? 400 : Math.min(400, head.offsetHeight + body.scrollHeight + foot.offsetHeight + 2);
			side = below < naturalHeight && above > below ? 'up' : 'down';
			space = side === 'up' ? above : below;
		}
		root.style.left = x + 'px';
		root.style.right = 'auto';
		root.style.top = y + 'px';
		root.dataset.side = side;
		root.style.setProperty('--resource-panel-left', panelOffset + 'px');
		root.style.setProperty('--resource-panel-space', space + 'px');
		if (manualPosition) manualPosition = { x, y };
	}

	/** 捕获主指针；关闭按钮与列表不能启动拖拽，普通点击仍保留原有行为。 */
	function startDrag(event) {
		if (drag || !event.isPrimary || event.button !== 0) return;
		const handle = event.currentTarget;
		if (handle === head && event.target.closest('button, input, textarea, a')) return;
		position();
		const rect = root.getBoundingClientRect();
		drag = {
			pointerId: event.pointerId, handle,
			clientX: event.clientX, clientY: event.clientY,
			x: rect.left, y: rect.top, moved: false,
			previous: manualPosition ? { ...manualPosition } : null,
			panelOffset: panel.hidden ? 0 : panel.getBoundingClientRect().left - rect.left,
			panelSpace: Number.parseFloat(root.style.getPropertyValue('--resource-panel-space')),
			side: root.dataset.side,
		};
		handle.setPointerCapture(event.pointerId);
	}

	/** 超过阈值才移动；以按下时坐标计算位移，rAF 合并渲染且不累积误差。 */
	function moveDrag(event) {
		if (!drag || event.pointerId !== drag.pointerId) return;
		const dx = event.clientX - drag.clientX;
		const dy = event.clientY - drag.clientY;
		if (!drag.moved && Math.hypot(dx, dy) <= DRAG_THRESHOLD) return;
		drag.moved = true;
		root.dataset.dragging = 'true';
		if (event.cancelable) event.preventDefault();
		manualPosition = { x: drag.x + dx, y: drag.y + dy };
		schedulePosition();
	}

	/** 释放时保存最终边界坐标；取消、失焦或捕获丢失时回到拖拽前的位置。 */
	function finishDrag(event, cancelled = false) {
		if (!drag || (event && event.pointerId !== drag.pointerId)) return;
		if (!cancelled && event) moveDrag(event);
		const completed = drag;
		if (cancelled) manualPosition = completed.previous;
		else if (completed.moved) position();
		drag = null;
		delete root.dataset.dragging;
		if (completed.handle.hasPointerCapture(completed.pointerId)) completed.handle.releasePointerCapture(completed.pointerId);
		if (completed.moved) suppressClickUntil = performance.now() + 500;
		position();
		if (completed.moved && !cancelled) savePosition();
	}

	/** 合并布局变化，字号、顶栏换行、附件区和窗口调整都无需轮询。 */
	function schedulePosition() {
		if (!positionFrame) positionFrame = requestAnimationFrame(position);
	}

	/** 收起卡片；键盘关闭时把焦点交还入口，外部点击不抢焦点。 */
	function dismiss(restoreFocus = false) {
		panel.hidden = true;
		toggle.setAttribute('aria-expanded', 'false');
		if (restoreFocus) toggle.focus();
	}

	/** 展开非模态卡片，保留消息区可操作，焦点先落在明确的关闭按钮。 */
	function open() {
		panel.hidden = false;
		toggle.setAttribute('aria-expanded', 'true');
		position();
		close.focus();
	}

	/** 分组列表全部通过 DOM 构建；路径只作来源提示，不解析为 HTML。 */
	function renderGroup(title, items) {
		const section = document.createElement('section');
		section.className = 'resource-group';
		const heading = document.createElement('h3');
		heading.textContent = title;
		const count = document.createElement('span');
		count.textContent = String(items.length);
		heading.append(count);
		section.append(heading);
		if (!items.length) {
			const empty = document.createElement('p');
			empty.className = 'resource-empty';
			empty.textContent = '暂无可识别的使用记录';
			section.append(empty);
		} else {
			const list = document.createElement('ul');
			for (const item of items) {
				const row = document.createElement('li');
				const name = document.createElement('span');
				name.className = 'resource-name';
				name.textContent = String(item.name || '未知来源');
				name.title = String(item.location || '');
				const mode = document.createElement('span');
				mode.className = 'resource-mode';
				mode.textContent = (Array.isArray(item.modes) ? item.modes : []).map((value) => labels[value]).filter(Boolean).join(' · ');
				row.append(name, mode);
				list.append(row);
			}
			section.append(list);
		}
		body.append(section);
	}

	/** 更新计数与列表；完全相同的快照不重绘，保留卡片滚动位置。 */
	function render(usage) {
		const plugins = Array.isArray(usage?.plugins) ? usage.plugins : [];
		const skills = Array.isArray(usage?.skills) ? usage.skills : [];
		const next = JSON.stringify({ plugins, skills, persistent: usage?.persistent });
		if (next === serialized) return;
		serialized = next;
		document.getElementById('resourcePluginCount').textContent = String(plugins.length);
		document.getElementById('resourceSkillCount').textContent = String(skills.length);
		toggle.setAttribute('aria-label', `本会话已使用：插件 ${plugins.length} 个，Skill ${skills.length} 个，点击展开汇总或拖拽移动`);
		const scrollTop = body.scrollTop;
		body.replaceChildren();
		renderGroup('插件', plugins);
		renderGroup('Skill', skills);
		body.scrollTop = scrollTop;
		foot.textContent = '仅统计当前分支。插件调用不等于成功；Skill 已读取不代表一定遵循。' +
			(usage?.persistent === false ? '当前 SDK 不支持持久化使用元数据。' : '');
		schedulePosition();
	}

	/** 切会话时关闭旧卡片并立即替换数据；同一会话重连不影响展开态。 */
	function setContext(context) {
		if (sessionId !== context.sessionId) {
			dismiss(panel.contains(document.activeElement));
			sessionId = context.sessionId;
			serialized = '';
			body.scrollTop = 0;
		}
		render(context.resourceUsage);
	}

	/** 只接收服务端使用汇总帧，不从工具名或消息正文在页面二次推测来源。 */
	function handleFrame(frame) {
		if (frame.kind !== 'resource_usage') return false;
		if (frame.sessionId === sessionId) render(frame.usage);
		return true;
	}

	/** 安装拖拽与卡片交互；拖拽后的合成点击不能误触展开或收起。 */
	function init() {
		manualPosition = readPosition();
		toggle.title = '点击查看本会话使用过的插件与 Skill；按住拖拽可移动';
		head.title = '按住标题栏拖拽移动';
		for (const handle of [toggle, head]) {
			handle.addEventListener('pointerdown', startDrag);
			handle.addEventListener('pointermove', moveDrag);
			handle.addEventListener('pointerup', (event) => finishDrag(event));
			handle.addEventListener('pointercancel', (event) => finishDrag(event, true));
			handle.addEventListener('lostpointercapture', (event) => finishDrag(event, true));
		}
		root.addEventListener('click', (event) => {
			if (event.detail === 0 || performance.now() >= suppressClickUntil) return;
			suppressClickUntil = 0;
			event.preventDefault();
			event.stopImmediatePropagation();
		}, true);
		toggle.addEventListener('click', () => { if (panel.hidden) open(); else dismiss(); });
		close.addEventListener('click', () => dismiss(true));
		document.addEventListener('pointerdown', (event) => {
			// 新的一次按下是独立操作，不受上一次拖拽的点击抑制影响。
			suppressClickUntil = 0;
			if (!drag && !panel.hidden && !root.contains(event.target)) dismiss();
		});
		document.addEventListener('keydown', (event) => {
			if (drag && event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				finishDrag(null, true);
				return;
			}
			if (panel.hidden || event.key !== 'Escape') return;
			// 原有模态浮层优先接收 Escape，不让非模态卡片截走取消操作。
			if (document.querySelector('.overlay:not([hidden])')) { dismiss(); return; }
			event.preventDefault();
			event.stopPropagation();
			dismiss(true);
		}, true);
		root.addEventListener('focusout', (event) => {
			if (!drag && event.relatedTarget && !root.contains(event.relatedTarget)) dismiss();
		});
		window.addEventListener('blur', () => finishDrag(null, true));
		window.addEventListener('resize', schedulePosition);
		const observer = new ResizeObserver(schedulePosition);
		for (const node of [messages, document.querySelector('.topbar'), document.getElementById('composer'), toggle]) observer.observe(node);
		render(null);
		root.hidden = false;
		position();
	}

	/** 编辑器补全在卡片展开时让位，不影响原有模态浮层。 */
	function isOpen() { return !panel.hidden; }

	return { init, setContext, handleFrame, isOpen };
}
