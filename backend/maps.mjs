/** 当前工作目录的 Mellos 地图只读入口；不建目录、不改地图，也不启动上游工具。 */
import { open, realpath, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** 限制本地文件与图的规模，避免损坏的地图耗尽内存或堵塞页面。 */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 100;
const ID_RULE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const STATUSES = new Set(['planned', 'in-progress', 'done', 'regressed']);
const KINDS = new Set(['dev', 'architecture', 'dataflow', 'behavior-tree', 'sequence']);

/** 判断真实路径是否仍在工作目录内；Windows 的大小写比较交给 path.relative。 */
function within(root, target) {
	const relative = path.relative(root, target);
	return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}

/** 读取字符串字段；说明和证据允许换行，所有内容仍由前端以纯文本展示。 */
function text(record, key, optional = false, multiline = false) {
	const value = record[key];
	if (value === undefined && optional) return undefined;
	if (typeof value !== 'string') throw new Error(`${key} 必须是文本`);
	const forbidden = multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/;
	if (forbidden.test(value)) throw new Error(`${key} 包含不可显示的控制字符`);
	return value;
}

/** 读取唯一的 slug 标识，拒绝歧义和不能安全引用的节点名。 */
function identifier(record, key) {
	const value = text(record, key);
	if (!ID_RULE.test(value)) throw new Error(`${key} 不是有效的地图标识`);
	return value;
}

/** 有界读取数组，并拒绝数组里的非对象值。 */
function records(raw, key, limit, optional = false) {
	const list = raw[key];
	if (list === undefined && optional) return [];
	if (!Array.isArray(list) || list.length > limit) throw new Error(`${key} 必须是数组，且最多 ${limit} 项`);
	if (list.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
		throw new Error(`${key} 的每一项必须是对象`);
	}
	return list;
}

/** 校验 Mellos v1/v2 的分层结构，投影出绘图字段；不宣称重新执行过节点证据。 */
function parseMap(raw) {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('地图根节点必须是对象');
	if (raw.version !== 1 && raw.version !== 2) throw new Error('仅支持 Mellos 地图格式 v1 / v2');
	const kind = text(raw, 'kind', true) ?? 'dev';
	if (!KINDS.has(kind)) throw new Error(`不支持的图种：${kind}`);
	const layers = records(raw, 'layers', 100).map((item) => ({
		id: identifier(item, 'id'), name: text(item, 'name'), rank: item.rank,
	}));
	const layerIds = new Map();
	const ranks = new Set();
	for (const layer of layers) {
		if (!Number.isInteger(layer.rank) || layer.rank < 0 || layer.rank > 99) throw new Error('层级 rank 必须是 0 至 99 的整数');
		if (layerIds.has(layer.id) || ranks.has(layer.rank)) throw new Error('层级 id 和 rank 不能重复');
		layerIds.set(layer.id, layer.rank);
		ranks.add(layer.rank);
	}
	const groups = records(raw, 'groups', 1000, true).map((item) => ({
		id: identifier(item, 'id'), label: text(item, 'label'), layer: identifier(item, 'layer'),
	}));
	const groupIds = new Map();
	for (const group of groups) {
		if (!layerIds.has(group.layer) || groupIds.has(group.id)) throw new Error('分组引用未知层级或 id 重复');
		groupIds.set(group.id, group.layer);
	}
	const lanes = records(raw, 'lanes', 100, true).map((item) => ({ id: identifier(item, 'id'), label: text(item, 'label') }));
	const laneIds = new Set();
	for (const lane of lanes) {
		if (laneIds.has(lane.id)) throw new Error('泳道 id 不能重复');
		laneIds.add(lane.id);
	}
	const nodes = records(raw, 'nodes', 1000).map((item) => {
		const node = { id: identifier(item, 'id'), label: text(item, 'label'), layer: identifier(item, 'layer'), status: text(item, 'status') };
		for (const key of ['evidence', 'detail', 'group', 'lane', 'kind', 'submap']) {
			const value = text(item, key, true, key === 'detail' || key === 'evidence');
			if (value !== undefined) node[key] = value;
		}
		// 来源只是说明文字，不提供读取源码或打开任意文件的能力。
		if (Array.isArray(item.sources)) node.sources = item.sources.slice(0, 100).filter((source) => source && typeof source === 'object' && typeof source.path === 'string').map((source) => ({ path: source.path }));
		return node;
	});
	const nodeIds = new Map();
	for (const node of nodes) {
		if (!layerIds.has(node.layer) || !STATUSES.has(node.status)) throw new Error('节点引用未知层级或状态');
		if (nodeIds.has(node.id) || groupIds.has(node.id)) throw new Error('节点与分组 id 不能重复');
		if (node.group !== undefined && groupIds.get(node.group) !== node.layer) throw new Error('节点分组必须属于同一层级');
		if (node.lane !== undefined && !laneIds.has(node.lane)) throw new Error('节点引用未知泳道');
		if (node.submap !== undefined && !ID_RULE.test(node.submap)) throw new Error('子图名称无效');
		nodeIds.set(node.id, node);
	}
	const edges = records(raw, 'edges', 5000).map((item) => ({
		from: identifier(item, 'from'), to: identifier(item, 'to'), label: text(item, 'label', true),
	}));
	const edgeIds = new Set();
	for (const edge of edges) {
		const from = nodeIds.get(edge.from);
		const to = nodeIds.get(edge.to);
		if (!from || !to) throw new Error('依赖边引用未知节点');
		if (layerIds.get(from.layer) <= layerIds.get(to.layer)) throw new Error('依赖边必须从高层严格指向低层');
		const key = `${edge.from}:${edge.to}`;
		if (edgeIds.has(key)) throw new Error('依赖边不能重复');
		edgeIds.add(key);
	}
	return { version: raw.version, title: text(raw, 'title', true), kind, layers, groups, lanes, nodes, edges };
}

/** 创建地图快照读取器；每次请求重新发现文件，以兼容上游原子替换写入。 */
export function createMaps({ cwd }) {
	/** 解析真实路径并限制到当前工作目录；不存在与不可读取是不同的结果。 */
	async function boundedPath(root, target) {
		const resolved = await realpath(target);
		if (!within(root, resolved)) throw new Error('地图路径越出当前工作目录，已拒绝读取');
		return resolved;
	}

	/** 读取普通 JSON 文件，限制实际读取字节数，而不仅依赖可能过期的文件大小。 */
	async function readMap(root, file) {
		const resolved = await boundedPath(root, file);
		const handle = await open(resolved, 'r');
		try {
			const info = await handle.stat();
			if (!info.isFile()) throw new Error('地图不是普通文件');
			if (info.size > MAX_FILE_BYTES) throw new Error('地图超过 2 MiB，无法在弹窗中显示');
			const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
			let size = 0;
			while (size < buffer.length) {
				const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
				if (!bytesRead) break;
				size += bytesRead;
			}
			if (size > MAX_FILE_BYTES) throw new Error('地图超过 2 MiB，无法在弹窗中显示');
			const source = buffer.subarray(0, size).toString('utf8');
			return { map: parseMap(JSON.parse(source)), source };
		} finally {
			await handle.close();
		}
	}

	/** 列出安全且存在的页面，再读取所选页；单页损坏不阻止切换到其它地图。 */
	async function snapshot(wanted = '') {
		if (wanted && wanted !== '_default' && !ID_RULE.test(wanted)) {
			throw Object.assign(new Error('地图页面名称无效'), { status: 400 });
		}
		const result = { cwd, pages: [], page: null, map: null, revision: '' };
		let root;
		let store;
		try {
			root = await realpath(cwd);
			store = await boundedPath(root, path.join(cwd, '.mellos'));
		} catch (error) {
			if (error.code !== 'ENOENT') result.error = String(error.message || error);
			return result;
		}
		const candidates = [{ id: '_default', file: path.join(store, 'map.json') }];
		const warnings = [];
		try {
			const pagesDir = await boundedPath(root, path.join(store, 'pages'));
			const entries = await readdir(pagesDir, { withFileTypes: true });
			const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json') && ID_RULE.test(entry.name.slice(0, -5)));
			if (files.length > MAX_PAGES) warnings.push(`最多显示 ${MAX_PAGES} 个命名页`);
			for (const entry of files.sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_PAGES)) {
				candidates.push({ id: entry.name.slice(0, -5), file: path.join(pagesDir, entry.name) });
			}
		} catch (error) {
			if (error.code !== 'ENOENT') {
				const message = `页面目录不可读取：${String(error.message || error)}`;
				if (wanted && wanted !== '_default') {
					result.error = message;
					return result;
				}
				warnings.push(message);
			}
		}
		const paths = new Map();
		for (const candidate of candidates) {
			try {
				const resolved = await boundedPath(root, candidate.file);
				const info = await stat(resolved);
				if (!info.isFile()) continue;
				paths.set(candidate.id, resolved);
				result.pages.push({ id: candidate.id, label: candidate.id === '_default' ? '默认页' : candidate.id, modified: info.mtimeMs });
			} catch (error) {
				if (error.code !== 'ENOENT') {
					const message = `地图 ${candidate.id} 不可读取：${String(error.message || error)}`;
					warnings.push(message);
					result.pages.push({ id: candidate.id, label: candidate.id === '_default' ? '默认页' : candidate.id, modified: 0, error: message });
				}
			}
		}
		result.pages.sort((a, b) => b.modified - a.modified || a.id.localeCompare(b.id));
		const page = result.pages.find((item) => item.id === wanted) || result.pages[0];
		if (wanted && !result.pages.some((item) => item.id === wanted)) warnings.push('原页面已不存在，已切换到可用页面');
		if (page) {
			result.page = page.id;
			if (page.error) {
				result.error = page.error;
				if (warnings.length) result.warning = warnings.slice(0, 5).join('；');
				return result;
			}
			try {
				const { map, source } = await readMap(root, paths.get(page.id));
				result.map = map;
				result.revision = createHash('sha256').update(source).digest('hex');
			} catch (error) {
				result.error = `地图 ${page.label} 无法显示：${String(error.message || error)}`;
			}
		}
		if (warnings.length) result.warning = warnings.slice(0, 5).join('；');
		return result;
	}

	return { snapshot };
}
