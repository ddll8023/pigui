/** 消息、流式内容、工具记录和行计时；全部状态随消息区复位。 */
import { renderMarkdown } from './markdown.mjs';

/** 创建消息区；外部只注入运行状态读取和导航刷新操作。 */
export function createMessages({ isBusy, syncJumpButtons }) {
	const messagesEl = document.getElementById('messages');

	/** 消息序号（只给真正的消息行，状态行不占号）。 */
	let seq = 0;

	/** 当前流式正文行：{ row, body, text }。 */
	let streaming = null;

	/** 当前流式思考行：{ row, details, textEl, countEl, text }。 */
	let thinkingRow = null;

	/** 正在生成的助手消息：正文和思考共用一行，落定时保留行位置及序号。 */
	let pendingAssistant = null;

	/** toolCallId → 调用记录；跨消息、历史分片保留，仅在清空会话时复位。 */
	const toolRecords = new Map();

	const TOOL_STATES = {
		pending: ['○', '等待结果'], running: ['…', '运行中'],
		done: ['✓', '完成'], failed: ['!', '失败'], unknown: ['?', '未确认'],
	};

	/** 本地已画出、还在等服务端回显的用户行：{ text, row }，按发送顺序排队。 */
	let pendingUserRows = [];

	/** 已渲染出来的历史行数（判断是否需要空态提示）。 */
	let historyRows = 0;

	/** 正在跳动的计时器：row → { baseMs, baseAt, prefix }；baseMs 是挂上时已经过去的毫秒数。 */
	const liveTimers = new Map();

	/** 计时刷新句柄；没有活跃计时器时为 0。 */
	let timerHandle = 0;

	/** 当前回合计时挂在哪一行（收到回合结束帧时用它定格）。 */
	let turnTimerRow = null;

	/** 是否已经贴到底部（决定要不要自动滚动）。 */
	function pinnedToBottom() {
		return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
	}

	/** 追加一行；贴着底部时自动跟随，并移除空态提示。 */
	function appendRow(row) {
		const empty = messagesEl.querySelector('.empty');
		if (empty) empty.remove();
		const pinned = pinnedToBottom();
		messagesEl.append(row);
		if (pinned) messagesEl.scrollTop = messagesEl.scrollHeight;
		syncJumpButtons();
	}

	/** 生成角色行：用户身份位于气泡上方，AI 与独立工具记录使用左侧身份锚点。 */
	function createRow(kind, label, options) {
		const opts = options || {};
		const row = document.createElement('article');
		row.className = 'row ' + kind;
		row.setAttribute('aria-label', kind === 'user' ? '用户消息' : kind === 'assistant' ? 'AI 回复' : label);
		const gutter = document.createElement('div');
		gutter.className = 'gutter';
		if (opts.index != null) {
			const idx = document.createElement('span');
			idx.className = 'idx';
			idx.textContent = String(opts.index).padStart(3, '0');
			gutter.append(idx);
		}
		const who = document.createElement('span');
		who.className = 'who';
		who.textContent = label;
		gutter.append(who);
		// 耗时槽位先占位不显示，setRowDuration 填值时才露出
		const dur = document.createElement('span');
		dur.className = 'dur';
		dur.hidden = true;
		gutter.append(dur);
		const body = document.createElement('div');
		body.className = 'body';
		row.append(gutter, body);
		return { row, body, dur };
	}

	/** 生成一条正式消息行（占用序号）；entryId 用于回退时定位会话树节点。 */
	function createMessageRow(kind, label, entryId) {
		seq += 1;
		const { row, body, dur } = createRow(kind, label, { index: seq });
		if (entryId) row.dataset.entryId = entryId;
		appendRow(row);
		return { row, body, dur };
	}

	/** 清空全部消息并复位计数（新建会话时用）。 */
	function clearMessages() {
		messagesEl.replaceChildren();
		resetTimers();
		seq = 0;
		streaming = null;
		thinkingRow = null;
		pendingAssistant = null;
		toolRecords.clear();
		pendingUserRows = [];
		historyRows = 0;
		showEmptyHint();
	}

	/** 空会话显示品牌与现有命令提示；首条消息仍由 appendRow 移除整个引导区。 */
	function showEmptyHint() {
		if (messagesEl.querySelector('.row') || messagesEl.querySelector('.empty')) return;
		const node = document.createElement('section');
		node.className = 'empty';
		const mark = document.createElement('div');
		mark.className = 'empty-mark';
		mark.textContent = 'pi';
		mark.setAttribute('aria-hidden', 'true');
		const title = document.createElement('h2');
		title.className = 'empty-title';
		title.textContent = '从这里开始工作';
		const description = document.createElement('p');
		description.className = 'empty-description';
		description.textContent = '描述任务，pi 会在当前工作目录中处理。可以直接提问，也可以引用文件或添加附件。';
		const shortcuts = document.createElement('ul');
		shortcuts.className = 'empty-shortcuts';
		shortcuts.setAttribute('aria-label', '输入框快捷用法');
		for (const [command, hint] of [['/model', '选择模型与思考等级'], ['/resume', '继续本目录的历史会话'], ['@', '引用工作目录中的文件']]) {
			const item = document.createElement('li');
			item.className = 'empty-shortcut';
			const code = document.createElement('code');
			code.textContent = command;
			const label = document.createElement('span');
			label.textContent = hint;
			item.append(code, label);
			shortcuts.append(item);
		}
		node.append(mark, title, description, shortcuts);
		messagesEl.append(node);
	}

	/** 耗时文本：一分钟内保留一位小数，超过则按 1m03s 给。 */
	function formatDuration(ms) {
		const value = Math.max(0, Number(ms) || 0);
		if (value < 60000) return (value / 1000).toFixed(1) + 's';
		const seconds = Math.round(value / 1000);
		return Math.floor(seconds / 60) + 'm' + String(seconds % 60).padStart(2, '0') + 's';
	}

	/** 把耗时写进某行的身份区；数值无效或行已不在 DOM 里就什么也不做。 */
	function setRowDuration(row, ms, prefix) {
		if (!row || !Number.isFinite(ms)) return;
		const dur = row.querySelector('.gutter .dur');
		if (!dur) return;
		dur.textContent = (prefix || '') + formatDuration(ms);
		dur.hidden = false;
	}

	/** 刷新所有活跃计时器的文本；没有活跃计时器就顺手停掉定时器。 */
	function paintTimers() {
		for (const [row, timer] of liveTimers) {
			setRowDuration(row, timer.baseMs + (Date.now() - timer.baseAt), timer.prefix);
		}
		if (!liveTimers.size && timerHandle) {
			clearInterval(timerHandle);
			timerHandle = 0;
		}
	}

	/** 开一行计时；baseMs 是挂上时已经过去的时间（断线重连后接着跳时非 0）。 */
	function startRowTimer(row, baseMs, prefix) {
		if (!row) return;
		liveTimers.set(row, { baseMs: Math.max(0, Number(baseMs) || 0), baseAt: Date.now(), prefix: prefix || '' });
		if (!timerHandle) timerHandle = setInterval(paintTimers, 100);
		paintTimers();
	}

	/** 定格一行计时；没拿到服务端数值时用本地已经跑过的时间兜底。 */
	function settleRowTimer(row, ms, prefix) {
		if (!row) return;
		const live = liveTimers.get(row);
		liveTimers.delete(row);
		const tag = prefix || (live ? live.prefix : '');
		if (Number.isFinite(ms)) setRowDuration(row, ms, tag);
		else if (live) setRowDuration(row, live.baseMs + (Date.now() - live.baseAt), tag);
		paintTimers();
	}

	/** 清掉全部计时状态（重放历史、新建会话时调用）。 */
	function resetTimers() {
		liveTimers.clear();
		turnTimerRow = null;
		if (timerHandle) {
			clearInterval(timerHandle);
			timerHandle = 0;
		}
	}

	/** 最后一个用户行：回合计时挂它（刚发出的那条提问一定在最后）。 */
	function lastUserRow() {
		const rows = messagesEl.querySelectorAll('.row.user');
		return rows.length ? rows[rows.length - 1] : null;
	}

	/** 按会话条目 id 找行（刷新后把回合计时接回正确的提问行）。 */
	function rowByEntryId(entryId) {
		if (!entryId) return null;
		for (const row of messagesEl.querySelectorAll('.row[data-entry-id]')) {
			if (row.dataset.entryId === entryId) return row;
		}
		return null;
	}

	/** 计时帧：message 挂在当前助手行，turn 挂在本次提问行（回合总耗时跟着提问走）。 */
	function handleTimerFrame(frame) {
		if (frame.scope === 'turn') {
			if (frame.phase === 'start') {
				turnTimerRow = lastUserRow();
				startRowTimer(turnTimerRow, 0, '回合 ');
				return;
			}
			settleRowTimer(turnTimerRow || lastUserRow(), frame.durationMs, '回合 ');
			turnTimerRow = null;
			return;
		}
		// 单条耗时的结束值通常随 message 帧的 durationMs 一起下发，这里只是兼容显式的结束帧
		if (frame.phase === 'end') {
			settleRowTimer(ensurePendingAssistant().row, frame.durationMs);
			return;
		}
		// 先建行再开始跳：等首 token 期间也能看到时间在走
		startRowTimer(ensurePendingAssistant().row, 0);
	}

	/** 取第一行，用作折叠块的摘要。 */
	function firstLine(text) {
		const flat = String(text || '').replace(/\s+/g, ' ').trim();
		return flat.slice(0, 90) || '（空）';
	}

	/** 思考块：默认折叠，摘要显示首行与字数。 */
	function buildThinkBlock(text, open) {
		const details = document.createElement('details');
		details.className = 'think';
		if (open) details.open = true;
		const summary = document.createElement('summary');
		const sum = document.createElement('span');
		sum.className = 'sum';
		sum.textContent = firstLine(text);
		const count = document.createElement('span');
		count.className = 'count';
		count.textContent = String(text || '').length + ' 字';
		summary.append(sum, count);
		const body = document.createElement('div');
		body.className = 'think-text';
		body.textContent = text || '';
		details.append(summary, body);
		return details;
	}

	/** 更新面板计数；记录迁走后清理空面板和空的独立工具行。 */
	function refreshToolPanel(panel) {
		if (!panel) return;
		const entries = [...panel.querySelectorAll('.tool-entry')];
		if (!entries.length) {
			const row = panel.closest('.row.tool');
			panel.remove();
			if (row && !row.querySelector('.body').childElementCount) row.remove();
			return;
		}
		const counts = {};
		for (const entry of entries) counts[entry.dataset.state] = (counts[entry.dataset.state] || 0) + 1;
		panel.querySelector('.execution-stats').textContent = entries.length + ' 个工具 · ' +
			Object.entries(counts).map(([state, count]) => count + ' ' + TOOL_STATES[state][1]).join(' / ');
	}

	/** 刷新单条记录；失败首次出现时展开，后续更新不覆盖用户的折叠选择。 */
	function refreshToolEntry(entry) {
		const wasFailed = entry.details.dataset.state === 'failed';
		const [mark, label] = TOOL_STATES[entry.state];
		entry.details.dataset.state = entry.state;
		entry.marker.textContent = mark;
		entry.nameEl.textContent = entry.name || 'tool';
		entry.nameEl.title = entry.name || 'tool';
		entry.argsEl.textContent = entry.args ? firstLine(entry.args) : entry.hasCall ? '参数未提供' : '未匹配到调用';
		entry.argsEl.title = entry.args || '';
		entry.chip.dataset.state = entry.state;
		entry.chip.textContent = label;
		entry.argumentsEl.hidden = !entry.args;
		entry.argsPre.textContent = entry.args;
		if (entry.hasResult) {
			const lines = entry.text ? entry.text.split('\n').length : 0;
			entry.outputLabel.textContent = '输出 · ' + lines + ' 行 · ' + new TextEncoder().encode(entry.text).length + ' 字节';
			entry.output.textContent = entry.text || '（空输出）';
		} else {
			entry.outputLabel.textContent = '输出';
			entry.output.textContent = entry.state === 'unknown' ? '未收到工具结果，无法确认本次调用的完整输出。' :
				entry.state === 'failed' ? '工具执行失败，等待输出。' :
				entry.state === 'done' ? '工具执行完成，等待输出。' : '等待工具执行结果。';
		}
		if (entry.state === 'failed' && !wasFailed) entry.details.open = true;
		refreshToolPanel(entry.details.closest('.execution-panel'));
	}

	/** 根据完整调用 ID 复用记录；没有 ID 时创建独立记录，绝不按名称猜配。 */
	function getToolEntry(id, name) {
		if (id && toolRecords.has(id)) {
			const entry = toolRecords.get(id);
			if (name) entry.name = name;
			return entry;
		}
		const details = document.createElement('details');
		details.className = 'tool-entry';
		const summary = document.createElement('summary');
		const marker = document.createElement('span');
		marker.className = 'tool-marker';
		marker.setAttribute('aria-hidden', 'true');
		const identity = document.createElement('span');
		identity.className = 'tool-identity';
		const nameEl = document.createElement('span');
		nameEl.className = 'name';
		const argsEl = document.createElement('span');
		argsEl.className = 'args';
		identity.append(nameEl, argsEl);
		const chip = document.createElement('span');
		chip.className = 'chip';
		summary.append(marker, identity, chip);
		const content = document.createElement('div');
		content.className = 'tool-content';
		const argumentsEl = document.createElement('div');
		argumentsEl.className = 'tool-arguments';
		const argsLabel = document.createElement('span');
		argsLabel.className = 'tool-arguments-label';
		argsLabel.textContent = '调用参数';
		const argsPre = document.createElement('pre');
		argumentsEl.append(argsLabel, argsPre);
		const outputLabel = document.createElement('span');
		outputLabel.className = 'tool-output-label';
		const output = document.createElement('pre');
		output.className = 'tool-output';
		content.append(argumentsEl, outputLabel, output);
		details.append(summary, content);
		const entry = {
			id, name: name || 'tool', args: '', text: '', state: 'pending', hasCall: false, hasResult: false,
			details, marker, nameEl, argsEl, chip, argumentsEl, argsPre, outputLabel, output,
		};
		// 无 ID 的记录也能从 DOM 找回，用于中断处理和落定时保留孤立输出。
		details._toolEntry = entry;
		if (id) toolRecords.set(id, entry);
		refreshToolEntry(entry);
		return entry;
	}

	/** 只把相邻调用放进同一面板；遇到正文或思考块就另起面板。 */
	function placeToolEntry(body, entry) {
		const previous = entry.details.closest('.execution-panel');
		let panel = body.lastElementChild;
		if (!panel || !panel.classList.contains('execution-panel')) {
			panel = document.createElement('section');
			panel.className = 'execution-panel';
			panel.setAttribute('aria-label', '工具执行记录');
			const head = document.createElement('div');
			head.className = 'execution-head';
			const title = document.createElement('span');
			title.className = 'execution-title';
			title.textContent = '执行记录';
			const stats = document.createElement('span');
			stats.className = 'execution-stats';
			head.append(title, stats);
			panel.append(head);
			body.append(panel);
		}
		if (previous !== panel) panel.append(entry.details);
		refreshToolEntry(entry);
		if (previous && previous !== panel) refreshToolPanel(previous);
	}

	/** 未找到调用时保留独立工具行；相邻的孤立记录仍可组成一个面板。 */
	function attachStandaloneTool(entry) {
		if (entry.details.isConnected) return entry.details.closest('.row');
		const last = messagesEl.lastElementChild;
		let target;
		if (last && last.matches('.row.tool')) target = { row: last, body: last.querySelector('.body') };
		else {
			target = createRow('tool', 'TOOL');
			appendRow(target.row);
		}
		placeToolEntry(target.body, entry);
		return target.row;
	}

	/** 工具结果回填到相同 ID 的调用下；历史分片、结果先到和重复帧共用此路径。 */
	function acceptToolResult(message, body) {
		const entry = getToolEntry(message.toolCallId, message.toolName || message.name);
		entry.hasResult = true;
		entry.text = String(message.text || '');
		if (typeof message.isError === 'boolean') entry.state = message.isError ? 'failed' : 'done';
		else if (entry.state !== 'done' && entry.state !== 'failed') entry.state = 'unknown';
		refreshToolEntry(entry);
		if (!entry.details.isConnected && body) placeToolEntry(body, entry);
		return attachStandaloneTool(entry);
	}

	/** 按类型渲染内容块，工具状态只依据执行事件或结果，不能把调用本身当成成功。 */
	function addBlock(body, block) {
		const type = block.type || 'other';
		if (type === 'thinking') {
			body.append(buildThinkBlock(block.text || '', false));
			return;
		}
		if (type === 'text') {
			const node = document.createElement('div');
			node.className = 'message-text';
			renderMarkdown(block.text || '', node);
			body.append(node);
			return;
		}
		if (type === 'toolCall') {
			const entry = getToolEntry(block.toolCallId, block.name);
			entry.hasCall = true;
			entry.args = String(block.arguments || block.text || '');
			placeToolEntry(body, entry);
			return;
		}
		if (type === 'toolResult') {
			acceptToolResult(block, body);
			return;
		}
		if (type === 'image') {
			// 历史里的图片由服务端给 /api/image 地址，本地刚发的那条用 blob 缩略图
			const src = block.url || block.objectUrl || '';
			if (!src) return;
			const image = document.createElement('img');
			image.className = 'msg-image';
			image.src = src;
			image.loading = 'lazy';
			image.alt = '已附加图片';
			body.append(image);
			return;
		}
		if (block.text) {
			const node = document.createElement('div');
			node.className = 'misc';
			node.textContent = '[' + type + '] ' + block.text;
			body.append(node);
		}
	}

	/** 技能调用徽标：pi 把 `/skill:名称 参数` 展开后才落盘，页面只回显名称与参数。 */
	function addSkillBadge(body, name) {
		const badge = document.createElement('span');
		badge.className = 'skill-badge';
		badge.textContent = '技能 · ' + name;
		badge.title = '本次提问由技能 ' + name + ' 展开';
		// 徽标固定在正文最前，参数与图片跟在后面
		body.prepend(badge);
	}

	/**
	 * 把本地回显的用户行改画成技能形态：徽标 + 参数。
	 * 本地行原本画的是你敲的 `/skill:名称 参数`；图片块保留，本地缩略图还在用那些 blob URL。
	 */
	function paintSkillRow(row, message) {
		const body = row.querySelector('.body');
		if (!body) return;
		for (const node of [...body.querySelectorAll('.message-text')]) node.remove();
		addSkillBadge(body, message.skill.name);
		const args = String(message.text || '');
		if (args) {
			const node = document.createElement('div');
			node.className = 'message-text';
			renderMarkdown(args, node);
			body.append(node);
		}
	}

	/** 渲染完整历史消息；工具结果只回填，不再追加重复的 TOOL 输出卡。 */
	function renderMessage(message) {
		const role = message.role || 'unknown';
		if (role === 'system') return null;
		if (role === 'toolResult') return acceptToolResult(message);
		const blocks = Array.isArray(message.blocks) ? message.blocks : [];
		const kind = role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : 'status';
		const label = role === 'user' ? 'YOU' : role === 'assistant' ? 'PI' : String(role).toUpperCase();
		if (kind === 'status') {
			const { row, body } = createRow('status', label);
			appendRow(row);
			addBlock(body, { type: 'text', text: message.text || '' });
			return null;
		}
		const { row, body } = createMessageRow(kind, label, message.entryId);
		// 历史帧带落盘的耗时：assistant 是单次模型调用，user 是该回合合计
		if (role === 'assistant') setRowDuration(row, message.durationMs);
		else if (role === 'user') setRowDuration(row, message.turnMs, '回合 ');
		if (message.skill) addSkillBadge(body, message.skill.name);
		if (blocks.length) for (const block of blocks) addBlock(body, block);
		else if (message.text) addBlock(body, { type: 'text', text: message.text });
		return row;
	}

	/** 本地立即显示用户消息（图片用本地 blob 缩略图，不重复渲染服务端回显）；记录正文用于跳过服务端回显。 */
	function addUserMessage(text, images = []) {
		const pinned = pinnedToBottom();
		const { row, body } = createMessageRow('user', 'YOU');
		if (text) addBlock(body, { type: 'text', text });
		for (const image of images) {
			addBlock(body, { type: 'image', objectUrl: image.objectUrl, mimeType: image.mimeType });
		}
		// 记下这一行，等服务端回显时把会话条目 id 补上（也用于跳过回显造成的重复）
		pendingUserRows.push({ text: String(text), row });
		if (pendingUserRows.length > 20) pendingUserRows.shift();
		if (pinned) messagesEl.scrollTop = messagesEl.scrollHeight;
		syncJumpButtons();
	}

	/** 同一条流式助手消息只创建一个身份行，不因思考与工具切换重复占号。 */
	function ensurePendingAssistant() {
		if (!pendingAssistant) pendingAssistant = createMessageRow('assistant', 'PI');
		return pendingAssistant;
	}

	/** 为当前正文段创建纯文本容器，完整消息到达后再按 Markdown 落定。 */
	function ensureStreaming() {
		if (streaming) return streaming;
		const { row, body } = ensurePendingAssistant();
		const textEl = document.createElement('div');
		textEl.className = 'stream-text message-text';
		body.append(textEl);
		streaming = { row, body, textEl, text: '' };
		thinkingRow = null;
		return streaming;
	}

	/** 思考段按出现顺序放在当前助手正文内，生成时展开，落定后恢复默认折叠。 */
	function appendThinking(chunk) {
		if (!thinkingRow) {
			const { row, body } = ensurePendingAssistant();
			const details = buildThinkBlock('', true);
			body.append(details);
			thinkingRow = { row, details, textEl: details.querySelector('.think-text'), countEl: details.querySelector('.count'), text: '' };
			streaming = null;
		}
		thinkingRow.text += chunk;
		thinkingRow.textEl.textContent = thinkingRow.text;
		thinkingRow.countEl.textContent = thinkingRow.text.length + ' 字';
	}

	/** 开始事件更新既有调用；事件先到时建立记录，稍后按 ID 迁回完整消息。 */
	function startToolRow(detail) {
		const entry = getToolEntry(detail.toolCallId, detail.toolName || detail.name);
		entry.hasCall = true;
		if (typeof detail.arguments === 'string') entry.args = detail.arguments;
		if (!entry.hasResult && (entry.state === 'pending' || entry.state === 'unknown')) entry.state = 'running';
		refreshToolEntry(entry);
		if (!entry.details.isConnected && pendingAssistant) placeToolEntry(pendingAssistant.body, entry);
		attachStandaloneTool(entry);
		streaming = null;
		thinkingRow = null;
	}

	/** 结束事件以 isError 为准；标记缺失时不把未知结果伪装为成功。 */
	function endToolRow(detail) {
		const entry = getToolEntry(detail.toolCallId, detail.toolName || detail.name);
		if (!entry.hasResult) {
			entry.state = typeof detail.isError === 'boolean' ? (detail.isError ? 'failed' : 'done') :
				/error|fail|cancel|abort/i.test(String(detail.status || '') + ' ' + String(detail.reason || '')) ? 'failed' : 'unknown';
		}
		refreshToolEntry(entry);
		attachStandaloneTool(entry);
	}

	/** 回合结束或静态历史读完时，将仍未收到结果的调用标为未确认，不猜测成功或失败。 */
	function finishPendingTools() {
		for (const node of messagesEl.querySelectorAll('.tool-entry')) {
			const entry = node._toolEntry;
			if (entry.state === 'pending' || entry.state === 'running') {
				entry.state = 'unknown';
				refreshToolEntry(entry);
			}
			if (!entry.hasResult) entry.output.textContent = '本回合未收到工具输出。展开态及调用信息已保留。';
		}
	}

	/** 落定时复用助手行与工具记录，保留工具展开态、输出、序号和调用归属。 */
	function settleAssistantMessage(message) {
		const target = ensurePendingAssistant();
		const displaced = [...target.body.querySelectorAll('.tool-entry')].map((node) => node._toolEntry);
		target.body.replaceChildren();
		const blocks = Array.isArray(message.blocks) ? message.blocks : [];
		if (blocks.length) for (const block of blocks) addBlock(target.body, block);
		else if (message.text) addBlock(target.body, { type: 'text', text: message.text });
		// 完整消息不含某个临时调用时保留独立记录，不能随重绘一起删除输出。
		for (const entry of displaced) attachStandaloneTool(entry);
		// 单次模型调用耗时：以服务端实测为准，缺了就按本地已经跑过的时间定格
		settleRowTimer(target.row, message.durationMs);
		pendingAssistant = null;
		streaming = null;
		thinkingRow = null;
		return target.row;
	}

	/** 追加一条状态行（事件、插件通知、错误）；kind 取 warn / error，其它按普通状态处理。 */
	function addStatusRow(text, kind) {
		const isError = kind === 'error';
		const isWarn = kind === 'warn';
		const { row, body } = createRow(isError ? 'error' : isWarn ? 'warn' : 'status', isError ? 'ERR' : isWarn ? 'WARN' : 'EV');
		body.textContent = text;
		appendRow(row);
	}

	/** 接收消息区帧；返回是否已处理，不承担会话与浮层调度。 */
	function handleFrame(frame) {
		if (frame.kind === 'history') {
			if (!frame.part) clearMessages();
			for (const message of frame.messages || []) {
				try {
					if (renderMessage(message)) historyRows += 1;
				} catch (err) {
					addStatusRow('history 渲染跳过：' + String((err && err.message) || err), 'error');
				}
			}
			if ((frame.part || 0) === (frame.parts || 1) - 1) {
				if (!historyRows) showEmptyHint();
				if (!isBusy()) finishPendingTools();
			}
			return true;
		}
		if (frame.kind === 'timer') { handleTimerFrame(frame); return true; }
		if (frame.kind === 'delta') {
			const target = ensureStreaming();
			target.text += frame.text;
			target.textEl.textContent = target.text;
			return true;
		}
		if (frame.kind === 'thinking') { appendThinking(frame.text); return true; }
		if (frame.kind !== 'message') return false;
		const message = frame.message || {};
		if (message.role === 'assistant') { settleAssistantMessage(message); return true; }
		if (message.role === 'user' && pendingUserRows.length) {
			// 技能消息落盘的是展开后的全文：先按 `/skill:名称` 精确配对，命中后本地行也改成徽标形态
			const skillHead = message.skill ? '/skill:' + message.skill.name : '';
			const text = String(message.text || '').trim();
			let index = skillHead
				? pendingUserRows.findIndex((item) => item.text.trim().startsWith(skillHead))
				: pendingUserRows.findIndex((item) => item.text.trim() === text);
			// 正文被服务端改写（技能 / 模板展开）时仍按发送顺序配对，保留现有回显语义。
			if (index < 0) index = 0;
			const [pending] = pendingUserRows.splice(index, 1);
			if (pending.row && message.entryId) pending.row.dataset.entryId = message.entryId;
			if (pending.row && message.skill) paintSkillRow(pending.row, message);
			return true;
		}
		renderMessage(message);
		return true;
	}

	/** 刷新或重连时，将活跃回合计时接回对应提问行。 */
	function resumeTurn(context) {
		if (!context.turn || !Number.isFinite(context.turn.startedAt)) return;
		const row = rowByEntryId(context.turn.entryId) || lastUserRow();
		if (row) {
			turnTimerRow = row;
			startRowTimer(row, Date.now() - context.turn.startedAt, '回合 ');
		}
	}

	/** 回合停止时定格本地计时并结束临时生成状态，不删除工具输出。 */
	function finishTurn() {
		if (turnTimerRow) {
			settleRowTimer(turnTimerRow, NaN, '回合 ');
			turnTimerRow = null;
		}
		finishPendingTools();
		pendingAssistant = null;
		streaming = null;
		thinkingRow = null;
	}

	/** 帧处理后按处理前的滚动意图跟随底部，并更新跳转按钮。 */
	function followFrame(follow) {
		if (follow) messagesEl.scrollTop = messagesEl.scrollHeight;
		syncJumpButtons();
	}

	return { clearMessages, showEmptyHint, addStatusRow, addUserMessage, handleFrame, resumeTurn, finishTurn, followFrame, pinnedToBottom, startToolRow, endToolRow };
}
