/**
 * pigui 服务端
 *
 * 作用：把 pi 的 AgentSession（进程内 SDK）暴露成本地 HTTP + SSE 服务，供浏览器页面使用。
 *
 * 设计要点：
 * - 只用 node: 内置模块，无第三方依赖；
 * - pi SDK 由调用方（pigui.mjs）解析后注入，本模块不关心它安装在哪；
 * - cwd 决定工作目录、项目资源发现与会话归属；默认会话目录与 pi / Orca 共用
 *   （~/.pi/agent/sessions/--<编码后的 cwd>--/），因此页面里能看到同目录的历史会话；
 * - 事件只保留前端渲染需要的最小字段，单帧超限会截断，避免工具输出撑爆页面。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** 单帧 SSE 上限：超过则丢弃原文，只发一个截断通知（history 走分片，不受此限）。 */
const MAX_FRAME_BYTES = 256 * 1024;
/** history 分片的目标大小：超过就切成多帧发，避免被单帧上限整体丢弃。 */
const HISTORY_PART_BYTES = 128 * 1024;
/** 单个内容块的文本上限：超出截断，避免工具输出这类几 MB 的内容把一帧撑爆。 */
const MAX_BLOCK_TEXT = 48 * 1024;
/** 请求体上限，防止超大 POST。 */
const MAX_BODY_BYTES = 1024 * 1024;
/** 耗时记录文件的后缀：紧贴会话文件存放，pi 只扫描 *.jsonl，不会把它当会话。 */
const TIMING_SUFFIX = '.timings.json';
/** 单个会话最多保留的耗时记录数，超出按写入时间保留最新的。 */
const MAX_TIMING_RECORDS = 20000;
/** 超过这个天数没被更新的耗时文件会被清理（pigui 自己生成的周边数据，过期即无价值）。 */
const TIMING_KEEP_DAYS = 30;
/** 耗时写盘的合并窗口：一个回合里会记多条，攒一下再写。 */
const TIMING_FLUSH_DELAY_MS = 1000;
/** 等待条目 id 的耗时记录上限：正常一两个事件内就能解析，超出说明解析不上，直接丢弃。 */
const MAX_PENDING_TIMINGS = 50;
/** 页面全断开后，还等这么久再把手上的插件对话框按默认值收尾，避免刷新页面把回合挂死。 */
const UI_DISCONNECT_GRACE_MS = 30000;
/** 单个插件对话框的总上限：插件自己没设超时、或干脆不 await（fire-and-forget）时，超过就按默认值收尾。 */
const UI_ANSWER_TIMEOUT_MS = 10 * 60 * 1000;
/** 1 秒内重复的插件通知只保留第一条（扩展可能在循环里反复通知同一件事）。 */
const UI_NOTICE_DEDUPE_MS = 1000;
/** 标题尾随去抖：有的扩展用动画标题（每十几毫秒改一次），不该每一帧都发到页面。 */
const UI_TITLE_DEBOUNCE_MS = 800;
/** 页面文件路径。 */
const PAGE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html');
/** 调试开关：打开后转发全部事件，并输出额外日志。 */
const DEBUG = Boolean(process.env.PIGUI_DEBUG);
/** 默认不转发的高频/噪声事件（页面渲染不需要，只会刷屏）。 */
const QUIET_EVENT_TYPES = new Set(['tool_execution_update', 'message_start', 'turn_start']);
/** pi 支持的思考等级（与 pi-agent-core 的 ThinkingLevel 一致）。 */
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * 从任意值里尽量抽出文本：字符串直接用，数组按行拼接，对象找常见文本字段。
 * 只用于展示，抽不到就返回空串。
 */
function textOfValue(value, depth = 0) {
	if (typeof value === 'string') return value;
	if (depth > 3 || value === null || value === undefined) return '';
	if (Array.isArray(value)) {
		return value
			.map((item) => textOfValue(item, depth + 1))
			.filter(Boolean)
			.join('\n');
	}
	if (typeof value === 'object') {
		// 注意：pi 的 thinking 块把正文放在 thinking 字段（thinkingSignature 是签名数据，不是文本，不能取）。
		for (const key of ['text', 'content', 'output', 'result', 'thinking']) {
			if (key in value) {
				const inner = textOfValue(value[key], depth + 1);
				if (inner) return inner;
			}
		}
	}
	return '';
}

/**
 * 把 pi 的消息压成 { role, text, blocks }。
 *
 * blocks 保留每块的类型（thinking / text / toolCall / toolResult / …）与 toolCallId，
 * 页面据此可以分区渲染、把工具输出折到对应调用下面；text 是拼好的纯文本，供简单渲染使用。
 * entryId 是这条消息在会话树里所属条目的 id（页面回退时用），取不到时为空串。
 */
function messageView(message, entryId = '') {
	const role = typeof message?.role === 'string' ? message.role : 'unknown';
	const blocks = [];
	if (typeof message?.content === 'string') {
		blocks.push({ type: 'text', text: message.content });
	} else if (Array.isArray(message?.content)) {
		for (const raw of message.content) {
			if (typeof raw === 'string') {
				blocks.push({ type: 'text', text: raw });
				continue;
			}
			if (!raw || typeof raw !== 'object') continue;
			const type = typeof raw.type === 'string' ? raw.type : 'other';
			const block = { type, text: textOfValue(raw) };
			if (raw.arguments !== undefined && raw.arguments !== null) {
				// 工具参数通常是对象（如 { command: "ls" }），转成 JSON 展示；字符串原样使用。
				block.arguments =
					typeof raw.arguments === 'string' ? raw.arguments : JSON.stringify(raw.arguments, null, 2);
			}
			for (const key of ['toolCallId', 'id']) {
				if (typeof raw[key] === 'string' && raw[key]) {
					block.toolCallId = raw[key];
					break;
				}
			}
			for (const key of ['name', 'toolName']) {
				if (typeof raw[key] === 'string' && raw[key]) {
					block.name = raw[key];
					break;
				}
			}
			if (!block.text && block.arguments) block.text = block.arguments;
			// 超大块（例如几 MB 的工具输出）先截断，否则单条消息自己就能撑爆一帧
			for (const key of ['text', 'arguments']) {
				const value = block[key];
				if (typeof value === 'string' && value.length > MAX_BLOCK_TEXT) {
					block[key] = `${value.slice(0, MAX_BLOCK_TEXT)}\n…（已截断，原文 ${value.length} 字节）`;
					block.truncated = true;
				}
			}
			blocks.push(block);
		}
	}
	const text = blocks
		.map((block) => block.text)
		.filter(Boolean)
		.join('\n')
		.trim();
	// entryId 是会话树里这条消息所在条目的 id，页面据此定位回退目标；取不到时为空串
	const view = { role, text, blocks, entryId };
	// 工具结果的归属信息在消息级字段上（content 里只有输出文本），单独带出来供页面展示
	if (role === 'toolResult') {
		view.toolCallId = typeof message?.toolCallId === 'string' ? message.toolCallId : '';
		view.toolName = typeof message?.toolName === 'string' ? message.toolName : '';
		view.isError = Boolean(message?.isError);
	}
	return view;
}

/**
 * 把历史消息切成若干帧：每片不超过 HISTORY_PART_BYTES，片信息放在 part / parts 里。
 *
 * 页面按 part 顺序拼接（part 为 0 时清空重绘），这样几 MB 的长会话也能完整送达，
 * 不会被 MAX_FRAME_BYTES 整体丢弃成 frame_truncated。
 */
function historyFrames(views) {
	const batches = [];
	let batch = [];
	let size = 0;
	for (const view of views) {
		const viewSize = Buffer.byteLength(JSON.stringify(view));
		if (batch.length && size + viewSize > HISTORY_PART_BYTES) {
			batches.push(batch);
			batch = [];
			size = 0;
		}
		batch.push(view);
		size += viewSize;
	}
	if (batch.length || !batches.length) batches.push(batch);
	return batches.map((list, index) => ({
		kind: 'history',
		messages: list,
		part: index,
		parts: batches.length,
	}));
}

/**
 * 把 session 事件压成页面可用的小帧；返回 null 表示这个事件不需要发给页面。
 * 默认过滤高频噪声事件（tool_execution_update / message_start / turn_start），PIGUI_DEBUG=1 时不过滤。
 * extra 是调用方注入的实测信息，目前只有 message_end 的单次耗时 durationMs。
 */
function eventFrame(event, extra) {
	if (!event || typeof event.type !== 'string') return null;
	if (event.type === 'message_update') {
		const inner = event.assistantMessageEvent;
		if (inner?.type === 'text_delta' && typeof inner.delta === 'string') return { kind: 'delta', text: inner.delta };
		if (inner?.type === 'thinking_delta' && typeof inner.delta === 'string') return { kind: 'thinking', text: inner.delta };
		return null;
	}
	if (!DEBUG && QUIET_EVENT_TYPES.has(event.type)) return null;
	if (event.type === 'message_end') {
		const view = messageView(event.message);
		// 耗时是服务端实测的：附在消息视图上，页面据此定格该行的计时
		if (Number.isFinite(extra?.durationMs)) view.durationMs = Math.round(extra.durationMs);
		return { kind: 'message', message: view };
	}
	// 思考等级变更：页面只需其中的 level（顶栏与浮层据此就地更新，不必重放历史）
	if (event.type === 'thinking_level_changed') {
		return { kind: 'event', type: event.type, detail: { level: String(event.level ?? '') } };
	}
	const detail = {};
	for (const key of ['toolName', 'name', 'status', 'reason']) {
		if (typeof event[key] === 'string') detail[key] = event[key].slice(0, 120);
	}
	// 关联 ID 不截短，避免不同调用被合并；参数只供摘要和展开查看，沿用内容块上限。
	if (typeof event.toolCallId === 'string') detail.toolCallId = event.toolCallId;
	if (event.type === 'tool_execution_start' && event.args !== undefined) {
		const args = typeof event.args === 'string' ? event.args : JSON.stringify(event.args);
		if (typeof args === 'string') {
			detail.arguments = args.length > MAX_BLOCK_TEXT ? `${args.slice(0, MAX_BLOCK_TEXT)}\n…（参数已截断）` : args;
		}
	}
	if (event.type === 'tool_execution_end' && typeof event.isError === 'boolean') detail.isError = event.isError;
	return { kind: 'event', type: event.type, detail };
}

/**
 * 启动服务。
 *
 * @param {object} options
 * @param {object} options.sdk          pi SDK 模块（需含 createAgentSession 与 SessionManager）
 * @param {string} options.cwd          工作目录，决定项目资源与会话归属
 * @param {'continue'|'new'} [options.mode] 默认 continue：恢复该目录最近会话，没有则新建
 * @param {string} [options.sessionPath] 显式打开的会话文件（优先于 mode）
 * @param {number} [options.port]       监听端口，0 表示由系统分配
 * @param {boolean} [options.pluginUi]  是否把插件的 ctx.ui 接到页面上（默认 true）
 * @param {(text: string) => void} [options.onLog] 日志回调
 */
export async function startServer({ sdk, cwd, mode = 'new', sessionPath = '', port = 0, pluginUi = true, onLog = () => {} }) {
	/** 已连接的 SSE 客户端。 */
	const clients = new Set();
	/** 当前会话：{ session, unsubscribe }。 */
	let active = null;
	/** 是否正在跑回合（决定新消息走 prompt 还是 steer）。 */
	let busy = false;

	/** 当前上下文路径上的消息视图（带 entryId），回退与历史下发共用同一份顺序。 */
	function currentViews() {
		const session = active?.session;
		const manager = session?.sessionManager;
		// projection 就是 agent.state.messages 的来源，按它配对才能拿到条目 id
		if (typeof manager?.buildSessionProjection === 'function') {
			const views = [];
			for (const entry of manager.buildSessionProjection()?.entries ?? []) {
				const entryId = entry?.sourceEntry?.id ?? '';
				for (const message of entry?.messages ?? []) views.push(withTiming(messageView(message, entryId), entryId));
			}
			return views;
		}
		// 老版本 SDK 没有 projection：仍然下发历史，只是没有 entryId（页面据此禁用回退、也不显示耗时）
		return (session?.state?.messages ?? []).map((message) => withTiming(messageView(message), ''));
	}

	/** 广播当前上下文路径的完整历史（建连、新建/切换会话、回退之后都要让页面重放）。 */
	function broadcastHistory() {
		for (const frame of historyFrames(currentViews())) broadcast(frame);
	}

	/* ---------- 耗时统计 ---------- */

	/**
	 * 会话耗时记录：key 是 `${kind}:${entryId}`，value 是 { ms, at }。
	 * kind 取 assistant（一次模型调用的耗时）或 turn（一个回合的总耗时，entryId 是该回合起始的用户提问）。
	 */
	let timings = new Map();
	/** 已测出耗时、但还没解析出条目 id 的记录，等下一个事件再补。 */
	let pendingTimings = [];
	/** 当前这次模型调用的起始时刻（message_start → message_end）。 */
	let messageTimer = null;
	/** 当前回合：{ startedAt, keyMessage, entryId }；首个 agent_start 开始，agent_settled 结束。 */
	let turn = null;
	/** 写盘合并窗口的句柄，以及「过期清理只做一次」标记。 */
	let timingFlushTimer = null;
	let timingsPruned = false;

	/** 耗时记录的 key。 */
	function timingKey(kind, entryId) {
		return `${kind}:${entryId}`;
	}

	/** 当前会话的耗时文件路径；会话没落到磁盘（老版本 SDK / 内存会话）时返回空串。 */
	function timingFile() {
		const manager = active?.session?.sessionManager;
		const file = typeof manager?.getSessionFile === 'function' ? manager.getSessionFile() : '';
		return typeof file === 'string' && file ? `${file}${TIMING_SUFFIX}` : '';
	}

	/** 取某条耗时（毫秒）；没有记录或没有条目 id 时返回 null。 */
	function timingOf(kind, entryId) {
		if (!entryId) return null;
		const record = timings.get(timingKey(kind, entryId));
		return record ? record.ms : null;
	}

	/** 记一条耗时（只进内存，写盘交给 scheduleFlushTimings）。 */
	function addTiming(kind, entryId, ms) {
		if (!entryId || !Number.isFinite(ms)) return;
		timings.set(timingKey(kind, entryId), { ms: Math.max(0, Math.round(ms)), at: Date.now() });
		scheduleFlushTimings();
	}

	/**
	 * 反查消息在会话树里的条目 id：先比叶子，再按对象身份扫当前分支。
	 * pi 是先发 message_end 事件、之后才写会话文件，所以事件回调里通常查不到，要等下一个事件。
	 */
	function resolveEntryId(message) {
		const manager = active?.session?.sessionManager;
		if (!manager || !message) return '';
		const leaf = typeof manager.getLeafEntry === 'function' ? manager.getLeafEntry() : undefined;
		if (leaf?.message === message) return typeof leaf.id === 'string' ? leaf.id : '';
		const branch = typeof manager.getBranch === 'function' ? manager.getBranch() : [];
		for (const entry of [...branch].reverse()) {
			if (entry?.type === 'message' && entry.message === message) {
				return typeof entry.id === 'string' ? entry.id : '';
			}
		}
		return '';
	}

	/** 把挂起的记录补上条目 id：补到就转正，补不到留到下次（上限之外的直接丢）。 */
	function settlePendingTimings() {
		if (!pendingTimings.length) return;
		const rest = [];
		for (const item of pendingTimings) {
			const entryId = resolveEntryId(item.message);
			if (entryId) addTiming(item.kind, entryId, item.ms);
			else rest.push(item);
		}
		pendingTimings = rest.slice(-MAX_PENDING_TIMINGS);
	}

	/** 攒一下再写盘，避免一个回合里反复写同一个文件。 */
	function scheduleFlushTimings() {
		if (timingFlushTimer) return;
		timingFlushTimer = setTimeout(() => {
			timingFlushTimer = null;
			flushTimings();
		}, TIMING_FLUSH_DELAY_MS);
		timingFlushTimer.unref?.();
	}

	/** 立即把耗时表写盘（换会话、回合结束、退出前调用）；没有会话文件或没有记录时不做任何事。 */
	function flushTimings() {
		if (timingFlushTimer) {
			clearTimeout(timingFlushTimer);
			timingFlushTimer = null;
		}
		const file = timingFile();
		if (!file || !timings.size) return;
		// 裁剪：只保留最近写入的若干条，长会话也不会把文件写大
		const records = [...timings.entries()]
			.map(([key, record]) => {
				const split = key.indexOf(':');
				return { kind: key.slice(0, split), id: key.slice(split + 1), ms: record.ms, at: record.at };
			})
			.sort((a, b) => b.at - a.at)
			.slice(0, MAX_TIMING_RECORDS);
		timings = new Map(records.map((record) => [timingKey(record.kind, record.id), { ms: record.ms, at: record.at }]));
		const payload = JSON.stringify({ version: 1, sessionId: active?.session?.sessionId ?? null, records });
		try {
			// 先写临时文件再改名：中途失败最多丢这一次的耗时，不会留下半截 JSON
			fs.writeFileSync(`${file}.tmp`, payload);
			fs.renameSync(`${file}.tmp`, file);
		} catch (err) {
			if (DEBUG) onLog(`pigui: 耗时写入失败 ${file}：${String(err?.message ?? err)}`);
		}
	}

	/** 读取当前会话的耗时文件；缺失或损坏时按空表处理（耗时是附加信息，不能影响会话）。 */
	function loadTimings() {
		timings = new Map();
		pendingTimings = [];
		const file = timingFile();
		if (!file) return;
		let parsed = null;
		try {
			parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
		} catch {
			parsed = null;
		}
		for (const record of Array.isArray(parsed?.records) ? parsed.records : []) {
			const id = typeof record?.id === 'string' ? record.id : '';
			const kind = record?.kind === 'turn' ? 'turn' : record?.kind === 'assistant' ? 'assistant' : '';
			const ms = Number(record?.ms);
			if (!id || !kind || !Number.isFinite(ms) || ms < 0) continue;
			timings.set(timingKey(kind, id), { ms: Math.round(ms), at: Number(record?.at) || 0 });
		}
		pruneTimings(file);
	}

	/** 清理同一个会话目录里过期的耗时文件；每个进程只扫一次，不动当前会话自己的文件。 */
	function pruneTimings(currentFile) {
		if (timingsPruned) return;
		timingsPruned = true;
		const dir = path.dirname(currentFile);
		const deadline = Date.now() - TIMING_KEEP_DAYS * 24 * 60 * 60 * 1000;
		let names = [];
		try {
			names = fs.readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) {
			if (!name.endsWith(TIMING_SUFFIX)) continue;
			const target = path.join(dir, name);
			if (target === currentFile) continue;
			try {
				if (fs.statSync(target).mtimeMs < deadline) fs.unlinkSync(target);
			} catch {}
		}
	}

	/**
	 * 按 pi 事件维护计时状态，并向页面推 timer 帧；返回值是给 eventFrame 的附加字段。
	 * 口径：单条 = 一次模型调用（message_start → message_end，含等待首 token，不含工具执行）；
	 *       回合 = 首个 agent_start → agent_settled（含工具执行、重试与续跑）。
	 */
	function trackTiming(event) {
		const type = event?.type;
		if (type === 'message_start' && event.message?.role === 'assistant') {
			messageTimer = { startedAt: Date.now() };
			broadcast({ kind: 'timer', scope: 'message', phase: 'start', startedAt: messageTimer.startedAt });
			return null;
		}
		if (type === 'agent_start') {
			// 重试与续跑会再发一次 agent_start，此时仍属同一回合，不重开计时
			if (!turn) {
				turn = { startedAt: Date.now(), keyMessage: null, entryId: '' };
				broadcast({ kind: 'timer', scope: 'turn', phase: 'start', startedAt: turn.startedAt });
			}
			return null;
		}
		if (type === 'agent_settled') {
			settlePendingTimings();
			messageTimer = null;
			if (turn) {
				const ms = Date.now() - turn.startedAt;
				const entryId = turn.entryId || (turn.keyMessage ? resolveEntryId(turn.keyMessage) : '');
				addTiming('turn', entryId, ms);
				broadcast({
					kind: 'timer',
					scope: 'turn',
					phase: 'end',
					durationMs: Math.round(ms),
					startedAt: turn.startedAt,
					entryId,
				});
				turn = null;
			}
			flushTimings();
			return null;
		}
		if (type !== 'message_end') return null;
		// 先给上一条挂起的记录补 id：进到这里说明上一条已经写进会话文件了
		settlePendingTimings();
		const message = event.message;
		if (message?.role === 'assistant' && messageTimer) {
			const durationMs = Date.now() - messageTimer.startedAt;
			messageTimer = null;
			const entryId = resolveEntryId(message);
			if (entryId) addTiming('assistant', entryId, durationMs);
			else pendingTimings.push({ kind: 'assistant', message, ms: durationMs });
			return { durationMs };
		}
		// 回合的归属挂在触发它的那条用户消息上；steer 追加进来的消息不重开回合
		if (message?.role === 'user' && turn && !turn.keyMessage) {
			turn.keyMessage = message;
			turn.entryId = resolveEntryId(message);
		}
		return null;
	}

	/**
	 * 攒着等条目 id 的用户消息回显帧。
	 * pi 是先发 message_end 事件、之后才写会话文件，事件回调里查不到条目 id；
	 * 把这一帧攒到写库之后（下一拍或下一个事件）再发，页面才能给本地那行标上回退目标。
	 */
	let pendingEcho = null;

	/** 暂存一条用户消息回显；先补发上一条，避免连发时丢帧。 */
	function deferUserEcho(message) {
		flushUserEcho();
		pendingEcho = { message, timer: setTimeout(flushUserEcho, 0) };
	}

	/** 把攒着的回显帧补上条目 id 后发出；没有则什么也不做。 */
	function flushUserEcho() {
		if (!pendingEcho) return;
		const { message, timer } = pendingEcho;
		pendingEcho = null;
		if (timer) clearTimeout(timer);
		const frame = eventFrame({ type: 'message_end', message });
		// 查不到 id（极端时序）也照发：退回到“这行暂时不能回退”，不影响消息本身
		if (frame?.message) frame.message.entryId = resolveEntryId(message);
		broadcast(frame);
	}

	/** 正在跑的回合（起始时刻 + 起始用户消息的条目 id）；空闲时为 null，页面据此在刷新后接着计时。 */
	function currentTurnInfo() {
		if (!turn) return null;
		if (!turn.entryId && turn.keyMessage) turn.entryId = resolveEntryId(turn.keyMessage);
		return { startedAt: turn.startedAt, entryId: turn.entryId || '' };
	}

	/** 给历史视图补上落盘的耗时：assistant 挂单次调用耗时，user 挂该回合总耗时。 */
	function withTiming(view, entryId) {
		if (view.role === 'assistant') {
			const ms = timingOf('assistant', entryId);
			if (ms !== null) view.durationMs = ms;
		} else if (view.role === 'user') {
			const ms = timingOf('turn', entryId);
			if (ms !== null) view.turnMs = ms;
		}
		return view;
	}

	/** 按参数决定会话管理器。 */
	function currentSessionManager() {
		const { SessionManager } = sdk;
		if (sessionPath) return SessionManager.open(sessionPath);
		if (mode === 'new') return SessionManager.create(cwd);
		return SessionManager.continueRecent(cwd);
	}

	/** 统一的 JSON / 文本响应。 */
	function send(res, status, body, headers = {}) {
		const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
		res.writeHead(status, { 'cache-control': 'no-store', ...headers });
		res.end(payload);
	}

	/** 向所有页面推一帧 SSE。 */
	function broadcast(frame) {
		if (!frame) return;
		let line = `data: ${JSON.stringify(frame)}\n\n`;
		if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
			line = `data: ${JSON.stringify({ kind: 'event', type: 'frame_truncated' })}\n\n`;
		}
		for (const client of clients) {
			try {
				client.write(line);
			} catch {
				clients.delete(client);
			}
		}
	}

	/** 当前模型支持的思考等级（老版本 SDK 没有该方法时返回空数组，不影响其它路由）。 */
	function availableThinkingLevels(session) {
		return typeof session?.getAvailableThinkingLevels === 'function' ? session.getAvailableThinkingLevels() : [];
	}

	/** 是否成功给插件绑定了可交互的 UI 上下文（声明放在 sessionInfo 之前，避免暂时性死区）。 */
	let pluginUiBound = false;
	/** 当前会话的插件加载错误（只留前几条，页面提示用）。 */
	let pluginErrors = [];

	/** 当前会话的可公开信息。 */
	function sessionInfo() {
		const session = active?.session;
		const model = session?.model;
		return {
			cwd,
			sessionId: session?.sessionId ?? null,
			sessionFile: session?.sessionFile ?? null,
			model: model?.provider && model?.id ? `${model.provider}/${model.id}` : null,
			modelName: model?.name ?? null,
			modelReasoning: Boolean(model?.reasoning),
			contextWindow: model?.contextWindow ?? null,
			thinkingLevel: session?.thinkingLevel ?? null,
			thinkingLevels: availableThinkingLevels(session),
			busy,
			// 正在跑的回合：页面刷新/重连后据此接着跳回合计时
			turn: currentTurnInfo(),
			// 插件是否拿到了可交互的界面（老版本 SDK 没有 bindExtensions、或启动时关了插件界面时为 false）
			pluginUi: pluginUiBound,
			// 插件加载失败列表（页面一次性提示，避免静默失效）
			pluginErrors,
			pid: process.pid,
		};
	}

	/** 广播当前会话上下文（boot、切模型、切思考等级之后都要刷新页面顶栏）。 */
	function broadcastSession(extra = {}) {
		broadcast({ kind: 'session', info: { ...sessionInfo(), ...extra } });
	}

	/* ---------- 插件界面桥接 ---------- */

	/**
	 * 等待页面回答的插件对话框：id → { resolve, method, request, timer, signal, onAbort }。
	 * 一个回合里可能同时有多个（例如先选权限模式、再确认本次修改），在页面里按到达顺序排队。
	 */
	const pendingUI = new Map();
	/** 页面全断开后的收尾计时器。 */
	let uiGraceTimer = null;
	/** 最近一条插件通知，用于 1 秒内相同通知去重。 */
	let lastNotice = { key: '', at: 0 };
	/** 标题去抖的句柄与待发标题。 */
	let uiTitleTimer = null;
	let uiPendingTitle = '';
	/** 对话框 id 的自增序号。 */
	let uiSeq = 0;

	/**
	 * 给插件的主题占位：页面用 CSS 上色，这里不做 ANSI 着色，
	 * 只保证插件调用 theme.fg() / bold() 之类不会报错（返回值是纯文本）。
	 */
	const plainTheme = {
		name: 'pigui-plain',
		fg: (_color, text) => String(text),
		bg: (_color, text) => String(text),
		bold: (text) => String(text),
		italic: (text) => String(text),
		underline: (text) => String(text),
		inverse: (text) => String(text),
		strikethrough: (text) => String(text),
		getFgAnsi: () => '',
		getBgAnsi: () => '',
		getColorMode: () => 'truecolor',
		getThinkingBorderColor: () => (text) => String(text),
		getBashModeBorderColor: () => (text) => String(text),
	};

	/** 对话框被超时、中止或页面断开时的默认返回值（与 pi 的 RPC 模式一致）。 */
	function uiDefault(method) {
		return method === 'confirm' ? false : undefined;
	}

	/** 生成一个对话框 id。 */
	function newUIId() {
		uiSeq += 1;
		return `ui-${uiSeq.toString(36)}-${Date.now().toString(36)}`;
	}

	/** 结束一个挂起的对话框：清掉计时与中止监听，把结果交回插件，并让页面关掉它。 */
	function settleUI(id, value) {
		const entry = pendingUI.get(id);
		if (!entry) return false;
		pendingUI.delete(id);
		if (entry.timer) clearTimeout(entry.timer);
		if (entry.onAbort) entry.signal?.removeEventListener('abort', entry.onAbort);
		broadcast({ kind: 'ui', phase: 'resolved', id });
		entry.resolve(value);
		return true;
	}

	/** 把所有挂起对话框按默认值收尾（页面全断开、进程退出时用）。 */
	function settleAllUI() {
		for (const [id, entry] of [...pendingUI]) settleUI(id, uiDefault(entry.method));
	}

	/** 没有页面接上时启动收尾计时（每次新的等待都重新计时）；有页面接上就取消。 */
	function scheduleUIGrace() {
		if (uiGraceTimer) clearTimeout(uiGraceTimer);
		uiGraceTimer = setTimeout(() => {
			uiGraceTimer = null;
			settleAllUI();
		}, UI_DISCONNECT_GRACE_MS);
	}

	/** 有页面接上：取消收尾计时。 */
	function cancelUIGrace() {
		if (!uiGraceTimer) return;
		clearTimeout(uiGraceTimer);
		uiGraceTimer = null;
	}

	/** 广播一帧单向的插件界面更新（通知、状态、部件、标题、输入框），不需要页面回答。 */
	function pushUI(frame) {
		if (frame.phase === 'notice') {
			// 扩展可能在循环里反复通知同一件事，短时间内的重复只发第一条
			const key = `${frame.level}|${frame.message}`;
			const now = Date.now();
			if (key === lastNotice.key && now - lastNotice.at < UI_NOTICE_DEDUPE_MS) return;
			lastNotice = { key, at: now };
		}
		broadcast({ kind: 'ui', ...frame });
	}

	/**
	 * setTitle 的尾随去抖：只在标题停止变化 800ms 后才发一帧。
	 * 动画标题（例如 Orca 的标题栏 spinner）因此完全不产生帧，而静态标题（会话名、目录名）照常显示。
	 */
	function pushTitle(title) {
		uiPendingTitle = String(title ?? '');
		if (uiTitleTimer) clearTimeout(uiTitleTimer);
		uiTitleTimer = setTimeout(() => {
			uiTitleTimer = null;
			pushUI({ phase: 'title', title: uiPendingTitle });
		}, UI_TITLE_DEBOUNCE_MS);
	}

	/** 立刻补发挂着的标题（换会话前调用，否则那一帧会被丢掉）。 */
	function flushTitle() {
		if (!uiTitleTimer) return;
		clearTimeout(uiTitleTimer);
		uiTitleTimer = null;
		pushUI({ phase: 'title', title: uiPendingTitle });
	}

	/**
	 * 请求页面回答一个对话框（select / confirm / input / editor）。
	 * 没有任何页面能回答时不会当场返回默认值，而是走同一套宽限（见 scheduleUIGrace），
	 * 这样启动阶段（boot 发生在 listen 之前）插件的提问也有机会等到人。
	 */
	function askUI(method, payload, opts) {
		const fallback = uiDefault(method);
		const id = newUIId();
		const request = {
			kind: 'ui',
			phase: 'ask',
			id,
			method,
			...payload,
			timeout: Number.isFinite(opts?.timeout) ? opts.timeout : null,
		};
		// 页面还没接上：先等一段时间，而不是让插件当场拿到默认值
		if (clients.size === 0) scheduleUIGrace();
		return new Promise((resolve) => {
			// 已经中止了就别登记，直接给默认值
			if (opts?.signal?.aborted) {
				resolve(fallback);
				return;
			}
			const entry = { resolve, method, request, signal: opts?.signal, timer: null, onAbort: null };
			// 插件自己的超时优先，但不会超过总上限
			const pluginTimeout = Number.isFinite(opts?.timeout) && opts.timeout > 0 ? opts.timeout : 0;
			entry.timer = setTimeout(
				() => settleUI(id, fallback),
				pluginTimeout ? Math.min(pluginTimeout, UI_ANSWER_TIMEOUT_MS) : UI_ANSWER_TIMEOUT_MS,
			);
			if (opts?.signal) {
				entry.onAbort = () => settleUI(id, fallback);
				opts.signal.addEventListener('abort', entry.onAbort, { once: true });
			}
			pendingUI.set(id, entry);
			broadcast(request);
		});
	}

	/**
	 * 给插件的 UI 上下文：只实现能真的搬到页面上的部分。
	 * 不支持的那部分（TUI 组件工厂、自定义底部栏/头栏、主题切换、自定义编辑器）保持空实现，
	 * 与 pi 的 RPC 模式一致：插件据此走降级路径，而不是以为有真终端、把命令卡在一个永远不会被调用的回调上。
	 */
	function createExtensionUIContext() {
		return {
			select: (title, options, opts) => askUI('select', { title, options: (options ?? []).map(String) }, opts),
			confirm: (title, message, opts) => askUI('confirm', { title, message }, opts),
			input: (title, placeholder, opts) => askUI('input', { title, placeholder }, opts),
			editor: (title, prefill, opts) => askUI('editor', { title, prefill }, opts),
			notify: (message, type) =>
				pushUI({ phase: 'notice', level: type === 'warning' || type === 'error' ? type : 'info', message: String(message ?? '') }),
			// 页面里的输入框只接受完整文本，不支持逐键拦截
			onTerminalInput: () => () => {},
			setStatus: (key, text) => pushUI({ phase: 'status', key: String(key), text: text === undefined ? null : String(text) }),
			setWorkingMessage: () => {},
			setWorkingVisible: () => {},
			setWorkingIndicator: () => {},
			setHiddenThinkingLabel: () => {},
			setWidget: (key, content, options) => {
				// 组件工厂要真终端才能渲染，这里只支持字符串数组（与 pi 的 RPC 模式一致）
				if (content !== undefined && !Array.isArray(content)) return;
				pushUI({
					phase: 'widget',
					key: String(key),
					lines: content ?? null,
					placement: options?.placement === 'belowEditor' ? 'belowEditor' : 'aboveEditor',
				});
			},
			setFooter: () => {},
			setHeader: () => {},
			setTitle: (title) => pushTitle(title),
			// 页面里没有 TUI 覆盖层：返回 undefined，让插件走 select / input 降级路径
			custom: async () => undefined,
			pasteToEditor: (text) => pushUI({ phase: 'editor', text: String(text ?? '') }),
			setEditorText: (text) => pushUI({ phase: 'editor', text: String(text ?? '') }),
			getEditorText: () => '',
			addAutocompleteProvider: () => {},
			setEditorComponent: () => {},
			getEditorComponent: () => undefined,
			get theme() {
				return plainTheme;
			},
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false, error: 'pigui 页面不支持切换插件主题' }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		};
	}

	/** 页面重连时把还在等回答的对话框重发一遍，否则刷新之后就没法回答它了。 */
	function resendPendingUI(res) {
		for (const entry of pendingUI.values()) {
			try {
				res.write(`data: ${JSON.stringify(entry.request)}\n\n`);
			} catch {}
		}
	}

	/** 判断两个模型是否是同一个（provider + id）。 */
	function sameModel(a, b) {
		return Boolean(a && b && a.provider === b.provider && a.id === b.id);
	}

	/** 可用模型的裁剪视图（去掉 headers / compat 等页面用不到、且不宜外发的字段）。 */
	function modelView(model) {
		return {
			provider: model.provider,
			id: model.id,
			name: model.name || model.id,
			reasoning: Boolean(model.reasoning),
			contextWindow: model.contextWindow ?? 0,
			input: Array.isArray(model.input) ? model.input : [],
		};
	}

	/** 已配鉴权的可用模型列表（当前模型置顶，其余按 provider / id 排序）。 */
	function availableModels() {
		const current = active?.session?.model;
		const models = (active?.session?.modelRuntime?.getAvailableSnapshot() ?? []).map(modelView);
		models.sort((a, b) => {
			const aCurrent = sameModel(a, current);
			const bCurrent = sameModel(b, current);
			if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
			if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
			return a.id.localeCompare(b.id);
		});
		return models;
	}

	/** 全局默认模型（settings 里的 provider / id），没设置则返回 null。 */
	function defaultModel() {
		const settings = active?.session?.settingsManager;
		const provider = settings?.getDefaultProvider?.();
		const id = settings?.getDefaultModel?.();
		return provider && id ? { provider, id } : null;
	}

	/**
	 * 建立（或重建）会话：dispose 旧的，按参数开新的，重新订阅事件。
	 */
	async function boot() {
		// 换会话前先把旧会话手上的对话框交回（否则那些 Promise 永远不会被 resolve）、
		// 把耗时的最后一批落盘、挂着的标题补发、攒着的回显帧补发（都依赖 active，必须在替换前调用）
		settleAllUI();
		flushTitle();
		flushUserEcho();
		flushTimings();
		if (active) {
			try {
				active.unsubscribe();
			} catch {}
			try {
				active.session.dispose();
			} catch {}
		}
		const sessionManager = currentSessionManager();
		const { session, modelFallbackMessage, extensionsResult } = await sdk.createAgentSession({
			cwd,
			sessionManager,
			// 插件的 session_start 分支据此区分“新会话 / 恢复会话”
			sessionStartEvent: { type: 'session_start', reason: sessionPath || mode === 'continue' ? 'resume' : 'new' },
		});
		const unsubscribe = session.subscribe((event) => {
			if (event?.type === 'agent_start') busy = true;
			if (event?.type === 'agent_settled') busy = false;
			// 计时和转发在同一个回调里做：实测耗时随这一条 message 帧一起下发
			if (event?.type === 'message_end' && event.message?.role === 'user') {
				// 用户消息回显要等写库后才能取条目 id，先攒起来
				trackTiming(event);
				deferUserEcho(event.message);
				return;
			}
			// 先补发攒着的回显帧，再推这一帧，对外顺序与不延迟时一致
			flushUserEcho();
			broadcast(eventFrame(event, trackTiming(event)));
		});
		active = { session, unsubscribe };
		busy = false;
		messageTimer = null;
		turn = null;
		pluginErrors = (extensionsResult?.errors ?? []).slice(0, 5).map((item) => ({
			path: String(item?.path ?? ''),
			error: String(item?.error ?? ''),
		}));
		loadTimings();
		broadcastSession({ modelFallbackMessage: modelFallbackMessage || undefined });
		// 新建 / 切换会话后要让页面立即重放历史（history 帧平时只在 SSE 建连时发一次）
		broadcastHistory();
		// 给插件绑定页面 UI：要等历史发完再绑，否则插件的 session_start 一上来就弹对话框、
		// 而页面还是空的。mode 传 'rpc'：这是 pi 给“没有真终端、但有对话框原语”的宿主定的模式，
		// 插件据此走 select / input 降级路径；传 'tui' 会让插件去调只在终端可用的覆盖层（例如
		// pi-mcp-adapter 的面板要求 hasUI && mode === 'tui'，在无终端时那个回调永远不会被调用，命令会挂住）。
		if (pluginUi && typeof session.bindExtensions === 'function') {
			try {
				await session.bindExtensions({
					uiContext: createExtensionUIContext(),
					mode: 'rpc',
					onError: (info) =>
						pushUI({ phase: 'notice', level: 'error', message: `插件出错（${info?.event ?? '未知事件'}）：${info?.error ?? ''}` }),
				});
				pluginUiBound = true;
			} catch (err) {
				pluginUiBound = false;
				pushUI({ phase: 'notice', level: 'error', message: `插件界面绑定失败：${String(err?.message ?? err)}` });
			}
		} else {
			// 启动时用 --no-plugin-ui 关掉了，或老版本 SDK 没有这个入口：页面据 sessionInfo().pluginUi 提示
			pluginUiBound = false;
		}
		return active;
	}

	/** 读取并解析 JSON 请求体。 */
	async function readJson(req) {
		const chunks = [];
		let size = 0;
		for await (const chunk of req) {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) throw new Error('请求体过大');
			chunks.push(chunk);
		}
		if (chunks.length === 0) return {};
		return JSON.parse(Buffer.concat(chunks).toString('utf8'));
	}

	/** 取请求体里的消息文本。 */
	function messageText(body) {
		const text = typeof body?.message === 'string' ? body.message.trim() : '';
		return text;
	}

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		const route = `${req.method} ${url.pathname}`;
		try {
			if (route === 'GET /') {
				return send(res, 200, await readFile(PAGE_PATH), { 'content-type': 'text/html; charset=utf-8' });
			}

			if (route === 'GET /api/context') {
				const sessions = await sdk.SessionManager.list(cwd).catch(() => []);
				return send(
					res,
					200,
					{
						context: sessionInfo(),
						sessions: sessions.slice(0, 30).map((info) => ({
							id: info.id,
							path: info.path,
							firstMessage: typeof info.firstMessage === 'string' ? info.firstMessage.slice(0, 80) : '',
						})),
					},
					{ 'content-type': 'application/json' },
				);
			}

			if (route === 'GET /api/messages') {
				const messages = currentViews();
				return send(res, 200, { messages, context: sessionInfo() }, { 'content-type': 'application/json' });
			}

			if (route === 'GET /api/models') {
				if (!active) await boot();
				const current = active.session.model;
				return send(
					res,
					200,
					{
						current: current ? { provider: current.provider, id: current.id } : null,
						default: defaultModel(),
						models: availableModels(),
						thinkingLevel: active.session.thinkingLevel ?? null,
						thinkingLevels: availableThinkingLevels(active.session),
					},
					{ 'content-type': 'application/json' },
				);
			}

			if (route === 'GET /api/sessions') {
				const sessions = await sdk.SessionManager.list(cwd).catch(() => []);
				return send(res, 200, { sessions }, { 'content-type': 'application/json' });
			}

			if (route === 'GET /api/events') {
				res.writeHead(200, {
					'content-type': 'text/event-stream; charset=utf-8',
					'cache-control': 'no-store',
					connection: 'keep-alive',
					'x-accel-buffering': 'no',
				});
				clients.add(res);
				cancelUIGrace();
				res.write(`data: ${JSON.stringify({ kind: 'session', info: sessionInfo() })}\n\n`);
				for (const frame of historyFrames(currentViews())) {
					res.write(`data: ${JSON.stringify(frame)}\n\n`);
				}
				// 刷新/重连后把还在等回答的对话框重发，否则它无从回答
				resendPendingUI(res);
				const keepAlive = setInterval(() => {
					try {
						res.write(': ping\n\n');
					} catch {}
				}, 15000);
				req.on('close', () => {
					clearInterval(keepAlive);
					clients.delete(res);
					// 页面全断开：手上的对话框不能无限等，宽限一段时间后按默认值收尾
					if (clients.size === 0) scheduleUIGrace();
				});
				return;
			}

			if (route === 'POST /api/prompt') {
				const body = await readJson(req);
				const text = messageText(body);
				if (!text) return send(res, 400, { error: '消息为空' }, { 'content-type': 'application/json' });
				if (!active) await boot();
				const forceSteer = body?.mode === 'steer';
				if (busy || forceSteer) {
					await active.session.steer(text);
					return send(res, 202, { accepted: true, mode: 'steer' }, { 'content-type': 'application/json' });
				}
				void active.session
					.prompt(text)
					.catch(async (err) => {
						const message = String(err?.message ?? err);
						// 运行中直接 prompt 会被拒绝，这里兜底改成 steer，避免消息丢失
						if (/stream|busy|running|in progress|steer/i.test(message)) {
							try {
								await active.session.steer(text);
								return;
							} catch {}
						}
						broadcast({ kind: 'error', message });
					});
				return send(res, 202, { accepted: true, mode: 'prompt' }, { 'content-type': 'application/json' });
			}

			if (route === 'POST /api/steer') {
				const body = await readJson(req);
				const text = messageText(body);
				if (!text) return send(res, 400, { error: '消息为空' }, { 'content-type': 'application/json' });
				if (!active) await boot();
				await active.session.steer(text);
				return send(res, 202, { accepted: true }, { 'content-type': 'application/json' });
			}

			if (route === 'POST /api/model') {
				const body = await readJson(req);
				const provider = typeof body?.provider === 'string' ? body.provider.trim() : '';
				const modelId = typeof body?.id === 'string' ? body.id.trim() : '';
				if (!provider || !modelId) {
					return send(res, 400, { error: '缺少 provider 或 id' }, { 'content-type': 'application/json' });
				}
				if (!active) await boot();
				// 只允许切到本机已配鉴权的模型，避免把任意 provider/id 直接塞进会话
				const target = (active.session.modelRuntime?.getAvailableSnapshot() ?? []).find((model) =>
					sameModel(model, { provider, id: modelId }),
				);
				if (!target) {
					const error = `模型不在可用列表中：${provider}/${modelId}`;
					return send(res, 404, { error }, { 'content-type': 'application/json' });
				}
				const persist = Boolean(body?.persist);
				try {
					// 默认只改当前会话；persist 才写全局默认模型
					await active.session.setModel(target, { persist });
				} catch (err) {
					return send(
						res,
						400,
						{ error: String(err?.message ?? err) },
						{ 'content-type': 'application/json' },
					);
				}
				broadcastSession();
				return send(res, 200, { context: sessionInfo(), persist }, { 'content-type': 'application/json' });
			}

			if (route === 'POST /api/thinking') {
				const body = await readJson(req);
				const level = typeof body?.level === 'string' ? body.level.trim() : '';
				if (!THINKING_LEVELS.includes(level)) {
					const error = `不支持的思考等级：${level || '(空)'}`;
					return send(res, 400, { error }, { 'content-type': 'application/json' });
				}
				if (!active) await boot();
				if (typeof active.session.setThinkingLevel !== 'function') {
					return send(
						res,
						400,
						{ error: '当前 pi 版本不支持思考等级切换' },
						{ 'content-type': 'application/json' },
					);
				}
				// setThinkingLevel 会按当前模型能力收敛；只改本会话，不写全局默认
				active.session.setThinkingLevel(level);
				broadcastSession();
				return send(res, 200, { context: sessionInfo() }, { 'content-type': 'application/json' });
			}

			if (route === 'POST /api/abort') {
				if (active) await active.session.abort();
				// 中止后有的插件还挂在对话框上（没传 AbortSignal 的那种），不放开它们这个回合就结束不了
				settleAllUI();
				return send(res, 202, { aborted: true }, { 'content-type': 'application/json' });
			}

			if (route === 'POST /api/rewind') {
				const body = await readJson(req);
				const entryId = typeof body?.entryId === 'string' ? body.entryId.trim() : '';
				if (!entryId) return send(res, 400, { error: '缺少 entryId' }, { 'content-type': 'application/json' });
				if (!active) return send(res, 400, { error: '会话尚未就绪' }, { 'content-type': 'application/json' });
				if (typeof active.session.navigateTree !== 'function') {
					return send(res, 400, { error: '当前 pi 版本不支持会话回退' }, { 'content-type': 'application/json' });
				}
				// 只接受本会话的用户提问：其它节点或别处会话的 id 一律拒绝
				const entry = active.session.sessionManager?.getEntry?.(entryId);
				if (!entry || entry.type !== 'message' || entry.message?.role !== 'user') {
					return send(res, 404, { error: '只能回退到本会话的用户提问' }, { 'content-type': 'application/json' });
				}
				if (busy || active.session.isStreaming) {
					return send(res, 409, { error: '回合运行中，请先中止再回退' }, { 'content-type': 'application/json' });
				}
				// summarize: false —— 被放弃的分支只移出上下文，既不删除也不总结
				const result = await active.session.navigateTree(entryId, { summarize: false });
				if (result?.cancelled) {
					return send(
						res,
						409,
						{ error: '回退被取消（可能被扩展拦截）' },
						{ 'content-type': 'application/json' },
					);
				}
				broadcastSession();
				broadcastHistory();
				return send(
					res,
					200,
					{ editorText: typeof result?.editorText === 'string' ? result.editorText : '', context: sessionInfo() },
					{ 'content-type': 'application/json' },
				);
			}

			if (route === 'POST /api/new') {
				sessionPath = ''; // 清掉显式会话，否则新建时会一直打开它
				mode = 'new';
				await boot();
				return send(res, 202, { context: sessionInfo() }, { 'content-type': 'application/json' });
			}

			if (route === 'POST /api/switch') {
				const body = await readJson(req);
				const wanted = typeof body?.sessionFile === 'string' ? body.sessionFile.trim() : '';
				if (!wanted) return send(res, 400, { error: '缺少 sessionFile' }, { 'content-type': 'application/json' });
				// 只允许切到本工作目录名下的会话，避免被当作任意文件读取入口
				const sessions = await sdk.SessionManager.list(cwd).catch(() => []);
				const found = sessions.find((info) => path.resolve(info.path) === path.resolve(wanted));
				if (!found) {
					return send(res, 404, { error: '该会话不属于当前工作目录' }, { 'content-type': 'application/json' });
				}
				sessionPath = path.resolve(found.path);
				await boot();
				return send(res, 202, { context: sessionInfo() }, { 'content-type': 'application/json' });
			}

			if (route === 'POST /api/ui-response') {
				const body = await readJson(req);
				const id = typeof body?.id === 'string' ? body.id : '';
				if (!id) return send(res, 400, { error: '缺少对话框 id' }, { 'content-type': 'application/json' });
				const entry = pendingUI.get(id);
				if (!entry) return send(res, 404, { error: '该对话框已结束或不存在' }, { 'content-type': 'application/json' });
				// 三种回答形态与 pi 的 RPC 协议一致：value / confirmed / cancelled
				if (body?.cancelled === true) settleUI(id, uiDefault(entry.method));
				else if (typeof body?.confirmed === 'boolean') settleUI(id, body.confirmed);
				else if (typeof body?.value === 'string') settleUI(id, body.value);
				else settleUI(id, uiDefault(entry.method));
				return send(res, 200, { ok: true }, { 'content-type': 'application/json' });
			}

			if (route === 'POST /api/shutdown') {
				send(res, 202, { closing: true }, { 'content-type': 'application/json' });
				setTimeout(() => void close(), 50);
				return;
			}

			return send(res, 404, { error: `未知路由: ${route}` }, { 'content-type': 'application/json' });
		} catch (err) {
			const message = String(err?.message ?? err);
			broadcast({ kind: 'error', message });
			return send(res, 500, { error: message }, { 'content-type': 'application/json' });
		}
	});

	await boot();
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', resolve);
	});
	const actualPort = server.address().port;
	const serviceUrl = `http://127.0.0.1:${actualPort}/`;
	onLog(`pigui: ${serviceUrl}`);
	// 退出前再兜一次，避免最后一个回合的耗时只停在合并窗口里
	process.once('exit', () => flushTimings());

	/** 关掉所有连接、释放会话与端口。 */
	async function close() {
		// 进程要走了，手上的对话框按默认值交回插件，不让对方悬着
		settleAllUI();
		cancelUIGrace();
		if (uiTitleTimer) clearTimeout(uiTitleTimer);
		flushUserEcho();
		flushTimings();
		for (const client of clients) {
			try {
				client.end();
			} catch {}
		}
		clients.clear();
		try {
			active?.unsubscribe();
		} catch {}
		try {
			active?.session?.dispose();
		} catch {}
		await new Promise((resolve) => server.close(resolve));
	}

	return { port: actualPort, url: serviceUrl, close, boot, sessionInfo };
}
