/** 汇总浮层：文件与使用汇总两个标签；数据只来自服务端帧，不在页面二次推测。 */
import { enterSheet, leaveSheet } from './sheets.mjs';

/** 使用方式的展示文案；未知方式不显示。 */
const USAGE_LABELS = { tool: '工具调用', command: '命令调用', explicit: '显式调用', read: '已读取' };

export function createSummary() {
	const overlay = document.getElementById('summaryOverlay');
	const closeEl = document.getElementById('summaryClose');
	const footEl = document.getElementById('summaryFoot');
	const filesEl = document.getElementById('summaryFiles');
	const usageEl = document.getElementById('summaryUsage');
	const tabFilesEl = document.getElementById('summaryTabFiles');
	const tabUsageEl = document.getElementById('summaryTabUsage');
	const button = document.getElementById('summary');
	let sessionId = null;
	let openState = false;
	let tab = 'files';
	let filesSerialized = '';
	let usageSerialized = '';
	let usagePersistent = null;

	/** 一行空态提示；两个标签共用。 */
	function plain(text) {
		const item = document.createElement('li');
		item.className = 'picker-item plain';
		item.textContent = text;
		return item;
	}

	/** 组装一行：左侧图标、中间名称（悬停看来源路径）、右侧方式标记。 */
	function row(markText, nameText, location, modesText) {
		const item = document.createElement('li');
		item.className = 'picker-item';
		const mark = document.createElement('span');
		mark.className = 'mark';
		mark.textContent = markText;
		const main = document.createElement('span');
		main.className = 'main';
		const title = document.createElement('span');
		title.className = 'title';
		title.textContent = nameText;
		title.title = location;
		main.append(title);
		const mode = document.createElement('span');
		mode.className = 'meta';
		mode.textContent = modesText;
		item.append(mark, main, mode);
		return item;
	}

	/** 文件标签：一行一个路径，右侧标「读取 / 修改」。 */
	function renderFiles(usage) {
		const files = Array.isArray(usage?.files) ? usage.files : [];
		const next = JSON.stringify(files);
		if (next === filesSerialized) return;
		filesSerialized = next;
		const scrollTop = filesEl.scrollTop;
		filesEl.replaceChildren();
		if (!files.length) filesEl.append(plain('这个会话还没有读取或修改文件'));
		for (const file of files) {
			const modes = (Array.isArray(file.modes) ? file.modes : [])
				.map((value) => (value === 'read' ? '读取' : value === 'modified' ? '修改' : ''))
				.filter(Boolean)
				.join(' · ');
			filesEl.append(row('▤', String(file.path || '未知路径'), String(file.path || ''), modes));
		}
		filesEl.scrollTop = scrollTop;
	}

	/** 使用汇总里的一个分组：标题带数量，条目按名称与方式列出。 */
	function renderGroup(title, items) {
		const heading = document.createElement('li');
		heading.className = 'picker-group';
		heading.textContent = title + ' · ' + items.length;
		usageEl.append(heading);
		if (!items.length) {
			usageEl.append(plain('暂无可识别的使用记录'));
			return;
		}
		for (const item of items) {
			const modes = (Array.isArray(item.modes) ? item.modes : []).map((value) => USAGE_LABELS[value]).filter(Boolean).join(' · ');
			usageEl.append(row('◇', String(item.name || '未知来源'), String(item.location || ''), modes));
		}
	}

	/** 使用汇总标签：按「插件 / Skill」分组，脚注沿用原有统计口径说明。 */
	function renderUsage(usage) {
		const plugins = Array.isArray(usage?.plugins) ? usage.plugins : [];
		const skills = Array.isArray(usage?.skills) ? usage.skills : [];
		const next = JSON.stringify({ plugins, skills, persistent: usage?.persistent });
		if (next === usageSerialized) return;
		usageSerialized = next;
		usagePersistent = usage?.persistent;
		const scrollTop = usageEl.scrollTop;
		usageEl.replaceChildren();
		renderGroup('插件', plugins);
		renderGroup('Skill', skills);
		usageEl.scrollTop = scrollTop;
		syncFoot();
	}

	/** 脚注随标签切换：两边口径不同，不能共用一句。 */
	function syncFoot() {
		if (tab === 'files') {
			footEl.textContent = '仅统计当前分支；bash / powershell 里的文件改动不计入。';
			return;
		}
		footEl.textContent = '仅统计当前分支。插件调用不等于成功；Skill 已读取不代表一定遵循。' +
			(usagePersistent === false ? '当前 SDK 不支持持久化使用元数据。' : '');
	}

	/** 切换标签；同一时刻只有一个列表可见。 */
	function selectTab(next) {
		tab = next === 'usage' ? 'usage' : 'files';
		const showUsage = tab === 'usage';
		tabFilesEl.setAttribute('aria-selected', String(!showUsage));
		tabUsageEl.setAttribute('aria-selected', String(showUsage));
		filesEl.hidden = showUsage;
		usageEl.hidden = !showUsage;
		syncFoot();
	}

	/** 打开模态并把焦点移进当前标签。 */
	function open() {
		openState = true;
		overlay.hidden = false;
		enterSheet(overlay, tab === 'usage' ? tabUsageEl : tabFilesEl);
		selectTab(tab);
	}

	/** 关闭模态并把焦点还给顶栏按钮。 */
	function close() {
		openState = false;
		overlay.hidden = true;
		leaveSheet(overlay);
	}

	/** 换会话时关闭并清空两个标签；同一会话重连不影响数据。 */
	function setContext(context) {
		if (!context) return;
		if (sessionId !== context.sessionId) {
			sessionId = context.sessionId;
			filesSerialized = '';
			usageSerialized = '';
			filesEl.scrollTop = 0;
			usageEl.scrollTop = 0;
			if (openState) close();
		}
		renderFiles(context.fileUsage);
		renderUsage(context.resourceUsage);
	}

	/** 只接收服务端两类汇总帧，不从工具名或消息正文在页面二次推测。 */
	function handleFrame(frame) {
		if (frame.kind === 'file_usage') {
			if (frame.sessionId === sessionId) renderFiles(frame.usage);
			return true;
		}
		if (frame.kind === 'resource_usage') {
			if (frame.sessionId === sessionId) renderUsage(frame.usage);
			return true;
		}
		return false;
	}

	/** 安装入口、标签、关闭与遮罩交互。 */
	function init() {
		button.addEventListener('click', () => (openState ? close() : open()));
		closeEl.addEventListener('click', close);
		overlay.addEventListener('click', (event) => {
			if (event.target === overlay) close();
		});
		tabFilesEl.addEventListener('click', () => selectTab('files'));
		tabUsageEl.addEventListener('click', () => selectTab('usage'));
		document.addEventListener('keydown', (event) => {
			if (event.key === 'Escape' && openState) close();
		});
		selectTab('files');
	}

	/** 编辑器补全在模态展开时让位。 */
	function isOpen() { return openState; }

	return { init, setContext, handleFrame, isOpen };
}
