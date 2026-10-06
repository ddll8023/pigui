/** 页面组装与 SSE 分发；业务状态由各功能模块独立维护。 */
import { apiPath, initConversation } from './conversation.mjs';
import { createSettings } from './settings.mjs';
import { initSheets } from './sheets.mjs';
import { createMessages } from './messages.mjs';
import { createComposer } from './composer.mjs';
import { createSessions } from './sessions.mjs';
import { createModels } from './models.mjs';
import { createNavigation } from './navigation.mjs';
import { createPlugins } from './plugins.mjs';
import { createUsage } from './usage.mjs';
import { createResourceUsage } from './resource-usage.mjs';

const metaEl = document.getElementById('meta');
const projectPathEl = document.getElementById('projectPath');
const modelInfoEl = document.getElementById('modelInfo');
const stateEl = document.getElementById('state');

/** 顶栏状态也是现有输入约束的来源，不引入第二份 busy 状态。 */
function isBusy() {
	return stateEl.dataset.busy === 'true';
}

/** 压缩状态来自会话帧和 SDK 事件；编辑器据此保留未发送内容。 */
function isCompacting() {
	return stateEl.dataset.compacting === 'true';
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
const resourceUsage = createResourceUsage();
// 设置浮层持有页面偏好；用量行的额度入口由它反向调用，避免两个模块互相导入。
let settings;
settings = createSettings({ openUsage: usage.openUsageOverlay });

/** 设置变化后把状态栏开关重新下推给用量行与插件状态。 */
function applyStatusBar(statusBar) {
	usage.setStatusBarVisibility(statusBar);
	plugins.setStatusBarVisibility(statusBar);
}

settings.subscribe(applyStatusBar);
applyStatusBar(settings.getStatusBar());

/** 文件补全让位给原有业务浮层；额度浮层不改变原优先级。 */
function isOverlayOpen() {
	return sessions.isOpen() || navigation.isOpen() || models.isOpen() || plugins.isOpen() || settings.isOpen() || resourceUsage.isOpen();
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
	openSettings: settings.openSettings,
	getFontScale: settings.getFontScale,
	isCompacting,
	isSessionPickerOpen: sessions.isPickerOpen,
	isOverlayOpen,
	handleOverlayKey,
});

/** 按回合和压缩状态更新顶栏；压缩结束不误清仍在执行的自动续跑。 */
function renderRunState() {
	const running = stateEl.dataset.agentBusy === 'true';
	const compacting = isCompacting();
	stateEl.dataset.busy = running || compacting ? 'true' : 'false';
	stateEl.querySelector('.label').textContent = compacting ? '压缩中' : running ? '运行中' : '空闲';
	models.setRunState(running || compacting);
	// 发送键在运行中兼作中止键，由编辑器自己维护外观与禁用态。
	composer.setRunState(running, compacting);
}

/** 更新回合状态，不重绘消息。 */
function setBusy(next) {
	stateEl.dataset.agentBusy = next ? 'true' : 'false';
	renderRunState();
}

/** 同步压缩状态；状态与输入限制共用同一份 DOM 标记。 */
function setCompacting(next) {
	stateEl.dataset.compacting = next ? 'true' : 'false';
	renderRunState();
}

/** 将会话上下文同步到顶栏和功能模块，不共享可变状态容器。 */
function renderContext(context) {
	if (!context) return;
	metaEl.textContent = context.cwd ? context.cwd.split(/[\\/]/).filter(Boolean).pop() || context.cwd : '已连接';
	projectPathEl.textContent = context.cwd || '';
	modelInfoEl.textContent = [context.modelName || context.model, context.thinkingLevel, context.fast?.enabled ? 'Fast 请求' : ''].filter(Boolean).join(' · ') || '未选择模型';
	modelInfoEl.title = [context.model, context.thinkingLevel ? '思考等级：' + context.thinkingLevel : '', context.fast?.enabled ? '已申请 Fast：额外消耗额度，实际服务层未确认，费用仅估算' : '', '点击或输入 /model 切换'].filter(Boolean).join('\n');
	metaEl.title = [
		context.cwd,
		[context.model, context.modelName].filter(Boolean).join(' '),
		context.thinkingLevel ? '思考等级：' + context.thinkingLevel : '',
		context.sessionFile,
	].filter(Boolean).join('\n');
	sessions.setContext(context);
	messages.setContext(context);
	usage.setContext(context);
	models.setContext(context);
	resourceUsage.setContext(context);
	// 技能 / 提示模板 / 插件命令由服务端会话帧给出，页面只把它们并进 `/` 提示条
	composer.setCommands(context.commands);
	setCompacting(context.compacting);
	setBusy(context.busy);
	plugins.noticePlugins(context);
	messages.resumeTurn(context);
}

/** 分发协议帧；无论哪个模块更新 DOM，都保留处理前的滚动意图。 */
function handleFrame(frame) {
	const pinned = messages.pinnedToBottom();
	try {
		if (resourceUsage.handleFrame(frame) || messages.handleFrame(frame) || usage.handleFrame(frame)) return;
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
		// agent_end 之后可能还有压缩与恢复重试，以 SDK 的 settled 作为最终空闲边界。
		if (type === 'agent_end') return;
		if (type === 'agent_settled') {
			setBusy(false);
			messages.finishTurn();
			return;
		}
		if (type === 'compaction_start') {
			setCompacting(true);
			messages.addStatusRow(detail.reason === 'manual' ? '正在压缩上下文…' : '正在自动压缩上下文…');
			return;
		}
		if (type === 'compaction_end') {
			setCompacting(false);
			// 手动结果由发起命令的 HTTP 请求展示，避免重复通知；自动压缩靠 SSE 展示。
			if (detail.reason === 'manual') return;
			if (detail.aborted) messages.addStatusRow('自动压缩已取消');
			else if (detail.errorMessage) messages.addStatusRow('自动压缩失败：' + detail.errorMessage, 'error');
			else if (detail.result) {
				const before = detail.result.tokensBefore;
				const after = detail.result.estimatedTokensAfter;
				const tokens = Number.isFinite(before) && Number.isFinite(after)
					? ` · ${Math.round(before).toLocaleString()} → 约 ${Math.round(after).toLocaleString()} tokens` : '';
				messages.addStatusRow('自动压缩完成' + tokens);
			}
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

/** 对话失效检查的限频间隔：SSE 会按浏览器节奏反复重连，不能每次都打一次接口。 */
const CONVERSATION_CHECK_INTERVAL_MS = 10000;

/** 最近一次检查“对话是否还在服务端”的时刻。 */
let lastConversationCheck = 0;

/**
 * 检查本页签绑定的对话是否还在服务端。
 * 对话因空闲被回收、或服务重启后（页面还开着），SSE 会一直拿到 404 重连下去；
 * 这时刷新页面，由 conversation.mjs 重新新建一个对话并写回地址栏，页面自己恢复。
 */
function verifyConversation() {
	const now = Date.now();
	if (now - lastConversationCheck < CONVERSATION_CHECK_INTERVAL_MS) return;
	lastConversationCheck = now;
	fetch(apiPath('/api/context'))
		.then((response) => {
			if (response.status === 404) window.location.reload();
		})
		.catch(() => {});
}

/** 建立 SSE 连接，保留浏览器自动重连与解析失败降级行为。 */
function connect() {
	const source = new EventSource(apiPath('/api/events'));
	// 保留现有异常降级，单帧失败不阻断后续流。
	source.onmessage = (event) => {
		try {
			handleFrame(JSON.parse(event.data));
		} catch {
			/* 忽略无法解析的帧。 */
		}
	};
	// 断连期间更新顶栏，浏览器负责自动重连；绑定失效时刷新页面换个新对话。
	source.onerror = () => {
		metaEl.textContent = '连接中断，正在重试…';
		setBusy(false);
		verifyConversation();
	};
	return source;
}

initSheets();
settings.init();
sessions.init();
models.init();
plugins.init();
navigation.init();
composer.init();
usage.init();
resourceUsage.init();
messages.showEmptyHint();

/** 先绑定本页签的对话（必要时新建），再用它的上下文填首屏并接上 SSE。 */
async function start() {
	const { context, reason } = await initConversation();
	if (context) renderContext(context);
	// 没绑上对话时接口会由服务端回退到已有对话，这里只把原因说清楚，不静默连错对话
	else if (reason === 'limit') messages.addStatusRow('同时最多 8 个对话，新建失败；请先关掉一些页签', 'error');
	else if (reason === 'unreachable') messages.addStatusRow('本地服务没有响应，正在重试…', 'error');
	connect();
}

void start();
