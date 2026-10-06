/**
 * 页面与对话的绑定。
 *
 * 一个页签只服务一个对话：地址栏的 ?c=<id> 决定绑定哪个；没有写、或写的那个已经不在服务端
 * （服务重启、对话被回收）时就新建一个并写回地址栏，刷新后仍绑定同一个对话。
 * 事件流（SSE）与所有会话相关接口都按这个 id 寻址，因此多个页签互不影响。
 */

/** 当前页签绑定的对话 id；initConversation 完成前为空串。 */
let conversationId = '';

/**
 * 把对话 id 拼进接口地址；还没绑定对话时原样返回，由服务端回退到首个对话。
 *
 * @param {string} path 接口路径，可自带查询串。
 * @returns {string} 带 c 参数的接口地址。
 */
export function apiPath(path) {
	if (!conversationId) return path;
	return path + (path.includes('?') ? '&' : '?') + 'c=' + encodeURIComponent(conversationId);
}

/** 当前页签绑定的对话 id（未完成绑定时为空串）。 */
export function currentConversationId() {
	return conversationId;
}

/** 地址栏里写的对话 id；没有则返回空串。 */
function conversationIdFromUrl() {
	return (new URLSearchParams(window.location.search).get('c') ?? '').trim();
}

/** 用 replaceState 把对话 id 写进地址栏，不新增历史记录。 */
function rememberConversation(id) {
	const url = new URL(window.location.href);
	url.searchParams.set('c', id);
	window.history.replaceState(null, '', url.toString());
}

/** 读某个对话的上下文；对话不存在或服务端不可用时返回 null。 */
async function fetchConversationContext(id) {
	try {
		const response = await fetch('/api/context?c=' + encodeURIComponent(id));
		if (!response.ok) return null;
		const data = await response.json();
		return data?.context ?? null;
	} catch {
		return null;
	}
}

/**
 * 让服务端新建一个对话。
 * 失败时返回原因：`limit` 是对话数已达上限，`error` 是服务端拒绝，`unreachable` 是本地服务没响应。
 */
async function createConversation() {
	try {
		const response = await fetch('/api/conversations', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({}),
		});
		if (!response.ok) return { id: '', reason: response.status === 409 ? 'limit' : 'error' };
		const data = await response.json();
		if (typeof data?.id !== 'string' || !data.id) return { id: '', reason: 'error' };
		return { id: data.id, context: data.context ?? null, reason: '' };
	} catch {
		return { id: '', reason: 'unreachable' };
	}
}

/**
 * 建立本页签的对话绑定。
 *
 * @returns {Promise<{id: string, context: object|null, reason: string}>} 绑定的对话 id、它的首屏上下文，
 *   以及绑定失败的原因（成功时为空串；没有 id 时接口会由服务端回退到已有对话）。
 */
export async function initConversation() {
	const wanted = conversationIdFromUrl();
	if (wanted) {
		const context = await fetchConversationContext(wanted);
		if (context) {
			conversationId = wanted;
			return { id: wanted, context, reason: '' };
		}
	}
	const created = await createConversation();
	if (!created.id) return { id: '', context: null, reason: created.reason };
	conversationId = created.id;
	rememberConversation(created.id);
	return { id: created.id, context: created.context, reason: '' };
}
