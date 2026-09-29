#!/usr/bin/env node
/**
 * pigui 命令行入口
 *
 * 用途：在某个工作目录里一键起一个本地 GUI 服务，并让 Orca 用它自己的浏览器页签打开这个页面。
 *
 * 关键设计：
 * - pi SDK 不写进依赖，而是"借用"这台电脑上已经装好的 pi：
 *   依次尝试 PIGUI_PI_SDK → PI_MANAGED_INSTALL_ROOT → ~/.pi/agent/install/current-version
 *   → npm 全局根目录 → PATH 里的 pi 可执行文件 → 当前项目依赖；
 * - cwd 取当前目录，因此"在哪个 worktree 跑，页面就是哪个 worktree"；
 * - 页面用 orca tab create 打开，页签绑定当前 worktree。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { startServer } from './server.mjs';

const require = createRequire(import.meta.url);
/** 需要借用的 pi 包名。 */
const PACKAGE_NAME = '@earendil-works/pi-coding-agent';
/** 包名在磁盘上的相对片段。 */
const PACKAGE_SEGMENTS = ['@earendil-works', 'pi-coding-agent'];

/** 解析命令行参数。 */
function parseArgs(argv) {
	const options = { noOpen: false, port: 0, mode: 'new', sessionPath: '', help: false };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--no-open') options.noOpen = true;
		else if (arg === '--new') options.mode = 'new';
		else if (arg === '--continue') options.mode = 'continue';
		else if (arg === '--port') options.port = Number(argv[++index] ?? 0) || 0;
		else if (arg === '--session') options.sessionPath = path.resolve(argv[++index] ?? '');
		else if (arg === '-h' || arg === '--help') options.help = true;
	}
	return options;
}

/** 打印用法。 */
function printHelp() {
	console.log(`pigui — 为当前工作目录打开 pi 的网页对话界面

用法：
  pigui [选项]

选项：
  --no-open          只起服务，不调用 orca 打开页签（会打印地址）
  --port <n>         指定端口（默认由系统自动分配）
  --new              新建会话（默认行为）
  --continue         恢复该目录最近一次会话（可能正被 Orca / pi 使用，慎用）
  --session <path>   打开指定的会话文件（优先于 --new / --continue）
  -h, --help         显示本帮助

环境变量：
  PIGUI_PI_SDK       手动指定 pi 包目录或 dist/index.js 路径
  PI_AGENT_DIR       覆盖 pi 配置目录（默认 ~/.pi/agent）
`);
}

/** 安全读取文本文件，失败返回空串。 */
function readText(file) {
	try {
		return readFileSync(file, 'utf8');
	} catch {
		return '';
	}
}

/** 执行一条命令并返回 stdout（失败或超时返回空串）。 */
function run(command) {
	const result = spawnSync(command, { shell: true, encoding: 'utf8', timeout: 60_000 });
	if (process.env.PIGUI_DEBUG) {
		console.error(
			`pigui[debug]: ${command}\n  status=${result.status} error=${result.error ? result.error.message : 'none'}\n` +
				`  stdout=${JSON.stringify((result.stdout ?? '').slice(0, 200))}\n  stderr=${JSON.stringify((result.stderr ?? '').slice(0, 200))}`,
		);
	}
	if (result.error || !result.stdout) return '';
	return result.stdout;
}

/**
 * 从命令输出里提取所有完整的顶层 JSON 对象。
 * orca 的输出可能是多行格式化 JSON，也可能前后夹带日志/进度行，因此用花括号配平扫描，
 * 而不是简单地截取第一个 { 到最后一个 }。
 */
function extractJsonObjects(text) {
	const objects = [];
	for (let index = 0; index < text.length; index += 1) {
		if (text[index] !== '{') continue;
		let depth = 0;
		let inString = false;
		let escaped = false;
		for (let cursor = index; cursor < text.length; cursor += 1) {
			const char = text[cursor];
			if (inString) {
				if (escaped) escaped = false;
				else if (char === '\\') escaped = true;
				else if (char === '"') inString = false;
				continue;
			}
			if (char === '"') inString = true;
			else if (char === '{') depth += 1;
			else if (char === '}') {
				depth -= 1;
				if (depth === 0) {
					try {
						objects.push(JSON.parse(text.slice(index, cursor + 1)));
						index = cursor;
					} catch {
						// 这一段不是合法 JSON，继续往后找下一个起点
					}
					break;
				}
			}
		}
	}
	return objects;
}

/** 调用 orca CLI 并解析结果：优先取最后一个带 ok 字段的对象。 */
function orcaJson(args) {
	const objects = extractJsonObjects(run(`orca ${args.join(' ')}`));
	const withOk = objects.filter((item) => item && typeof item === 'object' && 'ok' in item);
	if (withOk.length > 0) return withOk[withOk.length - 1];
	return objects.length > 0 ? objects[objects.length - 1] : null;
}

/** 由 pi 的 managed 安装版本文件推出包目录。 */
function packageDirFromVersionFile(versionFile) {
	const version = readText(versionFile).trim();
	if (!/^[0-9A-Za-z._+-]+$/.test(version) || version === '.' || version === '..') return '';
	return path.join(path.dirname(versionFile), 'releases', version, 'node_modules', ...PACKAGE_SEGMENTS);
}

/** pi 配置目录。 */
function agentDir() {
	return process.env.PI_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
}

/** npm 全局 node_modules 根目录。 */
function npmGlobalRoot() {
	const out = run('npm root -g').trim();
	return out ? out.split(/\r?\n/).pop().trim() : '';
}

/** 从 PATH 里的 pi 可执行文件推断包目录。 */
function packageDirFromPiBinary() {
	const which = process.platform === 'win32' ? 'where pi' : 'which -a pi';
	const binaries = run(which)
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	for (const binary of binaries) {
		const text = readText(binary);
		if (!text) continue;
		// npm/官方 shim 里会直接出现包路径，例如 ...\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js
		const match = text.match(/([A-Za-z]:[^"'\r\n]*?node_modules[\\/]+@earendil-works[\\/]+pi-coding-agent)/i);
		if (match) return match[1];
		// 官方 pi-launcher.js 位于 <agentDir>/bin/，顺着同级的 install/current-version 找
		const fromVersionFile = packageDirFromVersionFile(path.join(path.dirname(path.dirname(binary)), 'install', 'current-version'));
		if (fromVersionFile) return fromVersionFile;
	}
	return '';
}

/** 从入口文件路径向上找到包目录（含匹配 name 的 package.json）。 */
function packageRootOf(file) {
	let dir = path.dirname(file);
	for (let depth = 0; depth < 4; depth += 1) {
		const manifest = readText(path.join(dir, 'package.json'));
		if (manifest) {
			try {
				if (JSON.parse(manifest).name === PACKAGE_NAME) return dir;
			} catch {}
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return path.dirname(file);
}

/** 尝试加载某个候选目录，成功则返回 { dir, mod }。 */
function tryLoad(dir) {
	if (!dir) return null;
	try {
		if (!existsSync(path.join(dir, 'package.json'))) return null;
		const mod = require(dir);
		if (typeof mod?.createAgentSession !== 'function' || !mod?.SessionManager) return null;
		return { dir, mod };
	} catch {
		return null;
	}
}

/** 按解析链找到可用的 pi SDK，找不到就抛出带指引的错误。 */
function resolveSdk() {
	const tried = [];
	const candidates = [
		process.env.PIGUI_PI_SDK,
		process.env.PI_MANAGED_INSTALL_ROOT
			? packageDirFromVersionFile(path.join(process.env.PI_MANAGED_INSTALL_ROOT, 'current-version'))
			: '',
		packageDirFromVersionFile(path.join(agentDir(), 'install', 'current-version')),
		npmGlobalRoot() ? path.join(npmGlobalRoot(), ...PACKAGE_SEGMENTS) : '',
		packageDirFromPiBinary(),
	];
	for (const candidate of candidates) {
		if (!candidate) continue;
		tried.push(candidate);
		// 允许直接给到 dist/index.js
		const asDir = candidate.endsWith('.js') ? path.dirname(candidate) : candidate;
		const loaded = tryLoad(asDir);
		if (loaded) return loaded;
	}
	try {
		const resolved = require.resolve(PACKAGE_NAME);
		tried.push(resolved);
		const loaded = tryLoad(packageRootOf(resolved));
		if (loaded) return loaded;
	} catch {
		// 当前项目没有装这个依赖，忽略
	}
	throw new Error(
		`未找到 pi 的 SDK（${PACKAGE_NAME}）。\n已尝试：\n  ${tried.filter(Boolean).join('\n  ') || '(无候选)'}\n` +
			'请确认这台电脑装过 pi（能直接执行 pi 命令），或用 PIGUI_PI_SDK 指定包目录。',
	);
}

/** 取当前 worktree 的展示名（失败返回空串，不影响使用）。 */
function worktreeDisplayName() {
	const result = orcaJson(['worktree', 'current', '--json']);
	return result?.result?.worktree?.displayName || '';
}

/**
 * 让 Orca 在本 worktree 打开一个浏览器页签。
 *
 * 必须异步：orca tab create 要等页签加载完成，而页签加载又依赖本进程响应 HTTP/SSE；
 * 如果同步等待，会和自己的服务互相阻塞（死锁）。
 */
function openInOrca(url) {
	return new Promise((resolve) => {
		const child = spawn(`orca tab create --url ${url} --worktree active --json`, {
			shell: true,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let out = '';
		child.stdout.on('data', (chunk) => {
			out += chunk;
		});
		child.stderr.on('data', () => {});
		const timer = setTimeout(() => {
			if (process.env.PIGUI_DEBUG) console.error('pigui[debug]: orca tab create 超时，不再等待');
			resolve(false);
		}, 30_000);
		child.on('error', () => {
			clearTimeout(timer);
			resolve(false);
		});
		child.on('close', () => {
			clearTimeout(timer);
			const objects = extractJsonObjects(out);
			const withOk = objects.filter((item) => item && typeof item === 'object' && 'ok' in item);
			const result = withOk.length > 0 ? withOk[withOk.length - 1] : (objects[objects.length - 1] ?? null);
			resolve(Boolean(result?.ok ?? result?.result?.browserPageId));
		});
	});
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
	printHelp();
	process.exit(0);
}

const cwd = process.cwd();
let sdk;
try {
	sdk = resolveSdk();
} catch (err) {
	console.error(String(err?.message ?? err));
	process.exit(1);
}

console.log(`pigui: 使用 pi SDK → ${sdk.dir}`);
console.log(`pigui: 工作目录 → ${cwd}`);

const service = await startServer({
	sdk: sdk.mod,
	cwd,
	mode: options.mode,
	sessionPath: options.sessionPath,
	port: options.port,
	onLog: (text) => console.log(text),
});

const info = service.sessionInfo();
const displayName = worktreeDisplayName();
console.log(`pigui: 会话 → ${info.sessionFile ?? '(新会话尚未落盘)'}`);
if (displayName) console.log(`pigui: worktree → ${displayName}`);

if (options.noOpen) {
	console.log('pigui: 已跳过自动打开页签（--no-open）');
} else if (await openInOrca(service.url)) {
	console.log('pigui: 已在 Orca 中打开页签');
} else {
	console.log(`pigui: 未能通过 orca 打开页签（可能不在 Orca worktree 内），请手动打开 ${service.url}`);
}
console.log('pigui: Ctrl+C 停止服务');

let closing = false;
async function shutdown() {
	if (closing) return;
	closing = true;
	console.log('\npigui: 正在关闭…');
	await service.close();
	process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
