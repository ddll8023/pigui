/** 页面组装与 SSE 分发；业务状态由各功能模块独立维护。 */
import { initTheme } from './theme.mjs';
import { initSheets } from './sheets.mjs';
import { createMessages } from './messages.mjs';
import { createComposer } from './composer.mjs';
import { createSessions } from './sessions.mjs';
import { createModels } from './models.mjs';
import { createNavigation } from './navigation.mjs';
import { createPlugins } from './plugins.mjs';
import { createUsage } from './usage.mjs';

const metaEl = document.getElementById('meta');
const projectPathEl = document.getElementById('projectPath');
const modelInfoEl = document.getElementById('modelInfo');
const stateEl = document.getElementById('state');

/** 顶栏状态也是现有输入约束的来源，不引入第二份 busy 状态。 */
function isBusy() {
	return stateEl.dataset.busy === 'true';
}

const navigation = createNavigation();
const messages = createMessages({ isBusy, syncJumpButtons: navigation.syncJumpButtons });
// 插件和回退只在初始化完成后的交互中写编辑器，通过注入函数避免循环导入。
let composer;

/** 将插件或回退文本交给编辑器所有者处理。 */
function setEditorText(text, options) {
	composer.setText(text, options);
}

const sessions = createSessions({
	addStatusRow: messages.addStatusRow,
	clearMessages: messages.clearMessages,
	setEditorText,
	isBusy,
});
const models = createModels({ addStatusRow: messages.addStatusRow });
const plugins = createPlugins({ addStatusRow: messages.addStatusRow, setEditorText });
const usage = createUsage();

/** 文件补全让位给原有业务浮层；额度浮层不改变原优先级。 */
function isOverlayOpen() {
	return sessions.isOpen() || navigation.isOpen() || models.isOpen() || plugins.isOpen();
}

/** 保持输入框键位的会话、回退、目录优先级。 */
function handleOverlayKey(event) {
	return sessions.handleInputKey(event) || navigation.handleInputKey(event);
}

composer = createComposer({
	addStatusRow: messages.addStatusRow,
	addUserMessage: messages.addUserMessage,
	pinnedToBottom: messages.pinnedToBottom,
	followFrame: messages.followFrame,
	syncJumpPosition: navigation.syncJumpPosition,
	openSessionPicker: sessions.openSessionPicker,
	openModelPicker: models.openModelPicker,
	openRewind: sessions.openRewind,
	newSession: sessions.newSession,
	isSessionPickerOpen: sessions.isPickerOpen,
	isOverlayOpen,
	handleOverlayKey,
});

/** 更新顶栏运行状态，不重绘消息。 */
function setBusy(next) {
	const busy = Boolean(next);
	stateEl.dataset.busy = busy ? 'true' : 'false';
	stateEl.querySelector('.label').textContent = busy ? '运行中' : '空闲';
}

/** 将会话上下文同步到顶栏和功能模块，不共享可变状态容器。 */
function renderContext(context) {
	if (!context) return;
	metaEl.textContent = context.cwd ? context.cwd.split(/[\\/]/).filter(Boolean).pop() || context.cwd : '已连接';
	projectPathEl.textContent = context.cwd || '';
	modelInfoEl.textContent = [context.modelName || context.model, context.thinkingLevel].filter(Boolean).join(' · ') || '未选择模型';
	modelInfoEl.title = [context.model, context.thinkingLevel ? '思考等级：' + context.thinkingLevel : '', '输入 /model 切换'].filter(Boolean).join('\n');
	metaEl.title = [
		context.cwd,
		[context.model, context.modelName].filter(Boolean).join(' '),
		context.thinkingLevel ? '思考等级：' + context.thinkingLevel : '',
		context.sessionFile,
	].filter(Boolean).join('\n');
	sessions.setContext(context);
	usage.setContext(context);
	models.setContext(context);
	setBusy(context.busy);
	plugins.noticePlugins(context);
	messages.resumeTurn(context);
}

/** 分发协议帧；无论哪个模块更新 DOM，都保留处理前的滚动意图。 */
function handleFrame(frame) {
	const pinned = messages.pinnedToBottom();
	try {
		if (messages.handleFrame(frame) || usage.handleFrame(frame)) return;
		if (frame.kind === 'session') {
			renderContext(frame.info);
			if (frame.info && frame.info.modelFallbackMessage) messages.addStatusRow('提示：' + frame.info.modelFallbackMessage);
			return;
		}
		if (frame.kind === 'ui') {
			plugins.handleUIFrame(frame);
			return;
		}
		if (frame.kind === 'error') {
			messages.addStatusRow(String(frame.message || '未知错误'), 'error');
			return;
		}
		if (frame.kind !== 'event') return;
		const type = frame.type || '';
		const detail = frame.detail || {};
		if (type === 'agent_start') {
			setBusy(true);
			return;
		}
		if (type === 'agent_end' || type === 'agent_settled') {
			setBusy(false);
			messages.finishTurn();
			return;
		}
		if (type === 'turn_start') return;
		if (type === 'tool_execution_start') {
			messages.startToolRow(detail);
			return;
		}
		if (type === 'tool_execution_end') {
			messages.endToolRow(detail);
			return;
		}
		if (type === 'turn_end') {
			const reason = String(detail.reason || '');
			if (reason && !/^(completed|stop|end_turn|tool_use|success)$/i.test(reason)) messages.addStatusRow('回合结束 · ' + reason);
			return;
		}
		if (type === 'thinking_level_changed') {
			models.setThinkingLevel(detail.level);
			return;
		}
		const extra = [detail.name, detail.status, detail.reason].filter(Boolean).join(' · ');
		messages.addStatusRow(type + (extra ? ' · ' + extra : ''), /error|fail/i.test(type) ? 'error' : 'status');
	} finally {
		messages.followFrame(frame.kind === 'history' || pinned);
	}
}

/** 建立 SSE 连接，保留浏览器自动重连与解析失败降级行为。 */
function connect() {
	const source = new EventSource('/api/events');
	// 保留现有异常降级，单帧失败不阻断后续流。
	source.onmessage = (event) => {
		try {
			handleFrame(JSON.parse(event.data));
		} catch {
			/* 忽略无法解析的帧。 */
		}
	};
	// 断连期间更新顶栏，浏览器负责自动重连。
	source.onerror = () => {
		metaEl.textContent = '连接中断，正在重试…';
		setBusy(false);
	};
	return source;
}

initSheets();
initTheme();
sessions.init();
models.init();
plugins.init();
navigation.init();
composer.init();
usage.init();
// 中止入口保留原有的请求失败降级行为。
document.getElementById('abort').addEventListener('click', () => {
	void fetch('/api/abort', { method: 'POST' }).catch(() => {});
});
messages.showEmptyHint();
// 先拉取上下文，随后由 SSE 持续同步。
fetch('/api/context')
	.then((response) => response.json())
	.then((data) => renderContext(data.context))
	.catch(() => {});
connect();
