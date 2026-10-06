/** 模型、思考等级与 Codex Fast 请求设置。 */
import { apiPath } from './conversation.mjs';
import { enterSheet, leaveSheet, bindSheetKeys, chip } from './sheets.mjs';

/** 创建模型与思考等级选择；状态由实例自己维护。 */
export function createModels({ addStatusRow }) {
	const modelCloseEl = document.getElementById('modelClose');
	const modelInfoEl = document.getElementById('modelInfo');
	const modelOverlayEl = document.getElementById('modelOverlay');
	const modelSearchEl = document.getElementById('modelSearch');
	const thinkBarEl = document.getElementById('thinkBar');
	const modelListEl = document.getElementById('modelList');
	const fastBarEl = document.createElement('div');
	fastBarEl.className = 'think-bar';

	/** 模型浮层（/model）状态。 */
	let modelOpen = false;

	let modelItems = [];

	let modelVisible = [];

	let modelIndex = 0;

	let modelQuery = '';

	let modelNotice = '';

	let thinkLevels = [];

	let thinkLevel = '';

	/** 服务端开关只是请求设置；未收到响应前不宣称 Fast 已实际生效。 */
	let fastState = { supported: false, enabled: false };
	let fastUpdating = false;
	let fastLocked = false;

	/** 当前模型 / 全局默认模型的 provider/id（用于列表标记）。 */
	let currentModelKey = '';

	let defaultModelKey = '';

	/** 模型唯一标识（provider/id）。 */
	function modelKey(model) {
		return model && model.provider && model.id ? model.provider + '/' + model.id : '';
	}

	/** 上下文窗口的短格式：200000 → 200K。 */
	function formatContext(tokens) {
		const size = Number(tokens) || 0;
		return size >= 1000 ? Math.round(size / 1000) + 'K' : String(size);
	}

	/** 渲染思考等级条：点击即生效，只改本会话。 */
	function renderThinkBar() {
		thinkBarEl.replaceChildren();
		const label = document.createElement('span');
		label.className = 'think-label';
		label.textContent = '思考等级';
		thinkBarEl.append(label);
		if (!thinkLevels.length) {
			const none = document.createElement('span');
			none.className = 'think-chip';
			none.dataset.plain = 'true';
			none.textContent = '当前模型不支持思考';
			thinkBarEl.append(none);
			return;
		}
		for (const level of thinkLevels) {
			const chip = document.createElement('button');
			chip.type = 'button';
			chip.className = 'think-chip';
			chip.dataset.active = String(level === thinkLevel);
			chip.textContent = level;
			chip.addEventListener('click', () => void applyThinkingLevel(level));
			thinkBarEl.append(chip);
		}
	}

	/** 复用等级条样式显示服务层请求选项；不用本地存储持久化开关。 */
	function renderFastBar() {
		fastBarEl.replaceChildren();
		const label = document.createElement('span');
		label.className = 'think-label';
		label.textContent = '速度请求';
		fastBarEl.append(label);
		for (const enabled of [false, true]) {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'think-chip';
			button.textContent = enabled ? 'Fast' : 'Standard';
			const selected = enabled === fastState.enabled;
			button.dataset.active = String(selected);
			button.setAttribute('aria-pressed', String(selected));
			button.disabled = !fastState.supported || fastLocked || fastUpdating;
			button.title = !fastState.supported ? '当前模型或 SDK 不支持 Codex Fast 请求设置'
				: fastLocked ? '请等待会话运行或压缩结束' : '只改当前会话，从下一次请求生效';
			button.addEventListener('click', () => void applyFast(enabled));
			fastBarEl.append(button);
		}
		const note = document.createElement('span');
		note.className = 'think-label';
		note.textContent = fastState.supported
			? 'Fast 额外消耗额度；实际服务层未确认，费用仅估算'
			: '仅 Codex 可设置，需 SDK 支持';
		fastBarEl.append(note);
	}

	/** 渲染模型列表（按搜索词过滤、当前项高亮；置顶排序由服务端保证）。 */
	function renderModelPicker() {
		modelListEl.replaceChildren();
		/** 在模型列表中显示加载、无匹配或读取失败提示。 */
		const plain = (text) => {
			const item = document.createElement('li');
			item.className = 'picker-item plain';
			item.textContent = text;
			modelListEl.append(item);
		};
		if (modelNotice) return plain(modelNotice);
		const query = modelQuery.trim().toLowerCase();
		const visible = modelItems.filter(
			(model) =>
				!query ||
				(model.provider + '/' + model.id + ' ' + (model.name || '')).toLowerCase().includes(query),
		);
		modelVisible = visible;
		if (!visible.length) return plain(modelItems.length ? '没有匹配的模型' : '本机没有已配鉴权的模型');
		if (modelIndex >= visible.length || modelIndex < 0) modelIndex = 0;
		visible.forEach((model, index) => {
			const item = document.createElement('li');
			item.className = 'picker-item two-line';
			item.dataset.active = String(index === modelIndex);
			const mark = document.createElement('span');
			mark.className = 'mark';
			mark.textContent = modelKey(model) === currentModelKey ? '●' : '';
			const main = document.createElement('span');
			main.className = 'main';
			const title = document.createElement('span');
			title.className = 'title';
			title.textContent = model.name && model.name !== model.id ? model.name : modelKey(model);
			title.title = modelKey(model) + (model.name && model.name !== model.id ? ' · ' + model.name : '');
			const meta = document.createElement('span');
			meta.className = 'meta';
			const source = document.createElement('span');
			source.textContent = model.provider + ' · ' + model.id;
			meta.append(
				...[source, chip('思考', Boolean(model.reasoning)), chip(formatContext(model.contextWindow), Boolean(model.contextWindow)), chip('默认', modelKey(model) === defaultModelKey, 'accent')].filter(Boolean),
			);
			main.append(title, meta);
			item.append(mark, main);
			item.addEventListener('click', () => void switchModel(model, false));
			modelListEl.append(item);
		});
		const active = modelListEl.children[modelIndex];
		if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
	}

	/** 打开模型浮层（/model 触发；prefill 作为搜索词预填）。 */
	async function openModelPicker(prefill) {
		if (modelOpen) return;
		modelOpen = true;
		modelOverlayEl.hidden = false;
		// 焦点先给搜索框（模型列表的主要入口就是搜索）
		enterSheet(modelOverlayEl, modelSearchEl);
		modelQuery = String(prefill || '');
		modelSearchEl.value = modelQuery;
		modelItems = [];
		modelVisible = [];
		modelIndex = 0;
		modelNotice = '正在读取模型列表…';
		renderThinkBar();
		renderFastBar();
		renderModelPicker();
		modelSearchEl.focus();
		modelSearchEl.setSelectionRange(modelQuery.length, modelQuery.length);
		let data = null;
		try {
			data = await (await fetch(apiPath('/api/models'))).json();
		} catch {
			if (modelOpen) {
				modelNotice = '读取模型列表失败';
				renderModelPicker();
			}
			return;
		}
		// 拉取期间用户可能已经关掉浮层
		if (!modelOpen) return;
		modelItems = Array.isArray(data && data.models) ? data.models : [];
		currentModelKey = modelKey(data && data.current) || currentModelKey;
		defaultModelKey = modelKey(data && data.default);
		thinkLevels = Array.isArray(data && data.thinkingLevels) ? data.thinkingLevels : [];
		thinkLevel = String((data && data.thinkingLevel) || thinkLevel || '');
		fastState = { supported: Boolean(data?.fast?.supported), enabled: Boolean(data?.fast?.enabled) };
		modelNotice = '';
		const at = modelItems.findIndex((model) => modelKey(model) === currentModelKey);
		modelIndex = at >= 0 ? at : 0;
		renderThinkBar();
		renderFastBar();
		renderModelPicker();
	}

	/** 关闭模型浮层，把焦点还给输入框。 */
	function closeModelPicker() {
		if (!modelOpen) return;
		modelOpen = false;
		modelNotice = '';
		modelOverlayEl.hidden = true;
		leaveSheet(modelOverlayEl);
	}

	/** 上下键在模型列表里移动。 */
	function moveModel(delta) {
		if (!modelVisible.length) return;
		modelIndex = (modelIndex + delta + modelVisible.length) % modelVisible.length;
		renderModelPicker();
	}

	/** 左右键在思考等级条里移动（立即生效）。 */
	function moveThinking(delta) {
		if (!thinkLevels.length) return;
		const at = thinkLevels.indexOf(thinkLevel);
		const base = at >= 0 ? at : 0;
		void applyThinkingLevel(thinkLevels[(base + delta + thinkLevels.length) % thinkLevels.length]);
	}

	/** 切换模型；persist 为 true 时同时写入全局默认模型。 */
	async function switchModel(model, persist) {
		if (!model) return;
		const key = modelKey(model);
		try {
			const response = await fetch(apiPath('/api/model'), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ provider: model.provider, id: model.id, persist: Boolean(persist) }),
			});
			const data = await response.json().catch(() => ({}));
			if (!response.ok) {
				addStatusRow('切换模型失败：' + (data.error || 'HTTP ' + response.status), 'error');
				return;
			}
			currentModelKey = key;
			if (persist) defaultModelKey = key;
			closeModelPicker();
			addStatusRow((persist ? '已设为默认模型 → ' : '已切换模型 → ') + key);
		} catch (err) {
			addStatusRow('切换模型失败：' + String((err && err.message) || err), 'error');
		}
	}

	/** 切换当前会话的思考等级（不写全局默认）。 */
	async function applyThinkingLevel(level) {
		if (!level || level === thinkLevel) return;
		try {
			const response = await fetch(apiPath('/api/thinking'), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ level }),
			});
			const data = await response.json().catch(() => ({}));
			if (!response.ok) {
				addStatusRow('切换思考等级失败：' + (data.error || 'HTTP ' + response.status), 'error');
				return;
			}
			// 服务端可能把等级收敛到该模型支持的范围，以返回值为准
			thinkLevel = String((data.context && data.context.thinkingLevel) || level);
			renderThinkBar();
			// 等级条会被整体重绘，点选胶囊后把焦点交回搜索框，键盘操作才不会断
			if (modelOpen) modelSearchEl.focus();
			addStatusRow('思考等级 → ' + thinkLevel);
		} catch (err) {
			addStatusRow('切换思考等级失败：' + String((err && err.message) || err), 'error');
		}
	}

	/** 请求后端切换服务层；失败时保留服务端回显的原设置。 */
	async function applyFast(enabled) {
		if (!fastState.supported || fastUpdating || fastLocked || enabled === fastState.enabled) return;
		fastUpdating = true;
		renderFastBar();
		try {
			const response = await fetch(apiPath('/api/fast'), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ enabled }),
			});
			const data = await response.json().catch(() => ({}));
			if (!response.ok) {
				addStatusRow('切换速度请求失败：' + (data.error || 'HTTP ' + response.status), 'error');
				return;
			}
			setContext(data.context);
			addStatusRow(fastState.enabled
				? '已设置 Fast 请求（额外消耗额度，实际服务层未确认）'
				: '已设置 Standard 请求（不再主动注入 Fast）');
		} catch (err) {
			addStatusRow('切换速度请求失败：' + String(err?.message || err), 'error');
		} finally {
			fastUpdating = false;
			renderFastBar();
			if (modelOpen) modelSearchEl.focus();
		}
	}

	/** 同步模型、等级和速度请求；会话帧不覆盖全局默认模型标记。 */
	function setContext(context) {
		currentModelKey = context.model || '';
		thinkLevel = context.thinkingLevel || thinkLevel;
		fastState = { supported: Boolean(context.fast?.supported), enabled: Boolean(context.fast?.enabled) };
		fastLocked = Boolean(context.busy || context.compacting);
		if (modelOpen) {
			renderThinkBar();
			renderFastBar();
		}
	}

	/** 回合事件不总带会话帧，独立同步锁状态，结束后及时恢复按钮。 */
	function setRunState(locked) {
		fastLocked = Boolean(locked);
		if (modelOpen) renderFastBar();
	}

	/** 同步服务端等级变更，并刷新已打开的等级条。 */
	function setThinkingLevel(level) {
		if (!level) return;
		thinkLevel = String(level);
		if (modelOpen) renderThinkBar();
	}

	/** 模型浮层打开时文件补全应让位。 */
	function isOpen() { return modelOpen; }

	/** 初始化搜索、模型键位和浮层关闭操作。 */
	function init() {
		/** 顶栏模型区与 /model 共用同一浮层：再点一次即收起。 */
		modelInfoEl.addEventListener('click', () => {
			if (modelOpen) closeModelPicker();
			else void openModelPicker('');
		});
		thinkBarEl.after(fastBarEl);
		modelSearchEl.addEventListener('input', () => {
			modelQuery = modelSearchEl.value; modelIndex = 0; renderModelPicker();
		});
		modelSearchEl.addEventListener('keydown', (event) => {
			if (event.key === 'Escape') { event.preventDefault(); closeModelPicker(); }
			else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault(); moveModel(event.key === 'ArrowDown' ? 1 : -1);
			} else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
				event.preventDefault(); moveThinking(event.key === 'ArrowRight' ? 1 : -1);
			} else if (event.key === 'Enter') {
				event.preventDefault();
				const model = modelVisible[modelIndex];
				if (model) void switchModel(model, event.ctrlKey || event.metaKey);
			}
		});
		modelOverlayEl.addEventListener('click', (event) => { if (event.target === modelOverlayEl) closeModelPicker(); });
		modelCloseEl.addEventListener('click', closeModelPicker);
		document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && modelOpen) closeModelPicker(); });
		bindSheetKeys(modelOverlayEl, moveModel, (event) => {
			const model = modelVisible[modelIndex];
			if (model) void switchModel(model, event.ctrlKey || event.metaKey);
		}, moveThinking);
	}

	return { init, setContext, setRunState, setThinkingLevel, isOpen, openModelPicker };
}
