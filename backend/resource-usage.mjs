/** 会话分支的插件与技能使用汇总；只保存来源元数据，不保存参数、输出或技能正文。 */
import path from 'node:path';

const CUSTOM_TYPE = 'pigui.resource-usage';
const MODES = { plugin: new Set(['tool', 'command']), skill: new Set(['explicit', 'read']) };

/** 创建使用记录器；插件加载与实际调用分开，回退时仅从当前分支恢复。 */
export function createResourceUsage({ cwd, parseSkill, broadcast }) {
	let session = null;
	let usage = new Map();
	let skillsByPath = new Map();
	let toolsByName = new Map();
	const runningReads = new Map();
	let commandRestorers = [];
	let volatileRecords = [];
	let warned = false;

	/** 统一路径分隔符与相对路径；Windows 路径比较不区分大小写。 */
	function pathKey(location) {
		if (typeof location !== 'string' || !location.trim()) return '';
		const value = location.replace(/\\/g, '/');
		const resolved = /^(builtin:|<)/.test(value) ? value : path.resolve(cwd, value).replace(/\\/g, '/');
		return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
	}

	/** 插件名取入口文件名；index 入口改用目录名，合成入口保留其稳定名称。 */
	function pluginName(location) {
		if (location.startsWith('builtin:')) return location.slice(8);
		if (location.startsWith('<')) return location.replace(/^<|>$/g, '').replace(/^inline:/, '');
		const parts = location.replace(/\\/g, '/').split('/').filter(Boolean);
		const filename = parts.pop() || location;
		return /^index\.[cm]?[jt]s$/i.test(filename) ? parts.pop() || filename : filename.replace(/\.[cm]?[jt]s$/i, '');
	}

	/** 校验历史元数据后合并方式；按来源路径去重，不能把同名不同来源混在一起。 */
	function merge(record) {
		if (record?.kind !== 'plugin' && record?.kind !== 'skill') return false;
		if (!MODES[record.kind].has(record.mode) || typeof record.name !== 'string' || !record.name || !pathKey(record.location)) return false;
		const key = record.kind + ':' + pathKey(record.location);
		let item = usage.get(key);
		if (!item) {
			item = { kind: record.kind, name: record.name, location: record.location, modes: [] };
			usage.set(key, item);
		}
		if (item.modes.includes(record.mode)) return false;
		item.modes.push(record.mode);
		return true;
	}

	/** 可选统计失败只提示一次，不中断插件或原有工具执行。 */
	function warn(error) {
		if (warned) return;
		warned = true;
		broadcast({ kind: 'error', message: '使用汇总记录失败，不影响会话：' + String(error?.message || error) });
	}

	/** 生成两组稳定排序的只读视图，不暴露 Map 或内部记录。 */
	function view() {
		const result = { plugins: [], skills: [], persistent: typeof session?.sessionManager?.appendCustomEntry === 'function' };
		for (const item of usage.values()) {
			result[item.kind === 'plugin' ? 'plugins' : 'skills'].push({ name: item.name, location: item.location, modes: [...item.modes].sort() });
		}
		for (const list of [result.plugins, result.skills]) list.sort((a, b) => a.name.localeCompare(b.name) || a.location.localeCompare(b.location));
		return result;
	}

	/** 首次出现的来源/方式写入 Pi 自定义条目；该条目不参与模型上下文。 */
	function record(item) {
		if (!session || !merge(item)) return;
		try {
			const manager = session.sessionManager;
			if (typeof manager?.appendCustomEntry === 'function') {
				manager.appendCustomEntry(CUSTOM_TYPE, { version: 1, ...item });
			} else {
				volatileRecords.push({ ...item, leafId: manager?.getLeafId?.() || '' });
			}
		} catch (error) {
			volatileRecords.push({ ...item, leafId: session.sessionManager?.getLeafId?.() || '' });
			warn(error);
		}
		broadcast({ kind: 'resource_usage', sessionId: session.sessionId, usage: view() });
	}

	/** 只识别 SDK 标准技能展开块，不从助手正文里猜测技能名称。 */
	function explicitSkill(message) {
		if (message?.role !== 'user' || typeof parseSkill !== 'function') return null;
		const text = typeof message.content === 'string' ? message.content : (Array.isArray(message.content) ? message.content : [])
			.filter((block) => block?.type === 'text').map((block) => block.text).join('\n');
		try {
			const skill = parseSkill(text);
			return skill ? { kind: 'skill', name: skill.name, location: skill.location, mode: 'explicit' } : null;
		} catch { return null; }
	}

	/** read 的路径必须与已发现的技能文件完全一致；普通同名文件不算技能。 */
	function readSkill(name, args) {
		if (name !== 'read') return null;
		if (typeof args === 'string') {
			try { args = JSON.parse(args); } catch { return null; }
		}
		const skill = skillsByPath.get(pathKey(args?.path));
		return skill ? { kind: 'skill', name: skill.name, location: skill.filePath, mode: 'read' } : null;
	}

	/** 恢复当前完整分支，包含压缩前条目；旧工具记录只补可证明的成功技能读取。 */
	function snapshot() {
		usage = new Map();
		const manager = session?.sessionManager;
		const branch = manager?.getBranch?.();
		const messages = branch ? branch.filter((entry) => entry.type === 'message').map((entry) => entry.message) : session?.state?.messages || [];
		for (const entry of branch || []) {
			if (entry.type === 'custom' && entry.customType === CUSTOM_TYPE && entry.data?.version === 1) merge(entry.data);
		}
		const calls = new Map();
		for (const message of messages) {
			const skill = explicitSkill(message);
			if (skill) merge(skill);
			if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
			for (const block of message.content) {
				if (block?.type === 'toolCall' && block.id) calls.set(block.id, block);
			}
		}
		for (const message of messages) {
			if (message?.role !== 'toolResult' || message.isError !== false) continue;
			const call = calls.get(message.toolCallId);
			const skill = call && readSkill(call.name, call.arguments);
			if (skill) merge(skill);
		}
		const ids = branch ? new Set(branch.map((entry) => entry.id)) : null;
		volatileRecords = volatileRecords.filter((item) => !ids || ids.has(item.leafId));
		for (const item of volatileRecords) merge(item);
		return view();
	}

	/** 还原旧命令处理器；重载和释放会话时不把包装器留给旧运行时。 */
	function detachCommands() {
		for (const restore of commandRestorers) restore();
		commandRestorers = [];
	}

	/** 刷新来源目录并包装实际命令处理器；不按输入前缀推测命令已执行。 */
	function refresh() {
		detachCommands();
		skillsByPath = new Map();
		toolsByName = new Map();
		if (!session) return;
		try {
			for (const skill of session.resourceLoader?.getSkills?.().skills || []) {
				if (pathKey(skill.filePath)) skillsByPath.set(pathKey(skill.filePath), skill);
			}
			const extensions = session.resourceLoader?.getExtensions?.().extensions || [];
			for (const extension of extensions) {
				const location = extension.path || extension.resolvedPath;
				if (typeof location !== 'string' || !location) continue;
				const plugin = { kind: 'plugin', name: pluginName(location), location };
				for (const tool of extension.tools?.values?.() || []) {
					if (!toolsByName.has(tool.definition?.name)) toolsByName.set(tool.definition?.name, plugin);
				}
				for (const command of extension.commands?.values?.() || []) {
					const original = command.handler;
					if (typeof original !== 'function') continue;
					const owner = session;
					/** 只有 SDK 真正派发命令才记录；原处理器的参数、返回值和异常保持原样。 */
					const wrapped = function (...args) {
						if (session === owner) record({ ...plugin, mode: 'command' });
						return original.apply(this, args);
					};
					command.handler = wrapped;
					commandRestorers.push(() => { if (command.handler === wrapped) command.handler = original; });
				}
			}
		} catch (error) { warn(error); }
	}

	/** 动态工具优先用运行时提供的来源，旧 SDK 才退回加载时的来源表。 */
	function toolPlugin(name) {
		try {
			const tool = session?.extensionRunner?.getAllRegisteredTools?.().find((item) => item.definition?.name === name);
			const location = tool?.sourceInfo?.path;
			if (location) return { kind: 'plugin', name: pluginName(location), location };
		} catch (error) { warn(error); }
		return toolsByName.get(name);
	}

	/** 订阅执行事件；失败的插件工具仍是已调用，失败或未知的技能读取不计入。 */
	function track(event) {
		if (!session) return;
		if (event?.type === 'tool_execution_start') {
			const plugin = toolPlugin(event.toolName);
			if (plugin) record({ ...plugin, mode: 'tool' });
			const skill = readSkill(event.toolName, event.args);
			if (skill && event.toolCallId) runningReads.set(event.toolCallId, skill);
		} else if (event?.type === 'tool_execution_end') {
			const skill = runningReads.get(event.toolCallId);
			runningReads.delete(event.toolCallId);
			if (skill && event.isError === false && event.result?.isError !== true) record(skill);
		} else if (event?.type === 'agent_settled') {
			runningReads.clear();
			broadcast({ kind: 'resource_usage', sessionId: session.sessionId, usage: snapshot() });
		}
	}

	/** 用户消息写入会话后记录显式技能，避免元数据落在提问的父节点上。 */
	function trackUser(message) {
		const skill = explicitSkill(message);
		if (skill) record(skill);
	}

	/** 绑定新会话并恢复历史；记录绝不跨会话共享。 */
	function bind(nextSession) {
		detachCommands();
		session = nextSession;
		usage = new Map();
		volatileRecords = [];
		runningReads.clear();
		warned = false;
		refresh();
		snapshot();
	}

	/** 释放命令包装与正在执行的读取记录，不修改既有会话历史。 */
	function dispose() {
		detachCommands();
		runningReads.clear();
		session = null;
	}

	return { bind, refresh, snapshot, track, trackUser, dispose };
}
