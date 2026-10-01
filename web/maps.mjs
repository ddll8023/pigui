/** 独立地图弹窗：只读 Mellos 数据，以本地 DOM/SVG 绘图，不嵌入上游网页。 */
import { enterSheet, leaveSheet } from './sheets.mjs';

const POLL_MS = 1500;
const STATUS_LABELS = { planned: '未开工', 'in-progress': '开发中', done: '完成', regressed: '已回归失败' };
const KIND_LABELS = { dev: '开发实况', architecture: '架构', dataflow: '数据流', 'behavior-tree': '行为树', sequence: '时序' };
const SVG_NS = 'http://www.w3.org/2000/svg';

/** 创建纯文本元素；地图字段不作为 HTML、CSS 或外部地址解释。 */
function element(tag, className = '', text = '') {
	const node = document.createElement(tag);
	if (className) node.className = className;
	node.textContent = text;
	return node;
}

/** 创建图形元素；属性值只来自已计算的坐标或本模块的常量。 */
function svgElement(tag, attributes = {}) {
	const node = document.createElementNS(SVG_NS, tag);
	for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
	return node;
}

/** 计算分层坐标；普通图高层在上，时序页按 rank 增长从上向下展开。 */
function layoutMap(map, viewportWidth, fontScale) {
	const nodeWidth = 232 * fontScale;
	const nodeHeight = 82 * fontScale;
	const gap = 30;
	const left = 28;
	const columns = Math.max(1, Math.min(4, Math.floor((viewportWidth - 56) / (nodeWidth + gap))));
	const hasLanes = map.lanes.length > 0;
	const laneIds = map.lanes.map((lane) => lane.id);
	if (hasLanes && map.nodes.some((node) => !node.lane)) laneIds.push('');
	const width = Math.max(320, left * 2 + (hasLanes ? laneIds.length : columns) * (nodeWidth + gap) - gap);
	const layers = [...map.layers].sort((a, b) => map.kind === 'sequence' ? a.rank - b.rank : b.rank - a.rank);
	const positions = new Map();
	const bands = [];
	let y = hasLanes ? 54 * fontScale : 18;
	for (const layer of layers) {
		const nodes = map.nodes.filter((node) => node.layer === layer.id);
		const laneRows = new Map();
		let rows = 1;
		for (const [index, node] of nodes.entries()) {
			const lane = node.lane || '';
			const col = hasLanes ? laneIds.indexOf(lane) : index % columns;
			const row = hasLanes ? laneRows.get(lane) || 0 : Math.floor(index / columns);
			if (hasLanes) laneRows.set(lane, row + 1);
			rows = Math.max(rows, row + 1);
			positions.set(node.id, { x: left + col * (nodeWidth + gap), y: y + 40 * fontScale + row * (nodeHeight + gap), width: nodeWidth, height: nodeHeight });
		}
		const height = 40 * fontScale + rows * (nodeHeight + gap) + 24;
		bands.push({ layer, y, height, count: nodes.length });
		y += height;
	}
	return { width, height: Math.max(200, y + 18), positions, bands, lanes: laneIds, nodeWidth, gap, left };
}

/** 创建弹窗控制器；图形、视口和请求状态均限定在此实例。 */
export function createMaps() {
	const overlay = document.getElementById('mapOverlay');
	const picker = overlay.querySelector('.picker');
	const toggle = document.getElementById('mapToggle');
	const closeButton = document.getElementById('mapClose');
	const pageSelect = document.getElementById('mapPages');
	const backButton = document.getElementById('mapBack');
	const search = document.getElementById('mapSearch');
	const results = document.getElementById('mapResults');
	const viewport = document.getElementById('mapViewport');
	const world = document.getElementById('mapWorld');
	const empty = document.getElementById('mapEmpty');
	const details = document.getElementById('mapDetails');
	const status = document.getElementById('mapStatus');
	const title = document.getElementById('mapTitle');
	const project = document.getElementById('mapProject');
	const summary = document.getElementById('mapSummary');
	const legend = document.getElementById('mapLegend');
	const zoomLabel = document.getElementById('mapZoom');
	const zoomOut = document.getElementById('mapZoomOut');
	const zoomIn = document.getElementById('mapZoomIn');
	const fitButton = document.getElementById('mapFit');
	const refreshButton = document.getElementById('mapRefresh');
	let opened = false;
	let page = '';
	let pages = [];
	let pageOptions = '';
	let map = null;
	let revision = '';
	let layout = null;
	let selected = '';
	let timer = 0;
	let requestId = 0;
	let controller = null;
	let drag = null;
	let backStack = [];
	let view = { x: 0, y: 0, scale: 1, fitted: true };
	const views = new Map();
	const cards = new Map();
	let edgeLines = [];

	/** 是否拥有顶层弹窗；插件询问出现时让出 Escape，避免误关闭地图。 */
	function isTopSheet() {
		return !document.querySelector('.overlay:not([hidden]):not(#mapOverlay)');
	}

	/** 是否应该发请求；页面隐藏或弹窗关闭时不保留后台轮询。 */
	function canPoll() {
		return opened && !document.hidden && isTopSheet();
	}

	/** 更新地图通知；稳定文案避免每次轮询都触发读屏播报。 */
	function setStatus(message, error = false) {
		if (status.textContent !== message) status.textContent = message;
		status.dataset.error = String(error);
	}

	/** 显示空白或失败状态；不生成示例节点来冒充真实地图。 */
	function showEmpty(message, instruction = '') {
		empty.replaceChildren(element('h3', '', message));
		if (instruction) empty.append(element('p', '', instruction));
		empty.hidden = false;
		world.hidden = true;
	}

	/** 清空当前图形；切换页面时不让另一张图暂时冒领新页面的标题。 */
	function clearMap() {
		map = null;
		revision = '';
		layout = null;
		selected = '';
		cards.clear();
		edgeLines = [];
		world.replaceChildren();
		details.replaceChildren(element('p', 'map-detail-hint', '选中节点，查看设计说明、依赖与记录的证据。'));
		results.replaceChildren();
		results.hidden = true;
		summary.textContent = '';
		legend.replaceChildren();
		title.textContent = '开发地图';
		picker.dataset.stale = 'false';
		zoomOut.disabled = zoomIn.disabled = fitButton.disabled = true;
		zoomLabel.textContent = '—';
	}

	/** 保存页面自己的平移、缩放与选中节点，子图返回时恢复阅读位置。 */
	function saveView() {
		if (page && map) views.set(page, { ...view, selected });
	}

	/** 将缩放和平移应用到一个绘图世界，不改变弹窗或聊天页面的尺寸。 */
	function applyView() {
		world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
		const percent = view.scale * 100;
		zoomLabel.textContent = `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
	}

	/** 整图适配可见画布；缩小时仍保留层级、节点名称与依赖关系。 */
	function fit() {
		if (!layout || !viewport.clientWidth || !viewport.clientHeight) return;
		view.scale = Math.max(0.001, Math.min(1.2, (viewport.clientWidth - 32) / layout.width, (viewport.clientHeight - 32) / layout.height));
		view.x = (viewport.clientWidth - layout.width * view.scale) / 2;
		view.y = (viewport.clientHeight - layout.height * view.scale) / 2;
		view.fitted = true;
		applyView();
	}

	/** 以鼠标或视口中心为缩放锚点，保持锚点下面的节点不跳动。 */
	function zoom(factor, anchorX = viewport.clientWidth / 2, anchorY = viewport.clientHeight / 2) {
		if (!layout) return;
		const scale = Math.max(0.001, Math.min(3, view.scale * factor));
		const ratio = scale / view.scale;
		view.x = anchorX - (anchorX - view.x) * ratio;
		view.y = anchorY - (anchorY - view.y) * ratio;
		view.scale = scale;
		view.fitted = false;
		applyView();
	}

	/** 聚焦搜索命中或邻接节点；小比例概览先恢复可阅读的比例。 */
	function centerNode(id) {
		const position = layout?.positions.get(id);
		if (!position) return;
		view.scale = Math.max(0.85, view.scale);
		view.x = viewport.clientWidth / 2 - (position.x + position.width / 2) * view.scale;
		view.y = viewport.clientHeight / 2 - (position.y + position.height / 2) * view.scale;
		view.fitted = false;
		applyView();
	}

	/** 纯文本详情段；证据只是存储记录，pigui 不自动执行其中的命令。 */
	function detailSection(label, content) {
		const section = element('section', 'map-detail-section');
		section.append(element('h4', '', label), element('p', '', content));
		return section;
	}

	/** 输出可跳转的相邻节点列表，保留实际边标签。 */
	function relationSection(label, edges, field) {
		const section = element('section', 'map-detail-section');
		section.append(element('h4', '', label));
		if (!edges.length) section.append(element('p', 'map-detail-hint', '无'));
		for (const edge of edges) {
			const node = map.nodes.find((item) => item.id === edge[field]);
			const button = element('button', 'map-relation', node.label + (edge.label ? ` · ${edge.label}` : ''));
			button.type = 'button';
			button.dataset.targetNode = node.id;
			button.addEventListener('click', () => selectNode(node.id, true));
			section.append(button);
		}
		return section;
	}

	/** 更新节点详情，不让背景刷新抢走正在操作的详情按钮焦点。 */
	function renderDetails() {
		const active = details.contains(document.activeElement) ? document.activeElement : null;
		const targetNode = active?.dataset.targetNode;
		const targetSubmap = active?.dataset.submap;
		const node = map?.nodes.find((item) => item.id === selected);
		details.replaceChildren();
		if (!node) {
			details.append(element('p', 'map-detail-hint', '选中节点，查看设计说明、依赖与记录的证据。'));
			return;
		}
		const heading = element('div', 'map-detail-heading');
		heading.append(element('h3', '', node.label), element('code', '', node.id));
		if (node.submap) {
			const exists = pages.some((item) => item.id === node.submap);
			const button = element('button', 'sheet-btn', exists ? '打开子图' : '子图尚未创建');
			button.type = 'button';
			button.disabled = !exists;
			button.title = node.submap;
			button.dataset.submap = node.submap;
			button.addEventListener('click', () => openSubmap(node.submap));
			heading.append(button);
		}
		details.append(heading);
		const layer = map.layers.find((item) => item.id === node.layer);
		const group = map.groups.find((item) => item.id === node.group);
		const lane = map.lanes.find((item) => item.id === node.lane);
		const metadata = [`L${layer.rank} · ${layer.name}`, group?.label, lane?.label, node.kind];
		if (map.kind === 'dev') metadata.push(STATUS_LABELS[node.status], node.status === 'done' && !node.evidence?.trim() ? '未验证' : '');
		details.append(element('p', 'map-detail-meta', metadata.filter(Boolean).join(' · ')));
		const grid = element('div', 'map-detail-grid');
		grid.append(detailSection('设计说明', node.detail || '未记录设计说明。'));
		const evidence = node.evidence?.trim();
		grid.append(detailSection('记录的证据', evidence || (map.kind === 'dev' && node.status === 'done' ? '未验证：地图标记为完成，但没有记录验证证据。' : '未记录验证证据。')));
		const sequence = map.kind === 'sequence';
		grid.append(
			relationSection(sequence ? '前序事件' : '依赖 →', map.edges.filter((edge) => edge.from === node.id), 'to'),
			relationSection(sequence ? '后续事件' : '被依赖 ←', map.edges.filter((edge) => edge.to === node.id), 'from'),
		);
		if (node.sources?.length) grid.append(detailSection('来源路径（仅展示）', node.sources.map((source) => source.path).join('\n')));
		details.append(grid);
		if (active) {
			const restore = [...details.querySelectorAll('button')].find((button) =>
				(targetNode && button.dataset.targetNode === targetNode) || (targetSubmap && button.dataset.submap === targetSubmap),
			);
			if (restore && !restore.disabled) restore.focus({ preventScroll: true });
			else viewport.focus({ preventScroll: true });
		}
	}

	/** 联动节点与相邻依赖的高亮；不把搜索结果的过滤当成节点删除。 */
	function highlight() {
		const connected = new Set([selected]);
		for (const edge of map?.edges || []) {
			if (edge.from === selected) connected.add(edge.to);
			if (edge.to === selected) connected.add(edge.from);
		}
		const query = search.value.trim().toLowerCase();
		const matches = [];
		for (const node of map?.nodes || []) {
			const card = cards.get(node.id);
			const match = !query || [node.id, node.label, node.detail, node.evidence, node.kind, map.groups.find((group) => group.id === node.group)?.label].filter(Boolean).join('\n').toLowerCase().includes(query);
			card.dataset.selected = String(node.id === selected);
			card.setAttribute('aria-pressed', String(node.id === selected));
			// 图卡采用游走焦点，不让 Tab 逐一经过上千个节点。
			card.tabIndex = node.id === (selected || map.nodes[0]?.id) ? 0 : -1;
			card.dataset.dim = String((query && !match) || (selected && !connected.has(node.id)) ? true : false);
			card.dataset.match = String(Boolean(query) && match);
			if (match && query) matches.push(node);
		}
		for (const line of edgeLines) {
			line.element.dataset.active = String(line.edge.from === selected || line.edge.to === selected);
			line.element.dataset.dim = String(Boolean(selected) && !connected.has(line.edge.from));
		}
		results.replaceChildren();
		results.hidden = !query || !map;
		if (query && map) {
			results.append(element('span', 'map-result-count', `找到 ${matches.length} 个节点${matches.length > 30 ? '（仅列前 30 个）' : ''}`));
			for (const node of matches.slice(0, 30)) {
				const button = element('button', 'map-result', node.label);
				button.type = 'button';
				button.addEventListener('click', () => selectNode(node.id, true));
				results.append(button);
			}
		}
	}

	/** 选择节点并更新证据详情；键盘搜索跳转时将焦点带回对应图卡。 */
	function selectNode(id, reveal = false) {
		selected = id;
		highlight();
		renderDetails();
		if (reveal) {
			centerNode(id);
			cards.get(id)?.focus({ preventScroll: true });
		}
	}

	/** 画状态图例；文档型图不把结构节点解释成开发进度。 */
	function renderLegend() {
		legend.replaceChildren();
		if (map.kind !== 'dev') {
			legend.append(element('span', '', `${KIND_LABELS[map.kind]}图 · 节点为中性展示，不统计开发进度`));
			return;
		}
		for (const [state, label] of [['planned', '未开工'], ['in-progress', '开发中'], ['done', '完成 · 有证据'], ['unverified', '完成 · 未验证'], ['regressed', '回归失败']]) {
			const item = element('span', 'map-legend-item', label);
			item.dataset.status = state;
			item.prepend(element('i', 'map-state-dot'));
			legend.append(item);
		}
	}

	/** 用 SVG 绘制依赖，HTML 按钮绘制节点，兼顾中文换行与键盘访问。 */
	function draw() {
		if (!map) return;
		const focused = world.contains(document.activeElement) ? document.activeElement.dataset.node : '';
		const fontScale = Number(document.documentElement.style.getPropertyValue('--font-scale')) || 1;
		layout = layoutMap(map, viewport.clientWidth, fontScale);
		world.replaceChildren();
		cards.clear();
		edgeLines = [];
		world.style.width = `${layout.width}px`;
		world.style.height = `${layout.height}px`;
		world.hidden = false;
		empty.hidden = true;
		picker.dataset.kind = map.kind;
		const svg = svgElement('svg', { width: layout.width, height: layout.height, 'aria-hidden': 'true', focusable: 'false' });
		svg.classList.add('map-lines');
		const defs = svgElement('defs');
		const marker = svgElement('marker', { id: 'pigui-map-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' });
		marker.append(svgElement('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'var(--map-edge)' }));
		defs.append(marker);
		svg.append(defs);
		world.append(svg);
		for (const band of layout.bands) {
			const stripe = element('div', 'map-layer');
			stripe.style.top = `${band.y}px`;
			stripe.style.height = `${band.height}px`;
			stripe.style.width = `${layout.width}px`;
			stripe.append(element('span', 'map-layer-rank', `L${band.layer.rank}`), element('span', 'map-layer-name', band.layer.name), element('span', 'map-layer-count', `${band.count} 节点`));
			world.append(stripe);
		}
		for (const [index, laneId] of layout.lanes.entries()) {
			const label = element('div', 'map-lane-label', map.lanes.find((lane) => lane.id === laneId)?.label || '未分配泳道');
			label.style.left = `${layout.left + index * (layout.nodeWidth + layout.gap)}px`;
			label.style.width = `${layout.nodeWidth}px`;
			world.append(label);
		}
		for (const edge of map.edges) {
			// 时序页的依赖反向展开成时间线，其余图保持 from 使用 to 的方向。
			const from = layout.positions.get(map.kind === 'sequence' ? edge.to : edge.from);
			const to = layout.positions.get(map.kind === 'sequence' ? edge.from : edge.to);
			const startX = from.x + from.width / 2;
			const startY = from.y + from.height;
			const endX = to.x + to.width / 2;
			const endY = to.y;
			const midY = (startY + endY) / 2;
			const line = svgElement('g');
			line.classList.add('map-edge');
			line.append(svgElement('path', { d: `M ${startX} ${startY} C ${startX} ${midY}, ${endX} ${midY}, ${endX} ${endY}`, 'marker-end': 'url(#pigui-map-arrow)' }));
			if (edge.label) {
				const label = svgElement('text', { x: (startX + endX) / 2, y: midY - 5, 'text-anchor': 'middle' });
				label.textContent = edge.label.length > 32 ? edge.label.slice(0, 31) + '…' : edge.label;
				const tooltip = svgElement('title');
				tooltip.textContent = edge.label;
				line.append(label, tooltip);
			}
			svg.append(line);
			edgeLines.push({ edge, element: line });
		}
		for (const node of map.nodes) {
			const position = layout.positions.get(node.id);
			const card = element('button', 'map-node');
			card.type = 'button';
			card.dataset.node = node.id;
			card.dataset.status = node.status === 'done' && !node.evidence?.trim() ? 'unverified' : node.status;
			card.style.left = `${position.x}px`;
			card.style.top = `${position.y}px`;
			card.style.width = `${position.width}px`;
			card.style.height = `${position.height}px`;
			card.title = `${node.label}\n${node.id}${node.submap ? '\n双击打开子图：' + node.submap : ''}`;
			card.append(element('span', 'map-node-label', node.label));
			const meta = element('span', 'map-node-meta');
			if (map.kind === 'dev') {
				meta.append(element('i', 'map-state-dot'), element('span', '', node.status === 'done' ? (node.evidence?.trim() ? '完成 · 有证据' : '完成 · 未验证') : STATUS_LABELS[node.status]));
			} else {
				meta.append(element('span', '', node.kind || map.groups.find((group) => group.id === node.group)?.label || node.id));
			}
			if (node.submap) meta.append(element('span', 'map-submap-mark', '⊞ 子图'));
			card.append(meta);
			card.addEventListener('click', () => selectNode(node.id));
			card.addEventListener('dblclick', () => { if (node.submap) openSubmap(node.submap); });
			card.addEventListener('keydown', (event) => {
				if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
				const followsDependency = map.kind === 'sequence' ? event.key === 'ArrowUp' : event.key === 'ArrowDown';
				const edge = map.edges.find((item) => followsDependency ? item.from === node.id : item.to === node.id);
				if (!edge) return;
				event.preventDefault();
				selectNode(followsDependency ? edge.to : edge.from, true);
			});
			world.append(card);
			cards.set(node.id, card);
		}
		if (!cards.has(selected)) selected = '';
		highlight();
		renderDetails();
		renderLegend();
		zoomOut.disabled = zoomIn.disabled = fitButton.disabled = false;
		if (view.fitted) fit();
		else applyView();
		if (focused) (cards.get(focused) || viewport).focus({ preventScroll: true });
	}

	/** 只在页列表变化时重建选项，不打断浏览器原生下拉列表的操作。 */
	function renderPages() {
		const signature = JSON.stringify(pages.map((item) => [item.id, item.label]));
		if (signature !== pageOptions) {
			pageSelect.replaceChildren();
			for (const item of pages) {
				const option = element('option', '', item.label);
				option.value = item.id;
				pageSelect.append(option);
			}
			pageOptions = signature;
		}
		pageSelect.value = page;
		pageSelect.disabled = !pages.length;
		backButton.hidden = !backStack.length;
	}

	/** 切页保留各页视口；手动切页清理子图导航，返回动作则保留栈。 */
	function switchPage(next, keepStack = false) {
		if (!next || next === page) return;
		saveView();
		page = next;
		if (!keepStack) backStack = [];
		const saved = views.get(page);
		view = saved ? { x: saved.x, y: saved.y, scale: saved.scale, fitted: saved.fitted } : { x: 0, y: 0, scale: 1, fitted: true };
		clearMap();
		selected = saved?.selected || '';
		renderPages();
		showEmpty('正在读取地图…');
		void refresh();
	}

	/** 下潜只接受已发现的当前项目页面，不把 submap 当成任意路径或网址。 */
	function openSubmap(next) {
		if (next === page || !pages.some((item) => item.id === next)) return;
		backStack.push(page);
		switchPage(next, true);
	}

	/** 应用完整快照；同页未变化时不重画，不抢焦点或重置缩放。 */
	function receive(data) {
		// 存储目录暂时不可读并不代表页面被删除，保留已有图和页面选项。
		if (data.error && !data.page && map) {
			picker.dataset.stale = 'true';
			setStatus(data.error + ' · 保留最后一次成功读取的地图', true);
			return;
		}
		pages = data.pages;
		project.textContent = data.cwd;
		project.title = data.cwd;
		if (data.page !== page) {
			saveView();
			page = data.page || '';
			backStack = [];
			const saved = views.get(page);
			view = saved ? { x: saved.x, y: saved.y, scale: saved.scale, fitted: saved.fitted } : { x: 0, y: 0, scale: 1, fitted: true };
			clearMap();
			selected = saved?.selected || '';
		}
		const oldOptions = pageOptions;
		renderPages();
		if (oldOptions !== pageOptions && map) renderDetails();
		if (data.error) {
			picker.dataset.stale = String(Boolean(map));
			setStatus(data.error + (map ? ' · 下方保留最后一次成功读取的地图' : ''), true);
			if (!map) showEmpty('地图暂时无法显示', '可切换其它页面；修复文件后会自动重新读取。');
			return;
		}
		picker.dataset.stale = 'false';
		if (!data.map || !data.map.nodes.length) {
			clearMap();
			showEmpty(data.map ? '这张地图还没有节点' : '当前工作目录还没有地图', '已有 mellos-mapping 工具时，可让 AI 声明设计并更新地图。如需安装，命令为 pi install npm:mellos-mapping；此弹窗不会自动安装或执行。');
			setStatus(data.warning || '等待 .mellos/ 中的地图；弹窗可见时自动刷新。', Boolean(data.warning));
			return;
		}
		title.textContent = data.map.title || pages.find((item) => item.id === page)?.label || '开发地图';
		summary.textContent = `${KIND_LABELS[data.map.kind]} · ${data.map.nodes.length} 节点 · ${data.map.edges.length} 依赖`;
		setStatus(data.warning || '实时同步 · 拖动空白处平移，滚轮缩放；点击节点查看详情。', Boolean(data.warning));
		if (revision !== data.revision || !map) {
			map = data.map;
			revision = data.revision;
			draw();
		}
	}

	/** 拉取快照；取消过期请求，失败保留旧图，关闭或隐藏页面立即停止轮询。 */
	async function refresh() {
		clearTimeout(timer);
		if (!canPoll()) return;
		controller?.abort();
		const id = ++requestId;
		const pending = new AbortController();
		controller = pending;
		const timeout = setTimeout(() => pending.abort(), 8000);
		try {
			const query = page ? '?' + new URLSearchParams({ page }) : '';
			const response = await fetch('/api/maps' + query, { signal: pending.signal });
			const data = await response.json();
			if (id !== requestId || !canPoll()) return;
			if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
			receive(data);
		} catch (error) {
			if (id !== requestId || !canPoll()) return;
			picker.dataset.stale = String(Boolean(map));
			setStatus((pending.signal.aborted ? '地图读取超时' : `地图读取失败：${String(error.message || error)}`) + (map ? ' · 保留最后一次成功读取的地图' : '') + '；将自动重试。', true);
			if (!map) showEmpty('地图读取失败', '检查本地服务是否仍在运行，或点击刷新重试。');
		} finally {
			clearTimeout(timeout);
			if (id === requestId) {
				controller = null;
				if (canPoll()) timer = setTimeout(refresh, POLL_MS);
			}
		}
	}

	/** 暂停请求并使旧响应失效；不向服务器发送任何写操作。 */
	function stopPolling() {
		clearTimeout(timer);
		requestId++;
		controller?.abort();
		controller = null;
	}

	/** 打开独立浮层，复用焦点圈定；原对话布局和滚动位置保持不变。 */
	function openMap() {
		if (opened) return;
		opened = true;
		overlay.hidden = false;
		toggle.setAttribute('aria-expanded', 'true');
		enterSheet(overlay, closeButton);
		if (!map) showEmpty('正在读取地图…');
		else draw();
		setStatus('正在同步地图…');
		void refresh();
	}

	/** 关闭弹窗并恢复入口焦点；轮询与未完成请求同时取消。 */
	function closeMap() {
		if (!opened) return;
		saveView();
		opened = false;
		stopPolling();
		if (drag) {
			const pointerId = drag.id;
			drag = null;
			if (viewport.hasPointerCapture(pointerId)) viewport.releasePointerCapture(pointerId);
			viewport.dataset.dragging = 'false';
		}
		overlay.hidden = true;
		toggle.setAttribute('aria-expanded', 'false');
		leaveSheet(overlay);
	}

	/** 绑定入口、局部手势与生命周期；Escape 只由最上层可见弹窗处理。 */
	function init() {
		clearMap();
		toggle.addEventListener('click', openMap);
		closeButton.addEventListener('click', closeMap);
		overlay.addEventListener('click', (event) => { if (event.target === overlay) closeMap(); });
		// 共享浮层会把所有 button 计入焦点；地图需排除游走焦点里的 tabindex=-1。
		overlay.addEventListener('keydown', (event) => {
			if (event.key !== 'Tab' || !isTopSheet()) return;
			event.stopPropagation();
			const items = [...picker.querySelectorAll('button, input, select, a[href], [tabindex]')].filter((item) =>
				item.tabIndex >= 0 && !item.disabled && item.offsetParent !== null,
			);
			const active = document.activeElement;
			const boundary = event.shiftKey ? items[0] : items[items.length - 1];
			if (!items.length || active === boundary || !picker.contains(active)) {
				event.preventDefault();
				(event.shiftKey ? items[items.length - 1] : items[0])?.focus();
			}
		});
		document.addEventListener('keydown', (event) => {
			if (event.key !== 'Escape' || !opened || !isTopSheet()) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			closeMap();
		}, true);
		pageSelect.addEventListener('change', () => switchPage(pageSelect.value));
		backButton.addEventListener('click', () => {
			const next = backStack.pop();
			if (next) switchPage(next, true);
		});
		search.addEventListener('input', highlight);
		zoomOut.addEventListener('click', () => zoom(1 / 1.25));
		zoomIn.addEventListener('click', () => zoom(1.25));
		fitButton.addEventListener('click', fit);
		refreshButton.addEventListener('click', () => void refresh());
		viewport.addEventListener('wheel', (event) => {
			if (!map) return;
			event.preventDefault();
			const rect = viewport.getBoundingClientRect();
			zoom(Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * 0.003), event.clientX - rect.left, event.clientY - rect.top);
		}, { passive: false });
		viewport.addEventListener('pointerdown', (event) => {
			if (!map || event.button !== 0 || event.target.closest('button')) return;
			drag = { id: event.pointerId, x: event.clientX, y: event.clientY, originX: view.x, originY: view.y };
			viewport.setPointerCapture(event.pointerId);
			viewport.dataset.dragging = 'true';
			viewport.focus({ preventScroll: true });
		});
		viewport.addEventListener('pointermove', (event) => {
			if (!drag || event.pointerId !== drag.id) return;
			view.x = drag.originX + event.clientX - drag.x;
			view.y = drag.originY + event.clientY - drag.y;
			view.fitted = false;
			applyView();
		});
		/** 松手或系统取消手势时释放捕获，不把下一次打开误当成仍在拖拽。 */
		const endDrag = (event) => {
			if (!drag || event.pointerId !== drag.id) return;
			drag = null;
			if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
			viewport.dataset.dragging = 'false';
		};
		viewport.addEventListener('pointerup', endDrag);
		viewport.addEventListener('pointercancel', endDrag);
		viewport.addEventListener('lostpointercapture', endDrag);
		viewport.addEventListener('keydown', (event) => {
			if (event.target !== viewport || !map) return;
			if (event.key === '+' || event.key === '=') zoom(1.25);
			else if (event.key === '-') zoom(1 / 1.25);
			else if (event.key === '0' || event.key === 'Home') fit();
			else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
				view.x += event.key === 'ArrowLeft' ? 40 : event.key === 'ArrowRight' ? -40 : 0;
				view.y += event.key === 'ArrowUp' ? 40 : event.key === 'ArrowDown' ? -40 : 0;
				view.fitted = false;
				applyView();
			} else return;
			event.preventDefault();
		});
		document.addEventListener('visibilitychange', () => {
			if (!opened) return;
			if (document.hidden) stopPolling();
			else void refresh();
		});
		// 插件询问覆盖地图时暂停读取；询问结束后恢复，不在遮挡后继续轮询。
		const overlays = new MutationObserver(() => {
			if (!opened) return;
			if (canPoll()) void refresh();
			else stopPolling();
		});
		for (const other of document.querySelectorAll('.overlay:not(#mapOverlay)')) {
			overlays.observe(other, { attributes: true, attributeFilter: ['hidden'] });
		}
		window.addEventListener('pagehide', stopPolling);
		window.addEventListener('pageshow', () => { if (opened) void refresh(); });
		new ResizeObserver(() => {
			if (opened && map && view.fitted) fit();
		}).observe(viewport);
		new MutationObserver(() => { if (opened && map) draw(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-font-size'] });
	}

	return { init, isOpen: () => opened };
}
