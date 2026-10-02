/**
 * pigui 服务入口：组装 SDK 会话、HTTP/SSE 传输及独立功能模块。
 * 只监听本机地址；SDK 由命令行注入，不增加运行依赖。
 */
import http from 'node:http';
import { createTransport } from './backend/transport.mjs';
import { createRequestHandler } from './backend/routes.mjs';
import { createSessionRuntime } from './backend/session.mjs';
import { createTimings } from './backend/timings.mjs';
import { createTelemetry } from './backend/telemetry.mjs';
import { createPluginUI } from './backend/plugin-ui.mjs';
import { createWorkspace } from './backend/workspace.mjs';
import { createExternalUsage } from './backend/external-usage.mjs';

/**
 * 启动本地服务；保持原有返回接口和默认新建会话行为。
 *
 * @param {object} options 启动参数。
 * @param {object} options.sdk 提供 createAgentSession 与 SessionManager 的 pi SDK。
 * @param {string} options.cwd 工作目录，决定资源发现与会话归属。
 * @param {'continue'|'new'} [options.mode='new'] 未指定会话文件时的启动方式。
 * @param {string} [options.sessionPath=''] 优先打开的会话文件。
 * @param {number} [options.port=0] 监听端口，0 由系统分配。
 * @param {boolean} [options.pluginUi=true] 是否启用插件页面交互。
 * @param {(text: string) => void} [options.onLog] 日志回调。
 * @returns {Promise<object>} 地址、端口、close、boot 与 sessionInfo。
 */
export async function startServer({ sdk, cwd, mode = 'new', sessionPath = '', port = 0, pluginUi = true, onLog = () => {} }) {
	const transport = createTransport();
	// 模块创建阶段只登记能力；首次访问会话发生在 runtime 完成组装后的 boot 中。
	let runtime;

	/** 让功能模块读取当前会话，不泄露会话控制器的可变状态。 */
	function getSession() {
		return runtime?.getSession();
	}

	const timings = createTimings({ getSession, broadcast: transport.broadcast, onLog });
	const telemetry = createTelemetry({ sdk, getSession, broadcast: transport.broadcast });
	const ui = createPluginUI({ broadcast: transport.broadcast, getClientCount: transport.getClientCount });
	const workspace = createWorkspace({ cwd });
	const externalUsage = createExternalUsage({ sdk, getSession });
	runtime = createSessionRuntime({
		sdk, cwd, mode, sessionPath, pluginUi,
		broadcast: transport.broadcast, timings, telemetry, ui,
	});
	const handler = createRequestHandler({
		sdk, cwd, runtime, transport, ui, telemetry, workspace, externalUsage, close,
	});
	const server = http.createServer(handler);

	await runtime.boot();
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', resolve);
	});
	const actualPort = server.address().port;
	const serviceUrl = `http://127.0.0.1:${actualPort}/`;
	onLog(`pigui: ${serviceUrl}`);
	// 保留退出时的同步落盘兜底，不改变耗时文件格式。
	process.once('exit', timings.flushTimings);

	/** 依原顺序解除插件等待、停止计时、落盘、关闭连接并释放会话和端口。 */
	async function close() {
		ui.close();
		telemetry.close();
		runtime.flushUserEcho();
		timings.flushTimings();
		transport.closeClients();
		runtime.dispose();
		await new Promise((resolve) => server.close(resolve));
	}

	return {
		port: actualPort,
		url: serviceUrl,
		close,
		boot: runtime.boot,
		sessionInfo: runtime.sessionInfo,
	};
}
