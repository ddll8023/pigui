/** 用 DOM API 渲染 Markdown 和代码，不解析模型输出中的 HTML。 */

/** 各语言的着色规则：数组顺序即优先级；外层会统一加捕获组，所以内部只能用非捕获组。 */
const HIGHLIGHT_RULES = {
	js: [
		['comment', /\/\/[^\n]*|\/\*[\s\S]*?\*\//],
		['string', /"[^"\n]*"|'[^'\n]*'|`[^`]*`/],
		['number', /\b\d[\d_]*(?:\.[\d_]+)?\b|\b0x[\da-fA-F]+\b/],
		[
			'keyword',
			/\b(?:const|let|var|function|return|if|else|for|while|do|break|continue|new|class|extends|import|export|from|default|await|async|try|catch|finally|throw|typeof|instanceof|delete|in|of|switch|case|yield|static|this|super|void|null|undefined|true|false)\b/,
		],
	],
	json: [
		['key', /"[^"\n]*"(?=\s*:)/],
		['string', /"[^"\n]*"/],
		['number', /-?\b\d+(?:\.\d+)?\b/],
		['keyword', /\b(?:true|false|null)\b/],
	],
	py: [
		['comment', /#[^\n]*/],
		['string', /"""[\s\S]*?"""|'''[\s\S]*?'''|"[^"\n]*"|'[^'\n]*'/],
		[
			'keyword',
			/\b(?:def|class|return|if|elif|else|for|while|break|continue|import|from|as|with|try|except|finally|raise|lambda|yield|global|nonlocal|pass|assert|del|in|is|not|and|or|None|True|False|async|await)\b/,
		],
		['number', /\b\d[\d_]*(?:\.[\d_]+)?\b/],
	],
	bash: [
		['comment', /#[^\n]*/],
		['string', /"[^"\n]*"|'[^'\n]*'/],
		['variable', /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/],
		[
			'keyword',
			/\b(?:if|then|else|elif|fi|for|while|do|done|case|esac|function|return|export|local|readonly|source|echo|cd|set|unset|exit|trap|sudo|npm|node|git|uv|ls|cat|mkdir|rm|cp|mv|grep|curl)\b/,
		],
	],
	html: [
		['comment', /<!--[\s\S]*?-->/],
		['tag', /<\/?[A-Za-z][\w:-]*/],
		['string', /"[^"\n]*"|'[^'\n]*'/],
	],
	css: [
		['comment', /\/\*[\s\S]*?\*\//],
		['string', /"[^"\n]*"|'[^'\n]*'/],
		['number', /#[0-9a-fA-F]{3,8}\b|-?\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg)?\b/],
		['property', /[a-z-]+(?=\s*:)/],
		['selector', /[.#][\w-]+|@[\w-]+/],
	],
	md: [
		['string', /`[^`\n]*`|\*\*[^*\n]+\*\*/],
		['comment', /^> .*$/m],
		['variable', /^\s*[-*+] /m],
		['keyword', /^#{1,6} .*$/m],
	],
};

/** 语言别名归一化，便于复用同一套着色规则。 */
function normalizeLang(lang) {
	const key = String(lang || '').trim().toLowerCase();
	if (!key) return '';
	if (/^(js|jsx|mjs|cjs|node|ts|tsx|typescript)$/.test(key)) return 'js';
	if (/^(json|jsonc)$/.test(key)) return 'json';
	if (/^(py|python)$/.test(key)) return 'py';
	if (/^(sh|bash|shell|zsh|console|shellsession)$/.test(key)) return 'bash';
	if (/^(html|htm|xml|svg|vue)$/.test(key)) return 'html';
	if (/^(css|scss|less)$/.test(key)) return 'css';
	if (/^(md|markdown)$/.test(key)) return 'md';
	return '';
}

/** 按语言给代码着色，返回可直接 append 的节点数组；未识别的语言原样输出。 */
function highlightCode(code, lang) {
	const text = String(code == null ? '' : code);
	const rules = HIGHLIGHT_RULES[normalizeLang(lang)];
	if (!rules || !text) return [document.createTextNode(text)];
	// 带上 m 标志：md 等规则用 ^ / $ 按行匹配
	const combined = new RegExp(rules.map(([, rule]) => '(' + rule.source + ')').join('|'), 'gm');
	const nodes = [];
	let last = 0;
	for (const match of text.matchAll(combined)) {
		if (!match[0]) break;
		if (match.index > last) nodes.push(document.createTextNode(text.slice(last, match.index)));
		const index = match.slice(1).findIndex((group) => group !== undefined);
		const span = document.createElement('span');
		span.className = 'tok-' + (rules[index] ? rules[index][0] : 'plain');
		span.textContent = match[0];
		nodes.push(span);
		last = match.index + match[0].length;
	}
	if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
	return nodes;
}

/** 构造代码块（含语言标签与复制按钮）。 */
function buildCodeBlock(lang, code) {
	const wrap = document.createElement('div');
	wrap.className = 'code-block';
	const head = document.createElement('div');
	head.className = 'code-head';
	const tag = document.createElement('span');
	tag.className = 'lang';
	tag.textContent = lang || 'text';
	const copy = document.createElement('button');
	copy.type = 'button';
	copy.className = 'copy';
	copy.textContent = '复制';
	copy.addEventListener('click', () => {
		/** 复制成功后短暂提示，再恢复按钮文案。 */
		const done = () => {
			copy.textContent = '已复制';
			setTimeout(() => {
				copy.textContent = '复制';
			}, 1200);
		};
		if (navigator.clipboard) navigator.clipboard.writeText(code).then(done, () => {});
	});
	head.append(tag, copy);
	const pre = document.createElement('pre');
	const codeEl = document.createElement('code');
	for (const piece of highlightCode(code, lang)) codeEl.append(piece);
	pre.append(codeEl);
	wrap.append(head, pre);
	return wrap;
}

/** 行内 Markdown：**粗体**、*斜体* / _斜体_、~~删除线~~、`代码`、[文本](链接)，支持反斜杠转义。 */
function renderInline(text, parent) {
	const pattern =
		/(\\(?:[*_`~])|!\[[^\]\n]*\]\(https?:\/\/[^)\s]+\)|\*\*[^*\n]+\*\*|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_|`[^`\n]+`|\[[^\]\n]+\]\((?:https?:\/\/|#|\/)[^)\s]+\))/g;
	let last = 0;
	for (const match of text.matchAll(pattern)) {
		if (match.index > last) parent.append(document.createTextNode(text.slice(last, match.index)));
		const token = match[0];
		if (token.startsWith('\\')) {
			parent.append(document.createTextNode(token.slice(1)));
		} else if (token.startsWith('**')) {
			const node = document.createElement('strong');
			renderInline(token.slice(2, -2), node);
			parent.append(node);
		} else if (token.startsWith('~~')) {
			const node = document.createElement('del');
			renderInline(token.slice(2, -2), node);
			parent.append(node);
		} else if (token.startsWith('`')) {
			const node = document.createElement('code');
			node.textContent = token.slice(1, -1);
			parent.append(node);
		} else if (token.startsWith('![')) {
			const parts = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(token);
			const image = document.createElement('img');
			image.className = 'md-image';
			image.src = parts[2];
			image.alt = parts[1] || '';
			image.loading = 'lazy';
			parent.append(image);
		} else if (token.startsWith('[')) {
			const parts = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
			const link = document.createElement('a');
			link.textContent = parts[1];
			link.href = parts[2];
			link.target = '_blank';
			link.rel = 'noreferrer noopener';
			parent.append(link);
		} else {
			const node = document.createElement('em');
			renderInline(token.slice(1, -1), node);
			parent.append(node);
		}
		last = match.index + token.length;
	}
	if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
}

/** 极简 Markdown 块级渲染：围栏代码块、标题、列表、引用、分隔线、段落。
    全部用 DOM API 构建，不经过 innerHTML，因此模型输出里的 HTML 不会被解析。 */
export function renderMarkdown(text, container) {
	try {
		renderMarkdownBlocks(String(text == null ? '' : text), container);
	} catch {
		const fallback = document.createElement('div');
		fallback.className = 'stream-text';
		fallback.textContent = String(text == null ? '' : text);
		container.append(fallback);
	}
}

/** 流式渲染的落定边界：返回可整块按 Markdown 渲染的前缀长度。
    只认围栏外的空行之后与围栏收尾行之后，不去猜半行语法是否写完；
    返回 0 表示还没有可以落定的块。 */
export function closedMarkdownLength(text) {
	const lines = String(text == null ? '' : text).split('\n');
	let inFence = false;
	let boundary = 0;
	let offset = 0;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		// 末尾那个空串只是换行符的副产物，不能当分隔空行用
		const next = offset + line.length + (index < lines.length - 1 ? 1 : 0);
		if (/^\s*```/.test(line)) {
			inFence = !inFence;
			if (!inFence) boundary = next;
		} else if (!inFence && index < lines.length - 1 && /^\s*$/.test(line)) {
			boundary = next;
		}
		offset = next;
	}
	return boundary;
}

/** renderMarkdown 的实际实现（异常由调用方兜底）。 */
function renderMarkdownBlocks(text, container) {
	const lines = text.split('\n');
	let paragraph = [];
	let i = 0;

	// 段落内的单换行按换行显示（与 GitHub 现行行为一致）
	const flushParagraph = () => {
		if (!paragraph.length) return;
		const node = document.createElement('p');
		paragraph.forEach((text, index) => {
			if (index > 0) node.append(document.createElement('br'));
			renderInline(text, node);
		});
		container.append(node);
		paragraph = [];
	};

	while (i < lines.length) {
		const line = lines[i];

		if (/^\s*```/.test(line)) {
			flushParagraph();
			const lang = line.replace(/^\s*```/, '').trim();
			const code = [];
			i += 1;
			while (i < lines.length && !/^\s*```/.test(lines[i])) {
				code.push(lines[i]);
				i += 1;
			}
			i += 1;
			container.append(buildCodeBlock(lang, code.join('\n')));
			continue;
		}

		// 表格：本行含 | 且下一行是分隔行（|---|:--:|）
		if (line.includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
			flushParagraph();
			const headerCells = splitTableRow(line);
			const aligns = splitTableRow(lines[i + 1]).map((cell) => {
				const text = cell.trim();
				const left = text.startsWith(':');
				const right = text.endsWith(':');
				if (left && right) return 'center';
				if (right) return 'right';
				if (left) return 'left';
				return '';
			});
			const rows = [];
			let rowIndex = i + 2;
			while (rowIndex < lines.length && lines[rowIndex].includes('|') && lines[rowIndex].trim()) {
				rows.push(splitTableRow(lines[rowIndex]));
				rowIndex += 1;
			}
			container.append(buildTable(headerCells, aligns, rows));
			i = rowIndex;
			continue;
		}

		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			flushParagraph();
			const node = document.createElement('h' + heading[1].length);
			renderInline(heading[2], node);
			container.append(node);
			i += 1;
			continue;
		}

		if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
			flushParagraph();
			container.append(document.createElement('hr'));
			i += 1;
			continue;
		}

		if (/^>\s?/.test(line)) {
			flushParagraph();
			const quoted = [];
			while (i < lines.length && /^>\s?/.test(lines[i])) {
				quoted.push(lines[i].replace(/^>\s?/, ''));
				i += 1;
			}
			const node = document.createElement('blockquote');
			// 引用里也可能有列表、代码块，递归按块渲染
			renderMarkdownBlocks(quoted.join('\n'), node);
			container.append(node);
			continue;
		}

		const listItem = matchListItem(line);
		if (listItem) {
			flushParagraph();
			const built = buildList(lines, i, listItem.indent);
			container.append(built.node);
			i = built.next;
			continue;
		}

		if (/^\s*$/.test(line)) {
			flushParagraph();
			i += 1;
			continue;
		}

		paragraph.push(line);
		i += 1;
	}
	flushParagraph();
}

/** 拆分表格行：去掉首尾竖线后按 | 切单元格。 */
function splitTableRow(line) {
	let text = String(line).trim();
	if (text.startsWith('|')) text = text.slice(1);
	if (text.endsWith('|')) text = text.slice(0, -1);
	return text.split('|').map((cell) => cell.trim());
}

/** 是否是表格分隔行（|---|:--:|）。 */
function isTableDivider(line) {
	if (!String(line).includes('|')) return false;
	const cells = splitTableRow(line);
	return cells.length > 0 && cells.every((cell) => /^:?-{1,}:?$/.test(cell.trim()));
}

/** 构建表格：第一行为表头，aligns 决定每列对齐。 */
function buildTable(headerCells, aligns, rows) {
	const wrap = document.createElement('div');
	wrap.className = 'table-wrap';
	const table = document.createElement('table');
	const thead = document.createElement('thead');
	const headRow = document.createElement('tr');
	headerCells.forEach((cell, index) => {
		const th = document.createElement('th');
		if (aligns[index]) th.style.textAlign = aligns[index];
		renderInline(cell, th);
		headRow.append(th);
	});
	thead.append(headRow);
	table.append(thead);
	const tbody = document.createElement('tbody');
	for (const row of rows) {
		const tr = document.createElement('tr');
		headerCells.forEach((_, index) => {
			const td = document.createElement('td');
			if (aligns[index]) td.style.textAlign = aligns[index];
			renderInline(row[index] || '', td);
			tr.append(td);
		});
		tbody.append(tr);
	}
	table.append(tbody);
	wrap.append(table);
	return wrap;
}

/** 识别列表项：返回缩进、类型、起始序号、任务框与内容；不是列表项则返回 null。 */
function matchListItem(line) {
	const match = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
	if (!match) return null;
	const indent = match[1].replace(/\t/g, '    ').length;
	const ordered = /\d/.test(match[2]);
	let content = match[3];
	let task = null;
	const box = /^\[([ xX])\]\s+(.*)$/.exec(content);
	if (box) {
		task = box[1].toLowerCase() === 'x';
		content = box[2];
	}
	return {
		indent,
		ordered,
		start: ordered ? Number(match[2].replace(/[.)]$/, '')) || 1 : 1,
		task,
		content,
	};
}

/** 构建列表（按缩进递归建嵌套层级），返回 { node, next }。 */
function buildList(lines, start, baseIndent) {
	const first = matchListItem(lines[start]);
	const list = document.createElement(first.ordered ? 'ol' : 'ul');
	if (first.ordered && first.start > 1) list.start = first.start;
	let index = start;
	let hasItem = false;
	while (index < lines.length) {
		const line = lines[index];
		if (!line.trim()) break;
		const item = matchListItem(line);
		if (!item || item.indent < baseIndent) break;
		if (item.indent >= baseIndent + 2 && hasItem) {
			// 缩进更深 → 作为上一个条目的子列表
			const sub = buildList(lines, index, item.indent);
			list.lastElementChild.append(sub.node);
			index = sub.next;
			continue;
		}
		const li = document.createElement('li');
		if (item.task !== null) {
			li.className = 'task';
			const mark = document.createElement('span');
			mark.className = 'task-box';
			mark.textContent = item.task ? '☑' : '☐';
			li.append(mark);
		}
		const text = document.createElement('span');
		text.className = 'li-text';
		renderInline(item.content, text);
		li.append(text);
		list.append(li);
		hasItem = true;
		index += 1;
		// 该条目下缩进更深的普通行，算作它的续行
		while (
			index < lines.length &&
			lines[index].trim() &&
			!matchListItem(lines[index]) &&
			/^\s+\S/.test(lines[index])
		) {
			text.append(document.createElement('br'));
			renderInline(lines[index].trim(), text);
			index += 1;
		}
	}
	return { node: list, next: index };
}
