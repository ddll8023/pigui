/** 消息展示协议、历史分片和事件裁剪；不拥有会话状态。 */

/** history 分片的目标大小：超过就切成多帧发，避免被单帧上限整体丢弃。 */
const HISTORY_PART_BYTES = 128 * 1024;

/** 单个内容块的文本上限：超出截断，避免工具输出这类几 MB 的内容把一帧撑爆。 */
const MAX_BLOCK_TEXT = 48 * 1024;

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
		// 注意：pi 的 thinking 块把正文放在 thinking 字段（thinkingSignature 是签名数据，不是文本，不能取）。
		for (const key of ['text', 'content', 'output', 'result', 'thinking']) {
			if (key in value) {
				const inner = textOfValue(value[key], depth + 1);
				if (inner) return inner;
			}
		}
	}
	return '';
}

/**
 * 识别用户消息里的技能块。
 * pi 把 `/skill:名称 参数` 展开成技能全文后才写进会话，只有 SDK 的 parseSkillBlock
 * 知道那个格式；老版本 SDK 没这个导出时返回 null，消息按普通文本处理。
 */
function skillBlockOf(text, parseSkill) {
	if (!text || typeof parseSkill !== 'function') return null;
	try {
		return parseSkill(text) || null;
	} catch {
		return null;
	}
}

/**
 * 把技能块还原成可以再次发送的命令：`/skill:名称 参数`；不是技能块时返回空串。
 * 回退时用它填回输入框，避免把整份 SKILL.md 全文倒进编辑器。
 */
export function skillCommandText(text, parseSkill) {
	const block = skillBlockOf(text, parseSkill);
	if (!block) return '';
	return `/skill:${block.name}${block.userMessage ? ' ' + block.userMessage : ''}`;
}

/**
 * 工具结果里的展示用 diff（目前只有 edit 带），按内容块上限截断，避免大改动把单帧撑爆。
 */
function toolDiffOf(result) {
	const diff = result?.details?.diff;
	if (typeof diff !== 'string' || !diff) return '';
	return diff.length > MAX_BLOCK_TEXT ? `${diff.slice(0, MAX_BLOCK_TEXT)}\n…（diff 已截断，原文 ${diff.length} 字节）` : diff;
}

/**
 * 把 pi 的消息压成 { role, text, blocks }。
 *
 * blocks 保留每块的类型（thinking / text / toolCall / toolResult / …）与 toolCallId，
 * 页面据此可以分区渲染、把工具输出折到对应调用下面；text 是拼好的纯文本，供简单渲染使用。
 * entryId 是这条消息在会话树里所属条目的 id（页面回退时用），取不到时为空串。
 * parseSkill 是 pi SDK 的 parseSkillBlock，用于把技能消息压成“名称 + 参数”。
 */
export function messageView(message, entryId = '', parseSkill) {
	const role = typeof message?.role === 'string' ? message.role : 'unknown';
	const blocks = [];
	// 图片块的序号（同一条消息里第几张），页面靠它拼 /api/image 的取图地址
	let imageIndex = 0;
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
			// 图片块只下发取图地址：base64 动辄几 MB，塞进帧会被单帧上限整帧丢掉
			if (type === 'image') {
				const mimeType = typeof raw.mimeType === 'string' ? raw.mimeType : '';
				blocks.push({
					type: 'image',
					text: '',
					mimeType,
					url: entryId ? `/api/image?entry=${encodeURIComponent(entryId)}&index=${imageIndex}` : '',
				});
				imageIndex += 1;
				continue;
			}
			const block = { type, text: textOfValue(raw) };
			if (raw.arguments !== undefined && raw.arguments !== null) {
				// 工具参数通常是对象（如 { command: "ls" }），转成 JSON 展示；字符串原样使用。
				block.arguments =
					typeof raw.arguments === 'string' ? raw.arguments : JSON.stringify(raw.arguments, null, 2);
			}
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
			// 超大块（例如几 MB 的工具输出）先截断，否则单条消息自己就能撑爆一帧
			for (const key of ['text', 'arguments']) {
				const value = block[key];
				if (typeof value === 'string' && value.length > MAX_BLOCK_TEXT) {
					block[key] = `${value.slice(0, MAX_BLOCK_TEXT)}\n…（已截断，原文 ${value.length} 字节）`;
					block.truncated = true;
				}
			}
			blocks.push(block);
		}
	}
	const text = blocks
		.map((block) => block.text)
		.filter(Boolean)
		.join('\n')
		.trim();
	// entryId 是会话树里这条消息所在条目的 id，页面据此定位回退目标；取不到时为空串
	const view = { role, text, blocks, entryId };
	// 助手的失败和中止信息不在正文块里，必须单独保留；错误文本同样限制帧大小。
	if (role === 'assistant') {
		if (typeof message.stopReason === 'string') view.stopReason = message.stopReason;
		if (typeof message.errorMessage === 'string') view.errorMessage = message.errorMessage.slice(0, MAX_BLOCK_TEXT);
	}
	// 技能消息落盘的是展开后的全文：只下发名称与参数，页面画成徽标 + 参数，
	// 否则一条提问就能把整份 SKILL.md 铺在气泡里（图片块与取图序号保持不动）。
	if (role === 'user') {
		const skill = skillBlockOf(text, parseSkill);
		if (skill) {
			const args = skill.userMessage ?? '';
			view.skill = { name: skill.name, location: skill.location };
			view.text = args;
			view.blocks = blocks.filter((block) => block.type !== 'text');
			if (args) view.blocks.unshift({ type: 'text', text: args });
		}
	}
	// 工具结果的归属信息在消息级字段上（content 里只有输出文本），单独带出来供页面展示
	if (role === 'toolResult') {
		view.toolCallId = typeof message?.toolCallId === 'string' ? message.toolCallId : '';
		view.toolName = typeof message?.toolName === 'string' ? message.toolName : '';
		view.isError = Boolean(message?.isError);
		const diff = toolDiffOf(message);
		if (diff) view.diff = diff;
	}
	return view;
}

/**
 * 给已经定下 entryId 的消息视图补上图片地址（实时回显帧也能显示图片，不必等历史重放）。
 */
export function attachImageUrls(view) {
	if (!view || !view.entryId) return view;
	let index = 0;
	for (const block of view.blocks ?? []) {
		if (block?.type !== 'image') continue;
		if (!block.url) block.url = `/api/image?entry=${encodeURIComponent(view.entryId)}&index=${index}`;
		index += 1;
	}
	return view;
}

/**
 * 把历史消息切成若干帧：每片不超过 HISTORY_PART_BYTES，片信息放在 part / parts 里。
 *
 * 页面按 part 顺序拼接（part 为 0 时清空重绘），这样几 MB 的长会话也能完整送达，
 * 不会被 MAX_FRAME_BYTES 整体丢弃成 frame_truncated。
 */
export function historyFrames(views) {
	const batches = [];
	let batch = [];
	let size = 0;
	for (const view of views) {
		const viewSize = Buffer.byteLength(JSON.stringify(view));
		if (batch.length && size + viewSize > HISTORY_PART_BYTES) {
			batches.push(batch);
			batch = [];
			size = 0;
		}
		batch.push(view);
		size += viewSize;
	}
	if (batch.length || !batches.length) batches.push(batch);
	return batches.map((list, index) => ({
		kind: 'history',
		messages: list,
		part: index,
		parts: batches.length,
	}));
}

/**
 * 把 session 事件压成页面可用的小帧；返回 null 表示这个事件不需要发给页面。
 * 默认过滤高频噪声事件（tool_execution_update / message_start / turn_start），PIGUI_DEBUG=1 时不过滤。
 * extra 是调用方注入的实测信息，目前只有 message_end 的单次耗时 durationMs。
 * parseSkill 是 pi SDK 的 parseSkillBlock，用户消息命中技能块时交给 messageView 压成“名称 + 参数”。
 */
export function eventFrame(event, extra, parseSkill) {
	if (!event || typeof event.type !== 'string') return null;
	if (event.type === 'message_update') {
		const inner = event.assistantMessageEvent;
		if (inner?.type === 'text_delta' && typeof inner.delta === 'string') return { kind: 'delta', text: inner.delta };
		if (inner?.type === 'thinking_delta' && typeof inner.delta === 'string') return { kind: 'thinking', text: inner.delta };
		return null;
	}
	if (!DEBUG && QUIET_EVENT_TYPES.has(event.type)) return null;
	if (event.type === 'message_end') {
		const view = messageView(event.message, '', parseSkill);
		// 耗时是服务端实测的：附在消息视图上，页面据此定格该行的计时
		if (Number.isFinite(extra?.durationMs)) view.durationMs = Math.round(extra.durationMs);
		return { kind: 'message', message: view };
	}
	// 思考等级变更：页面只需其中的 level（顶栏与浮层据此就地更新，不必重放历史）
	if (event.type === 'thinking_level_changed') {
		return { kind: 'event', type: event.type, detail: { level: String(event.level ?? '') } };
	}
	// 压缩事件只发状态和 token 数，不把长摘要塞进 SSE 帧。
	if (event.type === 'compaction_start' || event.type === 'compaction_end') {
		const detail = { reason: String(event.reason ?? '') };
		if (event.type === 'compaction_end') {
			detail.aborted = Boolean(event.aborted);
			if (typeof event.errorMessage === 'string') detail.errorMessage = event.errorMessage.slice(0, MAX_BLOCK_TEXT);
			if (event.result) {
				detail.result = {};
				for (const key of ['tokensBefore', 'estimatedTokensAfter']) {
					if (Number.isFinite(event.result[key])) detail.result[key] = event.result[key];
				}
			}
		}
		return { kind: 'event', type: event.type, detail };
	}
	const detail = {};
	for (const key of ['toolName', 'name', 'status', 'reason']) {
		if (typeof event[key] === 'string') detail[key] = event[key].slice(0, 120);
	}
	// 关联 ID 不截短，避免不同调用被合并；参数只供摘要和展开查看，沿用内容块上限。
	if (typeof event.toolCallId === 'string') detail.toolCallId = event.toolCallId;
	if (event.type === 'tool_execution_start' && event.args !== undefined) {
		const args = typeof event.args === 'string' ? event.args : JSON.stringify(event.args);
		if (typeof args === 'string') {
			detail.arguments = args.length > MAX_BLOCK_TEXT ? `${args.slice(0, MAX_BLOCK_TEXT)}\n…（参数已截断）` : args;
		}
	}
	if (event.type === 'tool_execution_end') {
		if (typeof event.isError === 'boolean') detail.isError = event.isError;
		// 结果对象里有 edit 的展示用 diff，工具一结束就能画出来，不必等消息落定
		const diff = toolDiffOf(event.result);
		if (diff) detail.diff = diff;
	}
	return { kind: 'event', type: event.type, detail };
}
