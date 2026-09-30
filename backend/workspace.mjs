/** 工作目录文件索引与搜索 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

/** @ 搜索一次最多返回多少条候选。 */
const FILE_SEARCH_LIMIT = 50;

/** 文件索引的条数上限：没有 git 的目录靠遍历兜底，避免把整盘扫一遍。 */
const FILE_INDEX_MAX = 20000;

/** 文件索引的缓存时间：@ 每敲一个字都会查一次，不能每次真的去列目录。 */
const FILE_INDEX_TTL_MS = 10000;

/** 兜底遍历时直接跳过的目录名（有 git 时交给 .gitignore，不看这张表）。 */
const IGNORED_DIRS = new Set([
	'.git',
	'node_modules',
	'dist',
	'build',
	'.next',
	'.venv',
	'venv',
	'__pycache__',
	'target',
	'coverage',
	'out',
	'.cache',
	'.idea',
	'.vscode',
]);

/** 创建工作目录文件索引与搜索；资源和状态由实例持有。 */
export function createWorkspace({ cwd }) {
	/** 文件索引缓存：{ at, files, dirs }；@ 每敲一个字都会查一次。 */
	let fileIndexCache = null;

	/** 列出工作目录里的文件（相对 cwd、POSIX 分隔符）；带缓存。 */
	async function workspaceIndex() {
		if (fileIndexCache && Date.now() - fileIndexCache.at < FILE_INDEX_TTL_MS) return fileIndexCache;
		const files = (await gitFileList()) ?? (await walkFileList());
		fileIndexCache = { at: Date.now(), files, dirs: dirsOfFiles(files) };
		return fileIndexCache;
	}

	/** 试 `git ls-files`：顺带遵守 .gitignore；返回 null 表示不可用（非仓库 / 没装 git / 超时）。 */
	function gitFileList() {
		return new Promise((resolve) => {
			execFile(
				'git',
				['ls-files', '-co', '--exclude-standard', '-z'],
				{ cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
				(err, stdout) => {
					if (err) return resolve(null);
					const files = String(stdout).split('\0').filter(Boolean);
					resolve(files.length ? files.slice(0, FILE_INDEX_MAX) : null);
				},
			);
		});
	}

	/** 兜底遍历：没有 git 时用，跳过 IGNORED_DIRS 与文件数上限之外的内容。 */
	async function walkFileList() {
		const files = [];
		/** 按目录递归索引，遵守忽略目录及总条数上限。 */
		const walk = async (dir) => {
			if (files.length >= FILE_INDEX_MAX) return;
			let entries;
			try {
				entries = await fs.promises.readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				if (files.length >= FILE_INDEX_MAX) return;
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					if (IGNORED_DIRS.has(entry.name)) continue;
					await walk(full);
					continue;
				}
				if (!entry.isFile()) continue;
				files.push(path.relative(cwd, full).split(path.sep).join('/'));
			}
		};
		await walk(cwd);
		return files;
	}

	/** 由文件列表推出目录集合，让 @ 列表里也能选中目录往下钻。 */
	function dirsOfFiles(files) {
		const dirs = new Set();
		for (const file of files) {
			let index = file.lastIndexOf('/');
			while (index > 0) {
				dirs.add(file.slice(0, index));
				index = file.lastIndexOf('/', index - 1);
			}
		}
		return [...dirs];
	}

	/** 按查询串过滤索引：路径前缀 > basename 前缀 > basename 含 > 路径含，目录优先。 */
	function searchWorkspaceFiles(index, query) {
		const needle = query.trim().toLowerCase().replace(/^\.\//, '');
		const candidates = [
			...index.dirs.map((dir) => ({ path: dir, dir: true })),
			...index.files.map((file) => ({ path: file, dir: false })),
		];
		if (!needle) {
			// 刚打一个 @：按层级从浅到深给，先让用户看到顶层条目
			return candidates
				.sort(
					(a, b) =>
						a.path.split('/').length - b.path.split('/').length ||
						a.path.length - b.path.length ||
						a.path.localeCompare(b.path),
				)
				.slice(0, FILE_SEARCH_LIMIT);
		}
		const ranked = [];
		for (const item of candidates) {
			const lower = item.path.toLowerCase();
			const slash = lower.lastIndexOf('/');
			const base = slash >= 0 ? lower.slice(slash + 1) : lower;
			let rank = -1;
			if (lower.startsWith(needle)) rank = 0;
			else if (base.startsWith(needle)) rank = 1;
			else if (base.includes(needle)) rank = 2;
			else if (lower.includes(needle)) rank = 3;
			if (rank < 0) continue;
			ranked.push({ item, rank, tier: item.dir ? 0 : 1 });
		}
		ranked.sort(
			(a, b) =>
				a.rank - b.rank ||
				a.tier - b.tier ||
				a.item.path.length - b.item.path.length ||
				a.item.path.localeCompare(b.item.path),
		);
		return ranked.slice(0, FILE_SEARCH_LIMIT).map((entry) => entry.item);
	}

	return { workspaceIndex, searchWorkspaceFiles };
}
