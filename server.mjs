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
 */
function eventFrame(event) {
	if (!event || typeof event.type !== 'string') return null;
	if (event.type === 'message_update') {
		const inner = event.assistantMessageEvent;
		if (inner?.type === 'text_delta' && typeof inner.delta === 'string') return { kind: 'delta', text: inner.delta };
		if (inner?.type === 'thinking_delta' && typeof inner.delta === 'string') return { kind: 'thinking', text: inner.delta };
		return null;
	}
	if (!DEBUG && QUIET_EVENT_TYPES.has(event.type)) return null;
	if (event.type === 'message_end') return { kind: 'message', message: messageView(event.message) };
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
 * @param {(text: string) => void} [options.onLog] 日志回调
 */
export async function startServer({ sdk, cwd, mode = 'new', sessionPath = '', port = 0, onLog = () => {} }) {
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
				for (const message of entry?.messages ?? []) views.push(messageView(message, entryId));
			}
			return views;
		}
		// 老版本 SDK 没有 projection：仍然下发历史，只是没有 entryId（页面据此禁用回退）
		return (session?.state?.messages ?? []).map((message) => messageView(message));
	}

	/** 广播当前上下文路径的完整历史（建连、新建/切换会话、回退之后都要让页面重放）。 */
	function broadcastHistory() {
		for (const frame of historyFrames(currentViews())) broadcast(frame);
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
			pid: process.pid,
		};
	}

	/** 广播当前会话上下文（boot、切模型、切思考等级之后都要刷新页面顶栏）。 */
	function broadcastSession(extra = {}) {
		broadcast({ kind: 'session', info: { ...sessionInfo(), ...extra } });
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
		if (active) {
			try {
				active.unsubscribe();
			} catch {}
			try {
				active.session.dispose();
			} catch {}
		}
		const sessionManager = currentSessionManager();
		const { session, modelFallbackMessage } = await sdk.createAgentSession({ cwd, sessionManager });
		const unsubscribe = session.subscribe((event) => {
			if (event?.type === 'agent_start') busy = true;
			if (event?.type === 'agent_settled') busy = false;
			broadcast(eventFrame(event));
		});
		active = { session, unsubscribe };
		busy = false;
		broadcastSession({ modelFallbackMessage: modelFallbackMessage || undefined });
		// 新建 / 切换会话后要让页面立即重放历史（history 帧平时只在 SSE 建连时发一次）
		broadcastHistory();
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
				res.write(`data: ${JSON.stringify({ kind: 'session', info: sessionInfo() })}\n\n`);
				for (const frame of historyFrames(currentViews())) {
					res.write(`data: ${JSON.stringify(frame)}\n\n`);
				}
				const keepAlive = setInterval(() => {
					try {
						res.write(': ping\n\n');
					} catch {}
				}, 15000);
				req.on('close', () => {
					clearInterval(keepAlive);
					clients.delete(res);
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

	/** 关掉所有连接、释放会话与端口。 */
	async function close() {
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
