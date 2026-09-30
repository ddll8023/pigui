/** 编辑器、补全与附件发送 */

/** 创建编辑器、补全与附件发送；状态由实例自己维护。 */
export function createComposer({ addStatusRow, addUserMessage, pinnedToBottom, followFrame, syncJumpPosition, openSessionPicker, openModelPicker, openRewind, newSession, isCompacting, isSessionPickerOpen, isOverlayOpen, handleOverlayKey }) {
	const inputEl = document.getElementById('input');
	const sendEl = document.getElementById('send');
	const cmdbarEl = document.getElementById('cmdbar');
	const cmdListEl = document.getElementById('cmdList');
	const filebarEl = document.getElementById('filebar');
	const fileListEl = document.getElementById('fileList');
	const attachStripEl = document.getElementById('attachStrip');
	const attachBtnEl = document.getElementById('attach');
	const filePickerEl = document.getElementById('filePicker');
	const composerEl = document.getElementById('composer');

	/** 页面内命令表（输入 / 时提示）；kind=action 表示选中即在本页执行。 */
	const COMMANDS = [
		{ name: '/resume', desc: '切换会话', kind: 'action' },
		{ name: '/model', desc: '切换模型 / 思考等级', kind: 'action' },
		{ name: '/new', desc: '新建会话', kind: 'action' },
		{ name: '/rewind', desc: '回退到某条提问之前', kind: 'action' },
		{ name: '/reload', desc: '重载扩展 / 技能 / 提示模板与配置', kind: 'action' },
		{ name: '/compact', desc: '手动压缩上下文，可附摘要要求', kind: 'action' },
	];

	/** 服务端列出的可补全命令（技能、提示模板、插件命令）；kind=insert 表示选中只写入输入框。 */
	let remoteCommands = [];

	/** 命令提示条状态。 */
	let commandOpen = false;

	let commandMatches = [];

	let commandIndex = 0;

	/** @ 引用文件提示条状态（fileToken 是光标前的 @ 片段：{ start, query }）。 */
	let fileOpen = false;

	let fileItems = [];

	let fileIndex = 0;

	let fileToken = null;

	let fileFetchSeq = 0;

	let fileFetchTimer = 0;

	/** 待发附件：图片存 base64 + 缩略图，文本写在正文里（附件只记名字便于删）。 */
	let attachments = [];

	let attachSeq = 0;

	/** 文本附件内联的上限：超过就截断并标注。 */
	const MAX_TEXT_ATTACH_BYTES = 256 * 1024;

	/** 图片附件的张数与单张大小上限（与服务端 parseImages 保持一致）。 */
	const MAX_ATTACH_IMAGES = 8;

	const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

	/** 页面认作图片的 MIME（与 pi 的视觉输入一致）。 */
	const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

	/** 可内联为文本的扩展名白名单（MIME 为 text/* 时不再看它）。 */
	const TEXT_ATTACH_EXTENSIONS = new Set(
		[
			'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'json', 'jsonc', 'md', 'markdown',
			'txt', 'log', 'csv', 'tsv', 'yml', 'yaml', 'toml', 'ini', 'env', 'cfg', 'conf', 'properties',
			'sh', 'bash', 'zsh', 'ps1', 'psm1', 'bat', 'cmd', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts',
			'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'swift', 'scala', 'sql', 'graphql', 'gql', 'dart',
			'html', 'htm', 'xml', 'svg', 'css', 'scss', 'less', 'styl', 'tex', 'r', 'lua', 'pl', 'ex', 'exs',
			'gradle', 'gitignore', 'dockerfile', 'makefile',
		],
	);

	/** 当前输入是否处于命令输入状态（以 / 开头且还没打空格），否则返回 null。 */
	function commandQuery() {
		const text = inputEl.value;
		if (!text.startsWith('/') || /\s/.test(text)) return null;
		return text.toLowerCase();
	}

	/** 提示条候选项：页面内命令在前，服务端命令在后；与页面命令重名的服务端命令不再列出。 */
	function commandCandidates() {
		return COMMANDS.concat(remoteCommands);
	}

	/** 把命令写成“命令名 + 参数”两段（`/model claude` → `/model` 与 `claude`）。 */
	function splitCommand(text) {
		const space = String(text || '').search(/\s/);
		return space > 0
			? { head: text.slice(0, space), rest: text.slice(space + 1).trim() }
			: { head: text, rest: '' };
	}

	/**
	 * 接收会话帧里的命令表（技能 `skill:名称`、提示模板、插件命令）。
	 * 页面只负责列出并补全，展开与派发仍由 pi 的 session.prompt() 完成。
	 */
	function setCommands(list) {
		const localNames = new Set(COMMANDS.map((command) => command.name));
		remoteCommands = (Array.isArray(list) ? list : [])
			.filter((item) => item && item.name && !localNames.has('/' + item.name))
			.map((item) => ({
				name: '/' + item.name,
				desc: String(item.description || ''),
				kind: 'insert',
				source: String(item.source || ''),
			}));
		refreshCommands();
	}

	/** 按当前输入刷新命令提示条。 */
	function refreshCommands() {
		if (isSessionPickerOpen()) {
			hideCommands();
			return;
		}
		const query = commandQuery();
		if (query === null) {
			hideCommands();
			return;
		}
		const candidates = commandCandidates();
		// 先前缀匹配；没有结果时退回子串匹配，`/read` 也能找到 `/skill:code-readability-review`
		let matches = candidates.filter((command) => command.name.toLowerCase().startsWith(query));
		if (!matches.length) {
			matches = candidates.filter((command) => command.name.toLowerCase().includes(query.slice(1)));
		}
		if (!matches.length) {
			hideCommands();
			return;
		}
		commandMatches = matches;
		if (commandIndex >= matches.length) commandIndex = 0;
		commandOpen = true;
		cmdbarEl.hidden = false;
		renderCommands();
	}

	/** 渲染命令提示条。 */
	function renderCommands() {
		cmdListEl.replaceChildren();
		commandMatches.forEach((command, index) => {
			const item = document.createElement('li');
			item.className = 'cmd-item';
			item.dataset.active = String(index === commandIndex);
			item.dataset.kind = command.kind || '';
			const name = document.createElement('span');
			name.className = 'name';
			name.textContent = command.name;
			const desc = document.createElement('span');
			desc.className = 'desc';
			desc.textContent = command.desc;
			item.append(name, desc);
			// 用 mousedown 抢在输入框失焦之前执行，避免点击被 blur 吃掉
			item.addEventListener('mousedown', (event) => {
				event.preventDefault();
				void runCommand(command.name);
			});
			cmdListEl.append(item);
		});
	}

	/** 收起命令提示条。 */
	function hideCommands() {
		commandOpen = false;
		commandMatches = [];
		cmdbarEl.hidden = true;
	}

	/** 上下键移动命令高亮。 */
	function moveCommand(delta) {
		if (!commandMatches.length) return;
		commandIndex = (commandIndex + delta + commandMatches.length) % commandMatches.length;
		renderCommands();
	}

	/** 光标前是否正好是一个 @ 引用片段；是则返回它在文本里的起始位置与查询串。 */
	function fileQueryAt() {
		const text = inputEl.value;
		const caret = inputEl.selectionStart ?? text.length;
		const before = text.slice(0, caret);
		const at = before.lastIndexOf('@');
		// @ 必须在行首或空白之后，且查询串里不能有空白（有空白说明这段引用已经写完）
		if (at < 0) return null;
		if (at > 0 && !/\s/.test(before[at - 1])) return null;
		const query = before.slice(at + 1);
		if (/\s/.test(query)) return null;
		return { start: at, query };
	}

	/** 按光标位置刷新 @ 提示条；带 120ms 防抖，不因为每敲一个字就打一次服务端。 */
	function refreshFiles() {
		// 别的浮层或命令提示条在用时，让给它们
		if (isOverlayOpen() || commandQuery() !== null) {
			hideFiles();
			return;
		}
		const token = fileQueryAt();
		if (!token) {
			hideFiles();
			return;
		}
		fileToken = token;
		const seq = ++fileFetchSeq;
		const query = token.query;
		if (fileFetchTimer) clearTimeout(fileFetchTimer);
		fileFetchTimer = setTimeout(async () => {
			fileFetchTimer = 0;
			let files = [];
			try {
				const response = await fetch('/api/files?q=' + encodeURIComponent(query));
				const data = await response.json();
				files = Array.isArray(data.files) ? data.files : [];
			} catch {
				files = [];
			}
			// 期间输入变了或提示条已收起：丢弃这次结果
			if (seq !== fileFetchSeq || !fileToken) return;
			fileItems = files;
			fileIndex = 0;
			fileOpen = true;
			filebarEl.hidden = false;
			renderFiles();
		}, 120);
	}

	/** 渲染 @ 提示条（目录以 / 结尾且用强调色区分）。 */
	function renderFiles() {
		fileListEl.replaceChildren();
		if (!fileItems.length) {
			const empty = document.createElement('li');
			empty.className = 'file-empty';
			empty.textContent = '没有匹配的文件';
			fileListEl.append(empty);
			return;
		}
		fileItems.forEach((item, index) => {
			const li = document.createElement('li');
			li.className = 'cmd-item';
			li.dataset.active = String(index === fileIndex);
			li.dataset.dir = String(Boolean(item.dir));
			const name = document.createElement('span');
			name.className = 'path';
			name.textContent = item.dir ? item.path + '/' : item.path;
			li.append(name);
			// 用 mousedown 抢在输入框失焦之前执行，避免点击被 blur 吃掉
			li.addEventListener('mousedown', (event) => {
				event.preventDefault();
				applyFile(index);
			});
			fileListEl.append(li);
		});
		const active = fileListEl.children[fileIndex];
		if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
	}

	/** 收起 @ 提示条，并作废在途的查询。 */
	function hideFiles() {
		fileFetchSeq += 1;
		if (fileFetchTimer) {
			clearTimeout(fileFetchTimer);
			fileFetchTimer = 0;
		}
		fileOpen = false;
		fileItems = [];
		fileIndex = 0;
		fileToken = null;
		filebarEl.hidden = true;
	}

	/** 上下键移动 @ 提示条高亮。 */
	function moveFile(delta) {
		if (!fileItems.length) return;
		fileIndex = (fileIndex + delta + fileItems.length) % fileItems.length;
		renderFiles();
	}

	/**
	 * 选中一条候选：把光标前的 @ 片段换成它。
	 * 文件插入相对路径并补一个空格（与 pi 的 @ 补全一致，@ 被消耗）；
	 * 目录则保留 @、插入 dir/，好接着往下钻。含空格的路径用引号包起来。
	 */
	function applyFile(index) {
		const item = fileItems[index];
		const token = fileToken;
		if (!item || !token) return;
		const text = inputEl.value;
		const caret = inputEl.selectionStart ?? text.length;
		const raw = item.dir ? item.path + '/' : item.path;
		const quoted = /[\s"]/.test(raw) ? '"' + raw.replace(/"/g, '') + '"' : raw;
		const inserted = (item.dir ? '@' : '') + quoted;
		const suffix = item.dir ? '' : ' ';
		inputEl.value = text.slice(0, token.start) + inserted + suffix + text.slice(caret);
		const nextCaret = token.start + inserted.length + suffix.length;
		inputEl.setSelectionRange(nextCaret, nextCaret);
		autoGrow();
		fileIndex = 0;
		// 目录要继续往下一层搜，文件已经写完这段引用（refreshFiles 会自行收起）
		refreshFiles();
		inputEl.focus();
	}

	/** 当前待发的图片附件。 */
	function imageAttachments() {
		return attachments.filter((item) => item.kind === 'image');
	}

	/** 是否按文本附件处理：text/* 一律算，其余看扩展名白名单。 */
	function isTextAttachment(name, mimeType) {
		if (mimeType.startsWith('text/')) return true;
		if (/^application\/(json|javascript|xml|x-yaml|yaml|x-sh|sql)$/.test(mimeType)) return true;
		const dot = name.lastIndexOf('.');
		const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
		return TEXT_ATTACH_EXTENSIONS.has(ext);
	}

	/** 字节转 base64（分块拼接，避免大文件把参数列表撑爆）。 */
	function bytesToBase64(bytes) {
		let binary = '';
		const chunk = 0x8000;
		for (let index = 0; index < bytes.length; index += chunk) {
			binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
		}
		return btoa(binary);
	}

	/** 加入一个附件：图片存 base64 与缩略图，文本直接内联进正文。 */
	async function addAttachment(file) {
		const name = String(file?.name || '未命名文件');
		const mimeType = String(file?.type || '').toLowerCase();
		if (IMAGE_MIME_TYPES.has(mimeType)) {
			if (file.size > MAX_IMAGE_BYTES) {
				addStatusRow('图片超过 ' + Math.round(MAX_IMAGE_BYTES / 1024 / 1024) + 'MB，已跳过：' + name, 'error');
				return;
			}
			if (imageAttachments().length >= MAX_ATTACH_IMAGES) {
				addStatusRow('一次最多发送 ' + MAX_ATTACH_IMAGES + ' 张图片', 'error');
				return;
			}
			let base64 = '';
			try {
				base64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
			} catch {
				addStatusRow('读取失败：' + name, 'error');
				return;
			}
			attachments.push({
				id: ++attachSeq,
				kind: 'image',
				name,
				size: file.size,
				mimeType,
				base64,
				objectUrl: URL.createObjectURL(file),
			});
			renderAttachments();
			return;
		}
		if (isTextAttachment(name, mimeType)) {
			await addTextAttachment(file, name);
			return;
		}
		addStatusRow('暂不支持这种附件：' + name + '（可改用 @ 引用让 pi 自己读）', 'error');
	}

	/** 一次加入多个附件（拖拽／粘贴可能一下丢进来好几个）。 */
	async function addAttachments(files) {
		for (const file of files) await addAttachment(file);
		inputEl.focus();
	}

	/** 文本附件：内容以围栏代码块内联进正文，并留一条可删的附件条。 */
	async function addTextAttachment(file, name) {
		let text = '';
		try {
			text = await file.text();
		} catch {
			addStatusRow('读取失败：' + name, 'error');
			return;
		}
		let truncated = false;
		if (file.size > MAX_TEXT_ATTACH_BYTES || text.length > MAX_TEXT_ATTACH_BYTES) {
			text = text.slice(0, MAX_TEXT_ATTACH_BYTES);
			truncated = true;
		}
		const body = text.endsWith('\n') ? text : text + '\n';
		const note = truncated ? '…（内容已截断）\n' : '';
		const block = '```' + name + '\n' + body + note + '```';
		const current = inputEl.value.trimEnd();
		inputEl.value = (current ? current + '\n\n' : '') + block + '\n';
		attachments.push({ id: ++attachSeq, kind: 'text', name, size: file.size, block, truncated });
		autoGrow();
		renderAttachments();
	}

	/** 画待发附件条：图片给缩略图，文本给文件名。 */
	function renderAttachments() {
		attachStripEl.replaceChildren();
		attachStripEl.hidden = attachments.length === 0;
		for (const item of attachments) {
			const chip = document.createElement('div');
			chip.className = 'attach-chip';
			chip.title = item.name;
			if (item.kind === 'image') {
				const thumb = document.createElement('img');
				thumb.className = 'attach-thumb';
				thumb.src = item.objectUrl;
				thumb.alt = item.name;
				chip.append(thumb);
			}
			const label = document.createElement('span');
			label.className = 'attach-name';
			label.textContent = item.name + (item.truncated ? '（已截断）' : '');
			const remove = document.createElement('button');
			remove.className = 'attach-remove';
			remove.type = 'button';
			remove.title = '移除附件';
			remove.textContent = '×';
			remove.addEventListener('click', () => removeAttachment(item.id));
			chip.append(label, remove);
			attachStripEl.append(chip);
		}
		syncJumpPosition();
	}

	/** 移除一个待发附件；文本附件同时从正文里删掉它内联的代码块。 */
	function removeAttachment(id) {
		const index = attachments.findIndex((item) => item.id === id);
		if (index < 0) return;
		const [item] = attachments.splice(index, 1);
		if (item.kind === 'image' && item.objectUrl) URL.revokeObjectURL(item.objectUrl);
		if (item.kind === 'text' && item.block) {
			inputEl.value = inputEl.value.replace(item.block, '').trimEnd();
			autoGrow();
		}
		renderAttachments();
	}

	/** 清空待发附件；发送后传 revoke=false，因为本地回显的缩略图还在用这些 blob URL。 */
	function clearAttachments({ revoke = true } = {}) {
		for (const item of attachments) {
			if (revoke && item.kind === 'image' && item.objectUrl) URL.revokeObjectURL(item.objectUrl);
		}
		attachments = [];
		renderAttachments();
	}

	/** 原地重载服务端资源；会话帧会同步最新命令与插件错误，不刷新页面。 */
	async function reloadResources() {
		try {
			const response = await fetch('/api/reload', { method: 'POST' });
			const data = await response.json();
			if (!response.ok) throw new Error(data.error || '服务端拒绝重载');
			addStatusRow('资源已重载');
		} catch (err) {
			addStatusRow('重载失败：' + String(err?.message || err), 'error');
		}
	}

	/** 请求手动压缩，显示结果；不创建用户消息，也不把命令交给模型。 */
	async function compactContext(instructions) {
		try {
			const response = await fetch('/api/compact', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ instructions }),
			});
			const data = await response.json();
			if (!response.ok) throw new Error(data.error || '服务端拒绝压缩');
			if (data.cancelled) {
				addStatusRow('压缩已取消');
				return;
			}
			const before = data.result?.tokensBefore;
			const after = data.result?.estimatedTokensAfter;
			const tokens = Number.isFinite(before) && Number.isFinite(after)
				? ` · ${Math.round(before).toLocaleString()} → 约 ${Math.round(after).toLocaleString()} tokens` : '';
			addStatusRow('压缩完成' + tokens);
		} catch (err) {
			addStatusRow('压缩失败：' + String(err?.message || err), 'error');
		}
	}

	/** 执行页面内命令：只在本页处理，不会发给模型。 */
	async function runActionCommand(head, rest) {
		if (isCompacting()) {
			addStatusRow('会话正在压缩，请等待结束或先中止', 'error');
			return;
		}
		hideCommands();
		inputEl.value = '';
		autoGrow();
		if (head === '/resume') await openSessionPicker();
		else if (head === '/model') await openModelPicker(rest);
		else if (head === '/rewind') await openRewind();
		else if (head === '/reload') await reloadResources();
		else if (head === '/compact') await compactContext(rest);
		else await newSession();
	}

	/**
	 * 提示条选中命令后的动作。
	 * 页面命令直接执行；技能 / 模板 / 插件命令只把 `/名称 ` 补进输入框（尾部留空格好接参数），
	 * 由用户回车发送、pi 自己展开。返回 false 表示不是已知命令（当作普通消息发送）。
	 */
	async function runCommand(name) {
		const text = String(name || '').trim();
		const { head, rest } = splitCommand(text);
		const command = commandCandidates().find((item) => item.name === head);
		if (!command) return false;
		if (command.kind === 'insert') {
			hideCommands();
			setText(command.name + ' ', { caret: true });
			return true;
		}
		await runActionCommand(head, rest);
		return true;
	}

	/** 发送一条消息（运行中时服务端会自动转为 steer）；图片附件随消息一起发。 */
	async function send() {
		const text = inputEl.value.trim();
		const images = imageAttachments().map((item) => ({ data: item.base64, mimeType: item.mimeType }));
		if (!text && !images.length) return;
		if (isCompacting()) {
			addStatusRow('会话正在压缩，请等待结束或先中止', 'error');
			return;
		}
		// 页面内命令（/resume、/model、/new、/rewind、/reload、/compact）只在本页处理，不发给模型；
		// 技能 / 模板 / 插件命令不走这里，原样发送交给 pi 展开。
		const { head, rest } = splitCommand(text);
		if (COMMANDS.some((command) => command.name === head)) {
			await runActionCommand(head, rest);
			return;
		}
		// 发送前先留下本地缩略图信息，清单清空后再画本地行
		const previews = imageAttachments().map((item) => ({ objectUrl: item.objectUrl, mimeType: item.mimeType }));
		inputEl.value = '';
		autoGrow();
		// revoke=false：本地回显的缩略图还在用这些 blob URL
		clearAttachments({ revoke: false });
		addUserMessage(text, previews);
		followFrame(pinnedToBottom());
		await fetch('/api/prompt', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(images.length ? { message: text, images } : { message: text }),
		}).catch(() => addStatusRow('发送失败：本地服务没有响应', 'error'));
	}

	/** 输入框按内容自动增高（1～8 行左右）；未到上限时不出现滚动条。 */
	function autoGrow() {
		inputEl.style.height = 'auto';
		// scrollHeight 不含边框，按实际计算值补齐；当前输入框无边框，换样式后仍可复用。
		const computed = getComputedStyle(inputEl);
		const borders = parseFloat(computed.borderTopWidth) + parseFloat(computed.borderBottomWidth);
		const wanted = inputEl.scrollHeight + borders;
		// 上限跟着视口高度走：矮窗口下输入框不该把消息区顶没
		const maxHeight = Math.min(200, window.innerHeight * 0.4);
		inputEl.style.height = Math.min(wanted, maxHeight) + 'px';
		// 只有到上限、内容确实放不下时才让 textarea 自己滚动
		inputEl.style.overflowY = wanted > maxHeight ? 'auto' : 'hidden';
		syncJumpPosition();
	}

	/** 写入编辑器并刷新高度，回退场景可显式将光标放到末尾。 */
	function setText(text, { caret = false } = {}) {
		inputEl.value = String(text || '');
		autoGrow();
		inputEl.focus();
		if (caret) inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
	}

	/** 初始化输入、附件和补全监听，不接管浮层内部键位。 */
	function init() {
		sendEl.addEventListener('click', () => void send());
		inputEl.addEventListener('input', () => {
			autoGrow();
			refreshCommands();
			refreshFiles();
		});
		// 附件入口：回形针选文件、拖拽、粘贴图片（内容只在浏览器本地读，不经服务端读盘）
		attachBtnEl.addEventListener('click', () => filePickerEl.click());
		filePickerEl.addEventListener('change', () => {
			const files = [...filePickerEl.files];
			filePickerEl.value = '';
			if (files.length) void addAttachments(files);
		});
		composerEl.addEventListener('dragover', (event) => {
			event.preventDefault();
		});
		composerEl.addEventListener('drop', (event) => {
			const files = [...(event.dataTransfer?.files ?? [])];
			if (!files.length) return;
			event.preventDefault();
			void addAttachments(files);
		});
		inputEl.addEventListener('paste', (event) => {
			// items 与 files 是同一份剪贴板内容的两种视图，合并会把一张图算两次
			const items = [...(event.clipboardData?.items ?? [])];
			const pasted = items.filter((item) => item.kind === 'file').map((item) => item.getAsFile()).filter(Boolean);
			const files = pasted.length ? pasted : [...(event.clipboardData?.files ?? [])];
			if (!files.length) return;
			event.preventDefault();
			void addAttachments(files);
		});
		inputEl.addEventListener('keydown', (event) => {
			if (handleOverlayKey(event)) return;
			// 命令提示条打开时，键盘先服务于提示条
			if (commandOpen) {
				if (event.key === 'Escape') {
					event.preventDefault();
					hideCommands();
					return;
				}
				if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
					event.preventDefault();
					moveCommand(event.key === 'ArrowDown' ? 1 : -1);
					return;
				}
				if (event.key === 'Enter' || event.key === 'Tab') {
					event.preventDefault();
					const command = commandMatches[commandIndex];
					if (command) void runCommand(command.name);
					return;
				}
			}
			// @ 提示条打开时，键盘先服务于提示条
			if (fileOpen) {
				if (event.key === 'Escape') {
					event.preventDefault();
					hideFiles();
					return;
				}
				if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
					event.preventDefault();
					moveFile(event.key === 'ArrowDown' ? 1 : -1);
					return;
				}
				if ((event.key === 'Enter' || event.key === 'Tab') && fileItems.length) {
					event.preventDefault();
					applyFile(fileIndex);
					return;
				}
			}
			if (event.key === 'Enter' && !event.shiftKey) {
				event.preventDefault();
				void send();
			}
		});
		inputEl.addEventListener('blur', () => { hideCommands(); hideFiles(); });
		autoGrow();
	}

	return { init, setText, setCommands };
}
