/** HTTP API 调度；会话相关接口按 URL 的 ?c= 寻址，保留现有状态码、响应字段与失败语义。 */
import path from 'node:path';
import { send, readJson, messageText, parseImages, serveAsset, IMAGE_MIME_TYPES } from './transport.mjs';
import { historyFrames, skillCommandText } from './protocol.mjs';

/** 允许的请求等级，实际能力仍由 SDK 收敛。 */
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** 中止请求等待回合收尾的上限；超时先返回响应，中止本身继续在后台进行。 */
const ABORT_SETTLE_TIMEOUT_MS = 5000;

/**
 * 等一次中止真正收尾，但最多等 ABORT_SETTLE_TIMEOUT_MS。
 * 超时后不让 abort 的后续失败变成未处理拒绝，也不影响已经返回的响应。
 *
 * @param {Promise<void>} aborting `session.abort()` 返回的 Promise。
 */
async function waitForAbort(aborting) {
	let timer;
	try {
		await Promise.race([
			aborting,
			new Promise((resolve) => {
				timer = setTimeout(resolve, ABORT_SETTLE_TIMEOUT_MS);
			}),
		]);
	} finally {
		clearTimeout(timer);
		// 超时先返回时 aborting 可能还会失败，这里挂一个空 catch 避免未处理拒绝
		aborting.catch(() => {});
	}
}

/** 创建请求处理器；各模块只通过显式接口提供能力。 */
export function createRequestHandler({ sdk, cwd, registry, transport, workspace, externalUsage, close }) {
	/** 取某个会话的历史帧；SSE 重连时即时读取当前分支，不缓存旧历史。 */
	function historyOf(conversation) { return historyFrames(conversation.currentViews()); }

	/**
	 * 解析请求绑定的会话：URL 的 ?c= 指定。
	 * 缺省时回退到最早创建的会话，让未带 id 的旧页面与手工接口调用仍然可用。
	 */
	function resolveConversation(url) {
		const wanted = url.searchParams.get('c') ?? '';
		return wanted ? registry.get(wanted) : registry.first();
	}

	/** 取本次请求绑定的会话；不存在时按 404 抛出。 */
	function requireConversation(url) {
		const conversation = resolveConversation(url);
		if (!conversation) throw Object.assign(new Error('会话不存在或已回收'), { status: 404 });
		return conversation;
	}

	/** 重载或压缩期间不允许会话修改；插件回答、关闭服务和压缩中止走独立入口。 */
	function assertSessionMutable(conversation) {
		if (conversation.isReloading()) {
			throw Object.assign(new Error('资源正在重载，请稍后再试'), { status: 409 });
		}
		if (conversation.isCompacting()) {
			throw Object.assign(new Error('会话正在压缩，请等待结束或先中止'), { status: 409 });
		}
	}

	/** 读取会话修改请求；读请求体期间也可能开始压缩或重载，读完再检查一次。 */
	async function readSessionBody(req, conversation) {
		const body = await readJson(req);
		assertSessionMutable(conversation);
		return body;
	}

	/**
	 * 对话列表条目：只含页面需要的元信息与运行状态。
	 * 标题与修改时间按会话文件从目录列表里取，不为每个对话重放一遍历史。
	 */
	function conversationSummary(conversation, sessionsByPath) {
		const info = conversation.sessionInfo();
		const file = info.sessionFile ? sessionsByPath.get(path.resolve(info.sessionFile)) : null;
		return {
			conversationId: conversation.id,
			sessionId: info.sessionId,
			sessionFile: info.sessionFile,
			model: info.model,
			modelName: info.modelName,
			busy: info.busy,
			compacting: info.compacting,
			// 新对话还没落盘、或目录列表里查不到时为空
			title: typeof file?.firstMessage === 'string' ? file.firstMessage.slice(0, 120) : '',
			modified: file?.modified ?? null,
		};
	}

	/** 按方法与路径调度请求，在统一边界广播和返回未处理异常。 */
	async function handleRequest(req, res) {
		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		const route = `${req.method} ${url.pathname}`;
		try {
			if (await serveAsset(route, res)) return;
			if (req.method === 'POST' && route !== 'POST /api/ui-response' && route !== 'POST /api/shutdown' && route !== 'POST /api/conversations') {
				// 保持重载锁的原边界，只在压缩期间放行中止；锁只约束请求所属的那个会话。
				const conversation = resolveConversation(url);
				if (conversation && (route !== 'POST /api/abort' || conversation.isReloading())) assertSessionMutable(conversation);
			}

			if (route === 'GET /api/context') {
				const conversation = requireConversation(url);
				const sessions = await sdk.SessionManager.list(cwd).catch(() => []);
				return send(
					res,
					200,
					{
						context: conversation.sessionInfo(),
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
				const conversation = requireConversation(url);
				const messages = conversation.currentViews();
				return send(res, 200, { messages, context: conversation.sessionInfo() }, { 'content-type': 'application/json' });
			}

			if (route === 'GET /api/models') {
				const conversation = requireConversation(url);
				if (!conversation.getSession()) await conversation.boot();
				const current = conversation.getSession().model;
				return send(
					res,
					200,
					{
						current: current ? { provider: current.provider, id: current.id } : null,
						default: conversation.defaultModel(),
						models: conversation.availableModels(),
						thinkingLevel: conversation.getSession().thinkingLevel ?? null,
						thinkingLevels: conversation.availableThinkingLevels(conversation.getSession()),
						fast: conversation.fastInfo(),
					},
					{ 'content-type': 'application/json' },
				);
			}

			if (route === 'GET /api/sessions') {
				const sessions = await sdk.SessionManager.list(cwd).catch(() => []);
				return send(res, 200, { sessions }, { 'content-type': 'application/json' });
			}

			// 同进程里的多个对话：列出与新建（页面按 ?c= 绑定其中一个）
			if (route === 'GET /api/conversations') {
				const sessions = await sdk.SessionManager.list(cwd).catch(() => []);
				const sessionsByPath = new Map(sessions.map((info) => [path.resolve(info.path), info]));
				return send(
					res,
					200,
					{ conversations: registry.list().map((conversation) => conversationSummary(conversation, sessionsByPath)) },
					{ 'content-type': 'application/json' },
				);
			}

			if (route === 'POST /api/conversations') {
				const body = await readJson(req);
				if (body?.mode !== undefined && body.mode !== 'new' && body.mode !== 'continue') {
					return send(res, 400, { error: 'mode 只能是 new 或 continue' }, { 'content-type': 'application/json' });
				}
				if (body?.sessionPath !== undefined && typeof body.sessionPath !== 'string') {
					return send(res, 400, { error: 'sessionPath 必须是文本' }, { 'content-type': 'application/json' });
				}
				const sessionPath = body?.sessionPath?.trim() ?? '';
				if (sessionPath) {
					// 与 /api/switch 同一道限制：只允许本工作目录名下的会话文件，避免变成任意文件读取入口
					const sessions = await sdk.SessionManager.list(cwd).catch(() => []);
					if (!sessions.some((info) => path.resolve(info.path) === path.resolve(sessionPath))) {
						return send(res, 404, { error: '该会话不属于当前工作目录' }, { 'content-type': 'application/json' });
					}
				}
				const conversation = await registry.create({ mode: body?.mode, sessionPath });
				return send(
					res,
					201,
					{ id: conversation.id, context: conversation.sessionInfo() },
					{ 'content-type': 'application/json' },
				);
			}

			// 外部额度（Codex 账号额度 / OpenCode Go 套餐用量）：按需拉取，60 秒缓存
			if (route === 'GET /api/usage/external') {
				const refresh = url.searchParams.get('refresh') === '1';
				return send(res, 200, await externalUsage.getExternalUsage(refresh), { 'content-type': 'application/json' });
			}

			// @ 引用文件：只下发相对路径，不读文件内容
			if (route === 'GET /api/files') {
				const index = await workspace.workspaceIndex();
				const files = workspace.searchWorkspaceFiles(index, url.searchParams.get('q') ?? '');
				return send(res, 200, { cwd, files }, { 'content-type': 'application/json' });
			}

			// 历史消息里的图片：按 entryId + 序号从当前会话投影里取原图
			if (route === 'GET /api/image') {
				const conversation = requireConversation(url);
				const entryId = url.searchParams.get('entry') ?? '';
				const index = Math.max(0, Number.parseInt(url.searchParams.get('index') ?? '0', 10) || 0);
				const image = conversation.findSessionImage(entryId, index);
				if (!image) {
					return send(res, 404, { error: '图片不存在或已不在当前上下文里' }, { 'content-type': 'application/json' });
				}
				const mimeType = IMAGE_MIME_TYPES.has(image.mimeType) ? image.mimeType : 'application/octet-stream';
				return send(res, 200, Buffer.from(image.data, 'base64'), { 'content-type': mimeType });
			}

			if (route === 'GET /api/events') {
				const conversation = requireConversation(url);
				return transport.openEvents(req, res, {
					conversationId: conversation.id,
					sessionInfo: conversation.sessionInfo,
					history: () => historyOf(conversation),
					resendPendingUI: conversation.ui.resendPendingUI,
					onConnect: conversation.ui.cancelUIGrace,
					onDisconnect: conversation.ui.scheduleUIGrace,
				});
			}

			if (route === 'POST /api/prompt') {
				const conversation = requireConversation(url);
				const body = await readSessionBody(req, conversation);
				const text = messageText(body);
				// 附件里的图片随消息一起发给 pi（缩放、校验由 pi 自己做）
				const parsed = parseImages(body);
				if (parsed.error) return send(res, 400, { error: parsed.error }, { 'content-type': 'application/json' });
				const images = parsed.images;
				if (!text && !images) return send(res, 400, { error: '消息为空' }, { 'content-type': 'application/json' });
				if (!conversation.getSession()) await conversation.boot();
				const forceSteer = body?.mode === 'steer';
				if (conversation.isBusy() || forceSteer) {
					await conversation.getSession().steer(text, images);
					return send(res, 202, { accepted: true, mode: 'steer' }, { 'content-type': 'application/json' });
				}
				void conversation.getSession()
					.prompt(text, { images })
					.catch(async (err) => {
						const message = String(err?.message ?? err);
						// 运行中直接 prompt 会被拒绝，这里兜底改成 steer，避免消息丢失
						if (/stream|busy|running|in progress|steer/i.test(message)) {
							try {
								await conversation.getSession().steer(text, images);
								return;
							} catch {}
						}
						conversation.broadcast({ kind: 'error', message });
					});
				return send(res, 202, { accepted: true, mode: 'prompt' }, { 'content-type': 'application/json' });
			}

			if (route === 'POST /api/steer') {
				const conversation = requireConversation(url);
				const body = await readSessionBody(req, conversation);
				const text = messageText(body);
				const parsed = parseImages(body);
				if (parsed.error) return send(res, 400, { error: parsed.error }, { 'content-type': 'application/json' });
				if (!text && !parsed.images) return send(res, 400, { error: '消息为空' }, { 'content-type': 'application/json' });
				if (!conversation.getSession()) await conversation.boot();
				await conversation.getSession().steer(text, parsed.images);
				return send(res, 202, { accepted: true }, { 'content-type': 'application/json' });
			}

			if (route === 'POST /api/model') {
				const conversation = requireConversation(url);
				const body = await readSessionBody(req, conversation);
				const provider = typeof body?.provider === 'string' ? body.provider.trim() : '';
				const modelId = typeof body?.id === 'string' ? body.id.trim() : '';
				if (!provider || !modelId) {
					return send(res, 400, { error: '缺少 provider 或 id' }, { 'content-type': 'application/json' });
				}
				if (!conversation.getSession()) await conversation.boot();
				// 只允许切到本机已配鉴权的模型，避免把任意 provider/id 直接塞进会话
				const target = (conversation.getSession().modelRuntime?.getAvailableSnapshot() ?? []).find((model) =>
					conversation.sameModel(model, { provider, id: modelId }),
				);
				if (!target) {
					const error = `模型不在可用列表中：${provider}/${modelId}`;
					return send(res, 404, { error }, { 'content-type': 'application/json' });
				}
				const persist = Boolean(body?.persist);
				try {
					// 默认只改当前会话；persist 才写全局默认模型
					await conversation.getSession().setModel(target, { persist });
				} catch (err) {
					return send(
						res,
						400,
						{ error: String(err?.message ?? err) },
						{ 'content-type': 'application/json' },
					);
				}
				conversation.broadcastSession();
				return send(res, 200, { context: conversation.sessionInfo(), persist }, { 'content-type': 'application/json' });
			}

			if (route === 'POST /api/thinking') {
				const conversation = requireConversation(url);
				const body = await readSessionBody(req, conversation);
				const level = typeof body?.level === 'string' ? body.level.trim() : '';
				if (!THINKING_LEVELS.includes(level)) {
					const error = `不支持的思考等级：${level || '(空)'}`;
					return send(res, 400, { error }, { 'content-type': 'application/json' });
				}
				if (!conversation.getSession()) await conversation.boot();
				if (typeof conversation.getSession().setThinkingLevel !== 'function') {
					return send(
						res,
						400,
						{ error: '当前 pi 版本不支持思考等级切换' },
						{ 'content-type': 'application/json' },
					);
				}
				// setThinkingLevel 会按当前模型能力收敛；只改本会话，不写全局默认
				conversation.getSession().setThinkingLevel(level);
				conversation.broadcastSession();
				return send(res, 200, { context: conversation.sessionInfo() }, { 'content-type': 'application/json' });
			}

			if (route === 'POST /api/fast') {
				const conversation = requireConversation(url);
				const body = await readSessionBody(req, conversation);
				if (typeof body?.enabled !== 'boolean') {
					return send(res, 400, { error: 'enabled 必须是布尔值' }, { 'content-type': 'application/json' });
				}
				if (!conversation.getSession()) await conversation.boot();
				conversation.setFast(body.enabled);
				return send(res, 200, { context: conversation.sessionInfo() }, { 'content-type': 'application/json' });
			}

			if (route === 'POST /api/abort') {
				const conversation = requireConversation(url);
				const session = conversation.getSession();
				// session.abort() 会等回合真正收尾（SDK 的 abort() 内部 await waitForIdle），
				// 而回合可能卡在没传 AbortSignal 的插件对话框上，所以顺序必须是：
				// 先调用 abort()（它在第一个 await 前已打完中止标记并调了 agent.abort()），
				// 再放开对话框，否则两边互等，请求会一直挂到 10 分钟上限。
				// 这是通用顺序：任何要等回合收尾的路径（中止、换会话、重载）都得先放开未决对话框；
				// 换会话 / 重载那一侧在 session.mjs 的 boot() 与 plugin-ui 的 reset()。
				const aborting = session ? session.abort() : null;
				conversation.ui.settleAllUI();
				if (aborting) await waitForAbort(aborting);
				// 中止不一定走到 agent_settled：实时速率在这里直接收尾
				conversation.telemetry.rateReset();
				return send(res, 202, { aborted: true }, { 'content-type': 'application/json' });
			}

			if (route === 'POST /api/rewind') {
				const conversation = requireConversation(url);
				const body = await readSessionBody(req, conversation);
				const entryId = typeof body?.entryId === 'string' ? body.entryId.trim() : '';
				if (!entryId) return send(res, 400, { error: '缺少 entryId' }, { 'content-type': 'application/json' });
				if (!conversation.getSession()) return send(res, 400, { error: '会话尚未就绪' }, { 'content-type': 'application/json' });
				if (typeof conversation.getSession().navigateTree !== 'function') {
					return send(res, 400, { error: '当前 pi 版本不支持会话回退' }, { 'content-type': 'application/json' });
				}
				// 只接受本会话的用户提问：其它节点或别处会话的 id 一律拒绝
				const entry = conversation.getSession().sessionManager?.getEntry?.(entryId);
				if (!entry || entry.type !== 'message' || entry.message?.role !== 'user') {
					return send(res, 404, { error: '只能回退到本会话的用户提问' }, { 'content-type': 'application/json' });
				}
				if (conversation.isBusy() || conversation.getSession().isStreaming) {
					return send(res, 409, { error: '回合运行中，请先中止再回退' }, { 'content-type': 'application/json' });
				}
				// summarize: false —— 被放弃的分支只移出上下文，既不删除也不总结
				const result = await conversation.getSession().navigateTree(entryId, { summarize: false });
				if (result?.cancelled) {
					return send(
						res,
						409,
						{ error: '回退被取消（可能被扩展拦截）' },
						{ 'content-type': 'application/json' },
					);
				}
				conversation.broadcastSession();
				conversation.broadcastHistory();
				const editorText = typeof result?.editorText === 'string' ? result.editorText : '';
				return send(
					res,
					200,
					{
						// 技能消息落盘的是展开后的全文，填回输入框时还原成 `/skill:名称 参数`
						editorText: skillCommandText(editorText, sdk.parseSkillBlock) || editorText,
						context: conversation.sessionInfo(),
					},
					{ 'content-type': 'application/json' },
				);
			}

			if (route === 'POST /api/compact') {
				const conversation = requireConversation(url);
				const body = await readSessionBody(req, conversation);
				if (body?.instructions !== undefined && typeof body.instructions !== 'string') {
					return send(res, 400, { error: '摘要要求必须是文本' }, { 'content-type': 'application/json' });
				}
				try {
					const result = await conversation.compact(body?.instructions?.trim());
					return send(res, 200, {
						result: { tokensBefore: result?.tokensBefore, estimatedTokensAfter: result?.estimatedTokensAfter },
						context: conversation.sessionInfo(),
					}, { 'content-type': 'application/json' });
				} catch (err) {
					const error = String(err?.message ?? err);
					if (error === 'Compaction cancelled') {
						return send(res, 200, { cancelled: true, context: conversation.sessionInfo() }, { 'content-type': 'application/json' });
					}
					const status = err?.status === 400 || err?.status === 409 ? err.status
						: /Already compacted|Nothing to compact/i.test(error) ? 400 : 500;
					// 手动压缩由发起页面展示 HTTP 结果，不再额外广播错误帧。
					return send(res, status, { error }, { 'content-type': 'application/json' });
				}
			}

			if (route === 'POST /api/reload') {
				const conversation = requireConversation(url);
				await conversation.reload();
				return send(res, 200, { context: conversation.sessionInfo() }, { 'content-type': 'application/json' });
			}

			if (route === 'POST /api/new') {
				const conversation = requireConversation(url);
				await conversation.newSession();
				return send(res, 202, { context: conversation.sessionInfo() }, { 'content-type': 'application/json' });
			}

			if (route === 'POST /api/switch') {
				const conversation = requireConversation(url);
				const body = await readSessionBody(req, conversation);
				const wanted = typeof body?.sessionFile === 'string' ? body.sessionFile.trim() : '';
				if (!wanted) return send(res, 400, { error: '缺少 sessionFile' }, { 'content-type': 'application/json' });
				// 只允许切到本工作目录名下的会话，避免被当作任意文件读取入口
				const sessions = await sdk.SessionManager.list(cwd).catch(() => []);
				const found = sessions.find((info) => path.resolve(info.path) === path.resolve(wanted));
				if (!found) {
					return send(res, 404, { error: '该会话不属于当前工作目录' }, { 'content-type': 'application/json' });
				}
				// 同一份 JSONL 被两个对话同时打开会互相干扰，目标是别的对话时就拒绝
				const holder = registry.list().find((item) => item.id !== conversation.id && item.hasSessionFile(found.path));
				if (holder) {
					return send(res, 409, { error: '该会话正被另一个对话打开，请先关掉那个页签' }, { 'content-type': 'application/json' });
				}
				assertSessionMutable(conversation);
				await conversation.switchSession(path.resolve(found.path));
				return send(res, 202, { context: conversation.sessionInfo() }, { 'content-type': 'application/json' });
			}

			if (route === 'POST /api/ui-response') {
				const conversation = requireConversation(url);
				const result = conversation.ui.respond(await readJson(req));
				return send(res, result.status, result.body, { 'content-type': 'application/json' });
			}

			if (route === 'POST /api/shutdown') {
				send(res, 202, { closing: true }, { 'content-type': 'application/json' });
				setTimeout(() => void close(), 50);
				return;
			}

			return send(res, 404, { error: `未知路由: ${route}` }, { 'content-type': 'application/json' });
		} catch (err) {
			const message = String(err?.message ?? err);
			// 400 / 404 / 409 由抛出方声明；其余按未预期错误处理，并发一帧给所有页面
			const status = err?.status === 400 || err?.status === 404 || err?.status === 409 ? err.status : 500;
			if (status === 500) transport.broadcastAll({ kind: 'error', message });
			return send(res, status, { error: message }, { 'content-type': 'application/json' });
		}
	}

	return handleRequest;
}
