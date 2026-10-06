/**
 * pigui 服务入口：组装 SDK 会话注册表、HTTP/SSE 传输及独立功能模块。
 * 只监听本机地址；SDK 由命令行注入，不增加运行依赖。
 */
import http from 'node:http';
import { createTransport } from './backend/transport.mjs';
import { createRequestHandler } from './backend/routes.mjs';
import { createConversationRegistry } from './backend/conversations.mjs';
import { createWorkspace } from './backend/workspace.mjs';
import { createExternalUsage } from './backend/external-usage.mjs';

/**
 * 启动本地服务；一个进程可承载多个对话，首个对话沿用启动参数。
 *
 * @param {object} options 启动参数。
 * @param {object} options.sdk 提供 createAgentSession 与 SessionManager 的 pi SDK。
 * @param {string} options.cwd 工作目录，决定资源发现与会话归属。
 * @param {'continue'|'new'} [options.mode='new'] 首个会话未指定会话文件时的启动方式。
 * @param {string} [options.sessionPath=''] 首个会话优先打开的会话文件。
 * @param {number} [options.port=0] 监听端口，0 由系统分配。
 * @param {boolean} [options.pluginUi=true] 是否启用插件页面交互。
 * @param {(text: string) => void} [options.onLog] 日志回调。
 * @returns {Promise<object>} 地址、页签地址、首个会话 id、close、boot、sessionInfo 与 listConversations。
 */
export async function startServer({ sdk, cwd, mode = 'new', sessionPath = '', port = 0, pluginUi = true, onLog = () => {} }) {
	const transport = createTransport();
	const registry = createConversationRegistry({ sdk, cwd, transport, pluginUi, onLog });
	const workspace = createWorkspace({ cwd });
	// 额度是账号级的，不绑定某个对话：借一份存活会话的 ModelRuntime 让 pi 自己刷新 OAuth，取不到就退回读 auth.json。
	// 不把 ModelRuntime 共享给各会话：session.mjs 会改写 modelRuntime.streamSimple 来实现 Codex Fast，
	// 共享时一个对话的销毁会把另一个对话的包装一起还原掉。
	const externalUsage = createExternalUsage({
		sdk,
		getModelRuntime: () => registry.first()?.getSession()?.modelRuntime ?? null,
	});
	const handler = createRequestHandler({ sdk, cwd, registry, transport, workspace, externalUsage, close });
	const server = http.createServer(handler);

	// 首个对话沿用启动参数，页签用 ?c=<id> 绑定到它；它要等页签连上再受空闲回收约束
	const first = await registry.create({ mode, sessionPath, pinned: true });
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', resolve);
	});
	const actualPort = server.address().port;
	const serviceUrl = `http://127.0.0.1:${actualPort}/`;
	onLog(`pigui: ${serviceUrl}`);
	// 保留退出时的同步落盘兜底；耗时文件格式不变，只是逐个会话落盘。
	process.once('exit', registry.flushAll);

	/** 逐个结束会话（放开插件等待、停止计时、落盘、释放 SDK 会话），再关闭连接并释放端口。 */
	async function close() {
		registry.closeAll();
		transport.closeClients();
		await new Promise((resolve) => server.close(resolve));
	}

	return {
		port: actualPort,
		url: serviceUrl,
		// 页签地址：带上首个会话 id，页面据此绑定到这个对话
		tabUrl: `${serviceUrl}?c=${first.id}`,
		conversationId: first.id,
		close,
		boot: () => registry.create({ mode: 'new' }),
		sessionInfo: first.sessionInfo,
		listConversations: () => registry.list(),
	};
}
