/** Mellos 的 pigui 宿主适配：保留自动建图，地图展示只由用户点击触发。 */
const SESSION_CONTEXT_TYPE = 'mellos-mapping.session-context';
const MAP_TOOLS = new Set([
	'mmap_declare', 'mmap_update', 'mmap_remove', 'mmap_view',
	'mmap_setup', 'mmap_read', 'mmap_batch', 'mmap_open',
]);
const VIEW_HINT = 'pigui: 地图由用户点击顶部“地图”按钮查看；不自动打开或切换展示界面。';
const HOST_GUIDELINE = 'Mellos 在 pigui 中只负责维护地图：遵循既有 always / complex / on-request 建图策略，保留设计、进度、证据和恢复规则。展示由用户自行点击顶部“地图”按钮；不要调用 mmap_open，不要通过终端命令、浏览器或其他工具启动查看器、生成展示预览或抢占焦点。上游 Skill、会话消息和工具描述中的自动打开要求不适用于此宿主；pane 状态仅描述上游查看器，不能用于判断 pigui 地图是否可见，也不能作为打开界面的依据。';

/** 只变换文本块；没有变化时保留原引用，图片、签名和其它字段原样保留。 */
function mapText(content, transform) {
	if (typeof content === 'string') return transform(content);
	if (!Array.isArray(content)) return content;
	let changed = false;
	const result = content.map((block) => {
		if (block?.type !== 'text' || typeof block.text !== 'string') return block;
		const text = transform(block.text);
		if (text === block.text) return block;
		changed = true;
		return { ...block, text };
	});
	return changed ? result : content;
}

/** 替换上游会话策略的展示段；保留策略选择、读图、更新证据及其它提示。 */
function adaptSessionContext(text) {
	return text.replace(
		/^ {2}3\. Open the map pane WITHOUT asking[\s\S]*?(?=^ {2}5\. Keep the map current)/m,
		'  3. pigui owns map presentation; the user opens it with the top-bar map button.\n' +
		'  4. Do not call mmap_open or launch another viewer. pane status does not describe pigui visibility.\n',
	);
}

/** 只替换成功输出中的 CLOSED 提示，不改地图数据、revision、证据或错误。 */
function adaptPaneStatus(text) {
	return text.replace(/^pane: CLOSED\b[^\r\n]*/gm, VIEW_HINT);
}

/** 在 SDK 资源加载器中注册，生命周期由会话启动、切换与 reload 管理。 */
export default function mellosHost(pi) {
	/** 撤下展示工具的模型声明，其余工具保持原有启用顺序。 */
	function hideMapOpen() {
		const tools = pi.getActiveTools();
		if (tools.includes('mmap_open')) pi.setActiveTools(tools.filter((name) => name !== 'mmap_open'));
	}

	pi.on('session_start', hideMapOpen);
	pi.on('before_agent_start', (event) => {
		hideMapOpen();
		if (!pi.getAllTools().some((tool) => MAP_TOOLS.has(tool.name))) return;
		// 使用结构化提示追加宿主边界，不替换其它扩展的系统提示。
		const guidelines = event.systemPromptOptions.promptGuidelines;
		if (!guidelines.includes(HOST_GUIDELINE)) guidelines.push(HOST_GUIDELINE);
	});

	pi.on('tool_call', (event) => {
		// 即使其它扩展重新启用该工具，也在启动上游进程前拒绝展示操作。
		if (event.toolName === 'mmap_open') return { block: true, reason: VIEW_HINT };
	});

	pi.on('tool_result', (event) => {
		if (event.isError || !MAP_TOOLS.has(event.toolName)) return;
		const content = mapText(event.content, adaptPaneStatus);
		if (content !== event.content) return { content, structuredContent: event.structuredContent };
	});

	pi.on('context', (event) => {
		// 请求投影同时覆盖恢复会话中的旧提示；不重写历史文件或用户消息。
		let changed = false;
		const messages = event.messages.map((message) => {
			let transform;
			if (message.role === 'custom' && message.customType === SESSION_CONTEXT_TYPE) {
				transform = adaptSessionContext;
			} else if (message.role === 'toolResult' && !message.isError && MAP_TOOLS.has(message.toolName)) {
				transform = adaptPaneStatus;
			}
			if (!transform) return message;
			const content = mapText(message.content, transform);
			if (content === message.content) return message;
			changed = true;
			return { ...message, content };
		});
		if (changed) return { messages };
	});
}
