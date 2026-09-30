/** HTTP 数据边界、固定页面资源和 SSE 连接管理。 */
import { readFile } from 'node:fs/promises';

/** 单帧 SSE 上限：超过则丢弃原文，只发一个截断通知（history 走分片，不受此限）。 */
const MAX_FRAME_BYTES = 256 * 1024;

/** 请求体总上限为 32 MiB；图片张数和单张限制仍需独立校验。 */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** 单条消息最多带几张图片。 */
const MAX_ATTACH_IMAGES = 8;

/** 单张图片的原始字节上限（更大的一般也会被 pi 的图片缩放挡下，不值得先传上来）。 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** 页面允许作为附件发送的图片类型（与 pi 的视觉输入一致）。 */
export const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** 统一的 JSON / 文本响应。 */
export function send(res, status, body, headers = {}) {
	const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
	res.writeHead(status, { 'cache-control': 'no-store', ...headers });
	res.end(payload);
}

/** 读取并解析 JSON 请求体。 */
export async function readJson(req) {
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
export function messageText(body) {
	const text = typeof body?.message === 'string' ? body.message.trim() : '';
	return text;
}

/**
 * 校验请求体里的图片附件。
 * 返回 { images }（没有附件时为 undefined）或 { error }（页面直接提示）。
 */
export function parseImages(body) {
	const list = body?.images;
	if (list === undefined || list === null) return { images: undefined };
	if (!Array.isArray(list)) return { error: 'images 必须是数组' };
	if (list.length > MAX_ATTACH_IMAGES) return { error: `一次最多发送 ${MAX_ATTACH_IMAGES} 张图片` };
	const images = [];
	for (const item of list) {
		const data = typeof item?.data === 'string' ? item.data : '';
		const mimeType = typeof item?.mimeType === 'string' ? item.mimeType.trim().toLowerCase() : '';
		if (!data) return { error: '图片数据为空' };
		if (!IMAGE_MIME_TYPES.has(mimeType)) return { error: `不支持的图片类型：${mimeType || '(空)'}` };
		// byteLength 按 base64 解码后的长度算，避免拿 base64 长度当字节数
		if (Buffer.byteLength(data, 'base64') > MAX_IMAGE_BYTES) {
			return { error: `单张图片不能超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB` };
		}
		images.push({ type: 'image', data, mimeType });
	}
	return { images: images.length ? images : undefined };
}

/** 唯一允许访问的页面资源；不暴露源码目录、配置或会话文件。 */
const ASSETS = new Map([
	['GET /', [new URL('../index.html', import.meta.url), 'text/html; charset=utf-8']],
	['GET /assets/app.mjs', [new URL('../web/app.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
	['GET /assets/theme.mjs', [new URL('../web/theme.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
	['GET /assets/sheets.mjs', [new URL('../web/sheets.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
	['GET /assets/markdown.mjs', [new URL('../web/markdown.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
	['GET /assets/messages.mjs', [new URL('../web/messages.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
	['GET /assets/composer.mjs', [new URL('../web/composer.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
	['GET /assets/sessions.mjs', [new URL('../web/sessions.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
	['GET /assets/models.mjs', [new URL('../web/models.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
	['GET /assets/navigation.mjs', [new URL('../web/navigation.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
	['GET /assets/plugins.mjs', [new URL('../web/plugins.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
	['GET /assets/usage.mjs', [new URL('../web/usage.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
	['GET /assets/styles/base.css', [new URL('../web/styles/base.css', import.meta.url), 'text/css; charset=utf-8']],
	['GET /assets/styles/messages.css', [new URL('../web/styles/messages.css', import.meta.url), 'text/css; charset=utf-8']],
	['GET /assets/styles/composer.css', [new URL('../web/styles/composer.css', import.meta.url), 'text/css; charset=utf-8']],
	['GET /assets/styles/overlays.css', [new URL('../web/styles/overlays.css', import.meta.url), 'text/css; charset=utf-8']],
	['GET /assets/styles/responsive.css', [new URL('../web/styles/responsive.css', import.meta.url), 'text/css; charset=utf-8']],
]);

/** 命中资源白名单才读取文件，未命中交给 API 路由处理。 */
export async function serveAsset(route, res) {
	const asset = ASSETS.get(route);
	if (!asset) return false;
	send(res, 200, await readFile(asset[0]), { 'content-type': asset[1] });
	return true;
}

/** 创建传输实例，不拥有会话或插件业务状态。 */
export function createTransport() {
	/** 已连接的 SSE 响应，归当前服务实例所有。 */
	const clients = new Set();

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

	/** 读取活跃连接数供插件断连宽限判断，调用方不能修改连接集合。 */
	function getClientCount() { return clients.size; }

	/** 建连后按原顺序补发会话、历史与未决 UI，关闭时释放心跳。 */
	function openEvents(req, res, { sessionInfo, history, resendPendingUI, onConnect, onDisconnect }) {
		res.writeHead(200, {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no',
		});
		clients.add(res);
		onConnect();
		res.write(`data: ${JSON.stringify({ kind: 'session', info: sessionInfo() })}\n\n`);
		for (const frame of history()) res.write(`data: ${JSON.stringify(frame)}\n\n`);
		resendPendingUI(res);
		// 保持连接活跃，不发送额外业务帧。
		const keepAlive = setInterval(() => {
			try { res.write(': ping\n\n'); } catch {}
		}, 15000);
		// 客户端断开后再开始插件宽限期，刷新不会立即取消对话框。
		req.on('close', () => {
			clearInterval(keepAlive);
			clients.delete(res);
			if (clients.size === 0) onDisconnect();
		});
	}

	/** 服务关闭时结束全部响应；请求 close 事件负责释放心跳。 */
	function closeClients() {
		for (const client of clients) {
			try { client.end(); } catch {}
		}
		clients.clear();
	}

	return { broadcast, getClientCount, openEvents, closeClients };
}
