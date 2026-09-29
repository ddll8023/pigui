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

/** 单帧 SSE 上限：超过则丢弃原文，只发一个截断通知。 */
const MAX_FRAME_BYTES = 256 * 1024;
/** 请求体上限，防止超大 POST。 */
const MAX_BODY_BYTES = 1024 * 1024;
/** 页面文件路径。 */
const PAGE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html');
/** 调试开关：打开后转发全部事件，并输出额外日志。 */
const DEBUG = Boolean(process.env.PIGUI_DEBUG);
/** 默认不转发的高频/噪声事件（页面渲染不需要，只会刷屏）。 */
const QUIET_EVENT_TYPES = new Set(['tool_execution_update', 'message_start', 'turn_start']);

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
		for (const key of ['text', 'content', 'output', 'result']) {
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
 */
function messageView(message) {
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
			if (type === 'toolCall' || raw.arguments) block.arguments = textOfValue(raw.arguments);
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
			blocks.push(block);
		}
	}
	const text = blocks
		.map((block) => block.text)
		.filter(Boolean)
		.join('\n')
		.trim();
	return { role, text, blocks };
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
	const detail = {};
	for (const key of ['toolName', 'name', 'status', 'reason', 'toolCallId']) {
		if (typeof event[key] === 'string') detail[key] = event[key].slice(0, 120);
	}
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
export async function startServer({ sdk, cwd, mode = 'continue', sessionPath = '', port = 0, onLog = () => {} }) {
	/** 已连接的 SSE 客户端。 */
	const clients = new Set();
	/** 当前会话：{ session, unsubscribe }。 */
	let active = null;
	/** 是否正在跑回合（决定新消息走 prompt 还是 steer）。 */
	let busy = false;

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

	/** 当前会话的可公开信息。 */
	function sessionInfo() {
		const session = active?.session;
		const model = session?.model;
		return {
			cwd,
			sessionId: session?.sessionId ?? null,
			sessionFile: session?.sessionFile ?? null,
			model: model?.provider && model?.id ? `${model.provider}/${model.id}` : null,
			thinkingLevel: session?.thinkingLevel ?? null,
			busy,
			pid: process.pid,
		};
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
		broadcast({
			kind: 'session',
			info: { ...sessionInfo(), modelFallbackMessage: modelFallbackMessage || undefined },
		});
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
				const messages = (active?.session?.state?.messages ?? []).map(messageView);
				return send(res, 200, { messages, context: sessionInfo() }, { 'content-type': 'application/json' });
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
				res.write(
					`data: ${JSON.stringify({ kind: 'history', messages: (active?.session?.state?.messages ?? []).map(messageView) })}\n\n`,
				);
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

			if (route === 'POST /api/abort') {
				if (active) await active.session.abort();
				return send(res, 202, { aborted: true }, { 'content-type': 'application/json' });
			}

			if (route === 'POST /api/new') {
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
