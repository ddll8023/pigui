/** HTTP API 调度；保留现有状态码、响应字段与失败语义。 */
import path from 'node:path';
import { send, readJson, messageText, parseImages, serveAsset, IMAGE_MIME_TYPES } from './transport.mjs';
import { historyFrames } from './protocol.mjs';

/** 允许的请求等级，实际能力仍由 SDK 收敛。 */
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** 创建请求处理器；各模块只通过显式接口提供能力。 */
export function createRequestHandler({ sdk, cwd, runtime, transport, ui, telemetry, workspace, externalUsage, close }) {
	const broadcast = transport.broadcast;

	/** SSE 重连时即时读取当前分支，不缓存旧会话历史。 */
	function currentHistory() { return historyFrames(runtime.currentViews()); }

	/** 按方法与路径调度请求，在统一边界广播和返回未处理异常。 */
	async function handleRequest(req, res) {
		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		const route = `${req.method} ${url.pathname}`;
		try {
			if (await serveAsset(route, res)) return;

			if (route === 'GET /api/context') {
				const sessions = await sdk.SessionManager.list(cwd).catch(() => []);
				return send(
					res,
					200,
					{
						context: runtime.sessionInfo(),
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
				const messages = runtime.currentViews();
				return send(res, 200, { messages, context: runtime.sessionInfo() }, { 'content-type': 'application/json' });
			}

			if (route === 'GET /api/models') {
				if (!runtime.getSession()) await runtime.boot();
				const current = runtime.getSession().model;
				return send(
					res,
					200,
					{
						current: current ? { provider: current.provider, id: current.id } : null,
						default: runtime.defaultModel(),
						models: runtime.availableModels(),
						thinkingLevel: runtime.getSession().thinkingLevel ?? null,
						thinkingLevels: runtime.availableThinkingLevels(runtime.getSession()),
					},
					{ 'content-type': 'application/json' },
				);
			}

			if (route === 'GET /api/sessions') {
				const sessions = await sdk.SessionManager.list(cwd).catch(() => []);
				return send(res, 200, { sessions }, { 'content-type': 'application/json' });
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
				const entryId = url.searchParams.get('entry') ?? '';
				const index = Math.max(0, Number.parseInt(url.searchParams.get('index') ?? '0', 10) || 0);
				const image = runtime.findSessionImage(entryId, index);
				if (!image) {
					return send(res, 404, { error: '图片不存在或已不在当前上下文里' }, { 'content-type': 'application/json' });
				}
				const mimeType = IMAGE_MIME_TYPES.has(image.mimeType) ? image.mimeType : 'application/octet-stream';
				return send(res, 200, Buffer.from(image.data, 'base64'), { 'content-type': mimeType });
			}

			if (route === 'GET /api/events') {
				return transport.openEvents(req, res, {
					sessionInfo: runtime.sessionInfo,
					history: currentHistory,
					resendPendingUI: ui.resendPendingUI,
					onConnect: ui.cancelUIGrace,
					onDisconnect: ui.scheduleUIGrace,
				});
			}

			if (route === 'POST /api/prompt') {
				const body = await readJson(req);
				const text = messageText(body);
				// 附件里的图片随消息一起发给 pi（缩放、校验由 pi 自己做）
				const parsed = parseImages(body);
				if (parsed.error) return send(res, 400, { error: parsed.error }, { 'content-type': 'application/json' });
				const images = parsed.images;
				if (!text && !images) return send(res, 400, { error: '消息为空' }, { 'content-type': 'application/json' });
				if (!runtime.getSession()) await runtime.boot();
				const forceSteer = body?.mode === 'steer';
				if (runtime.isBusy() || forceSteer) {
					await runtime.getSession().steer(text, images);
					return send(res, 202, { accepted: true, mode: 'steer' }, { 'content-type': 'application/json' });
				}
				void runtime.getSession()
					.prompt(text, { images })
					.catch(async (err) => {
						const message = String(err?.message ?? err);
						// 运行中直接 prompt 会被拒绝，这里兜底改成 steer，避免消息丢失
						if (/stream|busy|running|in progress|steer/i.test(message)) {
							try {
								await runtime.getSession().steer(text, images);
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
				const parsed = parseImages(body);
				if (parsed.error) return send(res, 400, { error: parsed.error }, { 'content-type': 'application/json' });
				if (!text && !parsed.images) return send(res, 400, { error: '消息为空' }, { 'content-type': 'application/json' });
				if (!runtime.getSession()) await runtime.boot();
				await runtime.getSession().steer(text, parsed.images);
				return send(res, 202, { accepted: true }, { 'content-type': 'application/json' });
			}

			if (route === 'POST /api/model') {
				const body = await readJson(req);
				const provider = typeof body?.provider === 'string' ? body.provider.trim() : '';
				const modelId = typeof body?.id === 'string' ? body.id.trim() : '';
				if (!provider || !modelId) {
					return send(res, 400, { error: '缺少 provider 或 id' }, { 'content-type': 'application/json' });
				}
				if (!runtime.getSession()) await runtime.boot();
				// 只允许切到本机已配鉴权的模型，避免把任意 provider/id 直接塞进会话
				const target = (runtime.getSession().modelRuntime?.getAvailableSnapshot() ?? []).find((model) =>
					runtime.sameModel(model, { provider, id: modelId }),
				);
				if (!target) {
					const error = `模型不在可用列表中：${provider}/${modelId}`;
					return send(res, 404, { error }, { 'content-type': 'application/json' });
				}
				const persist = Boolean(body?.persist);
				try {
					// 默认只改当前会话；persist 才写全局默认模型
					await runtime.getSession().setModel(target, { persist });
				} catch (err) {
					return send(
						res,
						400,
						{ error: String(err?.message ?? err) },
						{ 'content-type': 'application/json' },
					);
				}
				runtime.broadcastSession();
				return send(res, 200, { context: runtime.sessionInfo(), persist }, { 'content-type': 'application/json' });
			}

			if (route === 'POST /api/thinking') {
				const body = await readJson(req);
				const level = typeof body?.level === 'string' ? body.level.trim() : '';
				if (!THINKING_LEVELS.includes(level)) {
					const error = `不支持的思考等级：${level || '(空)'}`;
					return send(res, 400, { error }, { 'content-type': 'application/json' });
				}
				if (!runtime.getSession()) await runtime.boot();
				if (typeof runtime.getSession().setThinkingLevel !== 'function') {
					return send(
						res,
						400,
						{ error: '当前 pi 版本不支持思考等级切换' },
						{ 'content-type': 'application/json' },
					);
				}
				// setThinkingLevel 会按当前模型能力收敛；只改本会话，不写全局默认
				runtime.getSession().setThinkingLevel(level);
				runtime.broadcastSession();
				return send(res, 200, { context: runtime.sessionInfo() }, { 'content-type': 'application/json' });
			}

			if (route === 'POST /api/abort') {
				if (runtime.getSession()) await runtime.getSession().abort();
				// 中止后有的插件还挂在对话框上（没传 AbortSignal 的那种），不放开它们这个回合就结束不了
				ui.settleAllUI();
				// 中止不一定走到 agent_settled：实时速率在这里直接收尾
				telemetry.rateReset();
				return send(res, 202, { aborted: true }, { 'content-type': 'application/json' });
			}

			if (route === 'POST /api/rewind') {
				const body = await readJson(req);
				const entryId = typeof body?.entryId === 'string' ? body.entryId.trim() : '';
				if (!entryId) return send(res, 400, { error: '缺少 entryId' }, { 'content-type': 'application/json' });
				if (!runtime.getSession()) return send(res, 400, { error: '会话尚未就绪' }, { 'content-type': 'application/json' });
				if (typeof runtime.getSession().navigateTree !== 'function') {
					return send(res, 400, { error: '当前 pi 版本不支持会话回退' }, { 'content-type': 'application/json' });
				}
				// 只接受本会话的用户提问：其它节点或别处会话的 id 一律拒绝
				const entry = runtime.getSession().sessionManager?.getEntry?.(entryId);
				if (!entry || entry.type !== 'message' || entry.message?.role !== 'user') {
					return send(res, 404, { error: '只能回退到本会话的用户提问' }, { 'content-type': 'application/json' });
				}
				if (runtime.isBusy() || runtime.getSession().isStreaming) {
					return send(res, 409, { error: '回合运行中，请先中止再回退' }, { 'content-type': 'application/json' });
				}
				// summarize: false —— 被放弃的分支只移出上下文，既不删除也不总结
				const result = await runtime.getSession().navigateTree(entryId, { summarize: false });
				if (result?.cancelled) {
					return send(
						res,
						409,
						{ error: '回退被取消（可能被扩展拦截）' },
						{ 'content-type': 'application/json' },
					);
				}
				runtime.broadcastSession();
				runtime.broadcastHistory();
				return send(
					res,
					200,
					{ editorText: typeof result?.editorText === 'string' ? result.editorText : '', context: runtime.sessionInfo() },
					{ 'content-type': 'application/json' },
				);
			}

			if (route === 'POST /api/new') {
				await runtime.newSession();
				return send(res, 202, { context: runtime.sessionInfo() }, { 'content-type': 'application/json' });
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
				await runtime.switchSession(path.resolve(found.path));
				return send(res, 202, { context: runtime.sessionInfo() }, { 'content-type': 'application/json' });
			}

			if (route === 'POST /api/ui-response') {
				const result = ui.respond(await readJson(req));
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
			broadcast({ kind: 'error', message });
			return send(res, 500, { error: message }, { 'content-type': 'application/json' });
		}
	}

	return handleRequest;
}
