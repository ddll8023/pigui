/** 会话分支的读取与修改文件汇总；只从工具调用与分支历史推导，不写会话文件。 */
import path from 'node:path';

/** 工具名 → 记录方式；其余工具（含 bash / powershell）不猜测文件副作用。 */
const TOOL_MODES = { read: 'read', edit: 'modified', write: 'modified' };

/** 展示时的固定方式顺序，避免按字典序把「修改」排在「读取」前面。 */
const MODE_ORDER = ['read', 'modified'];

/** 实时记录上限，防止超长会话在内存里无限增长。 */
const MAX_LIVE_RECORDS = 4000;

/**
 * 创建文件使用记录器。
 *
 * 只统计 pi 内置的 read / edit / write，并且只认执行成功的调用；bash / powershell
 * 里的文件读写无法可靠识别，不计入。历史从当前完整分支重建，实时事件只补尚未落盘的窗口。
 *
 * @param {object} options 记录器参数。
 * @param {string} options.cwd 工作目录，用于路径规范化与展示裁剪。
 * @param {(frame: object) => void} options.broadcast 向本会话页面推帧。
 */
export function createFileUsage({ cwd, broadcast }) {
	let session = null;
	let files = new Map();
	const running = new Map();
	let liveRecords = [];

	/** 统一路径分隔符与相对路径；Windows 路径比较不区分大小写。 */
	function pathKey(location) {
		if (typeof location !== 'string' || !location.trim()) return '';
		const value = location.replace(/\\/g, '/');
		const resolved = path.resolve(cwd, value).replace(/\\/g, '/');
		return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
	}

	/** 展示用路径：能落在工作目录内就裁成相对路径，否则保留原样。 */
	function displayPath(location) {
		const value = String(location || '').trim();
		const root = cwd.replace(/[\\/]+$/, '');
		if (!value || !root || !value.startsWith(root)) return value;
		return value.slice(root.length).replace(/^[\\/]+/, '') || value;
	}

	/** 从工具参数里取路径；参数可能是对象，也可能是被序列化过的字符串。 */
	function pathOf(args) {
		let value = args;
		if (typeof value === 'string') {
			try {
				value = JSON.parse(value);
			} catch {
				return '';
			}
		}
		return typeof value?.path === 'string' ? value.path : '';
	}

	/** 按来源路径去重并合并方式，不能把同名不同目录混在一起。 */
	function merge(location, mode) {
		const key = pathKey(location);
		if (!key || !MODE_ORDER.includes(mode)) return false;
		let item = files.get(key);
		if (!item) {
			item = { path: displayPath(location) || location, modes: [] };
			files.set(key, item);
		}
		if (item.modes.includes(mode)) return false;
		item.modes.push(mode);
		return true;
	}

	/** 生成稳定排序的只读视图，不暴露 Map 或内部记录。 */
	function view() {
		const list = [...files.values()].map((item) => ({
			path: item.path,
			modes: MODE_ORDER.filter((mode) => item.modes.includes(mode)),
		}));
		list.sort((a, b) => a.path.localeCompare(b.path));
		return { files: list };
	}

	/** 实时记录带叶子 id，回退后只保留仍在新分支上的记录。 */
	function record(location, mode) {
		if (!session || !merge(location, mode)) return;
		liveRecords.push({ location, mode, leafId: session.sessionManager?.getLeafId?.() || '' });
		if (liveRecords.length > MAX_LIVE_RECORDS) liveRecords = liveRecords.slice(-MAX_LIVE_RECORDS);
		broadcast({ kind: 'file_usage', sessionId: session.sessionId, usage: view() });
	}

	/** 恢复当前完整分支（含压缩前条目），再补上尚未落盘的实时记录。 */
	function snapshot() {
		files = new Map();
		const manager = session?.sessionManager;
		const branch = manager?.getBranch?.();
		const messages = branch
			? branch.filter((entry) => entry.type === 'message').map((entry) => entry.message)
			: session?.state?.messages || [];
		const calls = new Map();
		for (const message of messages) {
			if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
			for (const block of message.content) {
				if (block?.type === 'toolCall' && block.id) calls.set(block.id, block);
			}
		}
		for (const message of messages) {
			if (message?.role !== 'toolResult') continue;
			if (message.isError !== true) {
				const call = calls.get(message.toolCallId);
				const mode = call && TOOL_MODES[call.name];
				const location = mode && pathOf(call.arguments);
				if (location) merge(location, mode);
			}
			// codemode 脚本里的 read / edit / write 记在调用方结果的 nestedCalls 上
			for (const nested of message.nestedCalls?.calls || []) {
				if (nested?.status !== 'ok') continue;
				const mode = TOOL_MODES[nested.name];
				const location = mode && pathOf(nested.arguments);
				if (location) merge(location, mode);
			}
		}
		const ids = branch ? new Set(branch.map((entry) => entry.id)) : null;
		liveRecords = liveRecords.filter((item) => !ids || ids.has(item.leafId));
		for (const item of liveRecords) merge(item.location, item.mode);
		return view();
	}

	/** 订阅工具执行事件；失败的调用不算读取或修改。 */
	function track(event) {
		if (!session) return;
		if (event?.type === 'tool_execution_start') {
			const mode = TOOL_MODES[event.toolName];
			const location = mode ? pathOf(event.args) : '';
			if (location) running.set(event.toolCallId, { location, mode });
		} else if (event?.type === 'tool_execution_end') {
			const item = running.get(event.toolCallId);
			running.delete(event.toolCallId);
			if (item && event.isError === false && event.result?.isError !== true) record(item.location, item.mode);
		} else if (event?.type === 'agent_settled') {
			running.clear();
			broadcast({ kind: 'file_usage', sessionId: session.sessionId, usage: snapshot() });
		}
	}

	/** 绑定新会话并从分支恢复；记录绝不跨会话共享。 */
	function bind(nextSession) {
		session = nextSession;
		files = new Map();
		running.clear();
		liveRecords = [];
		snapshot();
	}

	/** 释放正在执行的记录，不修改既有会话历史。 */
	function dispose() {
		running.clear();
		session = null;
	}

	return { bind, snapshot, track, dispose };
}
