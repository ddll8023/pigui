/** 会话耗时记录与持久化 */
import fs from 'node:fs';
import path from 'node:path';

/** 耗时记录文件的后缀：紧贴会话文件存放，pi 只扫描 *.jsonl，不会把它当会话。 */
const TIMING_SUFFIX = '.timings.json';

/** 单个会话最多保留的耗时记录数，超出按写入时间保留最新的。 */
const MAX_TIMING_RECORDS = 20000;

/** 超过这个天数没被更新的耗时文件会被清理（pigui 自己生成的周边数据，过期即无价值）。 */
const TIMING_KEEP_DAYS = 30;

/** 耗时写盘的合并窗口：一个回合里会记多条，攒一下再写。 */
const TIMING_FLUSH_DELAY_MS = 1000;

/** 等待条目 id 的耗时记录上限：正常一两个事件内就能解析，超出说明解析不上，直接丢弃。 */
const MAX_PENDING_TIMINGS = 50;

/** 调试时记录耗时文件写入失败，不改变计时或持久化语义。 */
const DEBUG = Boolean(process.env.PIGUI_DEBUG);

/** 创建会话耗时记录与持久化；资源和可变状态由实例持有。 */
export function createTimings({ getSession, broadcast, onLog }) {
	/**
	 * 会话耗时记录：key 是 `${kind}:${entryId}`，value 是 { ms, at }。
	 * kind 取 assistant（一次模型调用的耗时）或 turn（一个回合的总耗时，entryId 是该回合起始的用户提问）。
	 */
	let timings = new Map();

	/** 已测出耗时、但还没解析出条目 id 的记录，等下一个事件再补。 */
	let pendingTimings = [];

	/** 当前这次模型调用的起始时刻（message_start → message_end）。 */
	let messageTimer = null;

	/** 当前回合：{ startedAt, keyMessage, entryId }；首个 agent_start 开始，agent_settled 结束。 */
	let turn = null;

	/** 写盘合并窗口的句柄，以及「过期清理只做一次」标记。 */
	let timingFlushTimer = null;

	let timingsPruned = false;

	/** 耗时记录的 key。 */
	function timingKey(kind, entryId) {
		return `${kind}:${entryId}`;
	}

	/** 当前会话的耗时文件路径；会话没落到磁盘（老版本 SDK / 内存会话）时返回空串。 */
	function timingFile() {
		const manager = getSession()?.sessionManager;
		const file = typeof manager?.getSessionFile === 'function' ? manager.getSessionFile() : '';
		return typeof file === 'string' && file ? `${file}${TIMING_SUFFIX}` : '';
	}

	/** 取某条耗时（毫秒）；没有记录或没有条目 id 时返回 null。 */
	function timingOf(kind, entryId) {
		if (!entryId) return null;
		const record = timings.get(timingKey(kind, entryId));
		return record ? record.ms : null;
	}

	/** 记一条耗时（只进内存，写盘交给 scheduleFlushTimings）。 */
	function addTiming(kind, entryId, ms) {
		if (!entryId || !Number.isFinite(ms)) return;
		timings.set(timingKey(kind, entryId), { ms: Math.max(0, Math.round(ms)), at: Date.now() });
		scheduleFlushTimings();
	}

	/**
	 * 反查消息在会话树里的条目 id：先比叶子，再按对象身份扫当前分支。
	 * pi 是先发 message_end 事件、之后才写会话文件，所以事件回调里通常查不到，要等下一个事件。
	 */
	function resolveEntryId(message) {
		const manager = getSession()?.sessionManager;
		if (!manager || !message) return '';
		const leaf = typeof manager.getLeafEntry === 'function' ? manager.getLeafEntry() : undefined;
		if (leaf?.message === message) return typeof leaf.id === 'string' ? leaf.id : '';
		const branch = typeof manager.getBranch === 'function' ? manager.getBranch() : [];
		for (const entry of [...branch].reverse()) {
			if (entry?.type === 'message' && entry.message === message) {
				return typeof entry.id === 'string' ? entry.id : '';
			}
		}
		return '';
	}

	/** 把挂起的记录补上条目 id：补到就转正，补不到留到下次（上限之外的直接丢）。 */
	function settlePendingTimings() {
		if (!pendingTimings.length) return;
		const rest = [];
		for (const item of pendingTimings) {
			const entryId = resolveEntryId(item.message);
			if (entryId) addTiming(item.kind, entryId, item.ms);
			else rest.push(item);
		}
		pendingTimings = rest.slice(-MAX_PENDING_TIMINGS);
	}

	/** 攒一下再写盘，避免一个回合里反复写同一个文件。 */
	function scheduleFlushTimings() {
		if (timingFlushTimer) return;
		timingFlushTimer = setTimeout(() => {
			timingFlushTimer = null;
			flushTimings();
		}, TIMING_FLUSH_DELAY_MS);
		timingFlushTimer.unref?.();
	}

	/** 立即把耗时表写盘（换会话、回合结束、退出前调用）；没有会话文件或没有记录时不做任何事。 */
	function flushTimings() {
		if (timingFlushTimer) {
			clearTimeout(timingFlushTimer);
			timingFlushTimer = null;
		}
		const file = timingFile();
		if (!file || !timings.size) return;
		// 裁剪：只保留最近写入的若干条，长会话也不会把文件写大
		const records = [...timings.entries()]
			.map(([key, record]) => {
				const split = key.indexOf(':');
				return { kind: key.slice(0, split), id: key.slice(split + 1), ms: record.ms, at: record.at };
			})
			.sort((a, b) => b.at - a.at)
			.slice(0, MAX_TIMING_RECORDS);
		timings = new Map(records.map((record) => [timingKey(record.kind, record.id), { ms: record.ms, at: record.at }]));
		const payload = JSON.stringify({ version: 1, sessionId: getSession()?.sessionId ?? null, records });
		try {
			// 先写临时文件再改名：中途失败最多丢这一次的耗时，不会留下半截 JSON
			fs.writeFileSync(`${file}.tmp`, payload);
			fs.renameSync(`${file}.tmp`, file);
		} catch (err) {
			if (DEBUG) onLog(`pigui: 耗时写入失败 ${file}：${String(err?.message ?? err)}`);
		}
	}

	/** 读取当前会话的耗时文件；缺失或损坏时按空表处理（耗时是附加信息，不能影响会话）。 */
	function loadTimings() {
		timings = new Map();
		pendingTimings = [];
		const file = timingFile();
		if (!file) return;
		let parsed = null;
		try {
			parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
		} catch {
			parsed = null;
		}
		for (const record of Array.isArray(parsed?.records) ? parsed.records : []) {
			const id = typeof record?.id === 'string' ? record.id : '';
			const kind = record?.kind === 'turn' ? 'turn' : record?.kind === 'assistant' ? 'assistant' : '';
			const ms = Number(record?.ms);
			if (!id || !kind || !Number.isFinite(ms) || ms < 0) continue;
			timings.set(timingKey(kind, id), { ms: Math.round(ms), at: Number(record?.at) || 0 });
		}
		pruneTimings(file);
	}

	/** 清理同一个会话目录里过期的耗时文件；每个进程只扫一次，不动当前会话自己的文件。 */
	function pruneTimings(currentFile) {
		if (timingsPruned) return;
		timingsPruned = true;
		const dir = path.dirname(currentFile);
		const deadline = Date.now() - TIMING_KEEP_DAYS * 24 * 60 * 60 * 1000;
		let names = [];
		try {
			names = fs.readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) {
			if (!name.endsWith(TIMING_SUFFIX)) continue;
			const target = path.join(dir, name);
			if (target === currentFile) continue;
			try {
				if (fs.statSync(target).mtimeMs < deadline) fs.unlinkSync(target);
			} catch {}
		}
	}

	/**
	 * 按 pi 事件维护计时状态，并向页面推 timer 帧；返回值是给 eventFrame 的附加字段。
	 * 口径：单条 = 一次模型调用（message_start → message_end，含等待首 token，不含工具执行）；
	 *       回合 = 首个 agent_start → agent_settled（含工具执行、重试与续跑）。
	 */
	function trackTiming(event) {
		const type = event?.type;
		if (type === 'message_start' && event.message?.role === 'assistant') {
			messageTimer = { startedAt: Date.now() };
			broadcast({ kind: 'timer', scope: 'message', phase: 'start', startedAt: messageTimer.startedAt });
			return null;
		}
		if (type === 'agent_start') {
			// 重试与续跑会再发一次 agent_start，此时仍属同一回合，不重开计时
			if (!turn) {
				turn = { startedAt: Date.now(), keyMessage: null, entryId: '' };
				broadcast({ kind: 'timer', scope: 'turn', phase: 'start', startedAt: turn.startedAt });
			}
			return null;
		}
		if (type === 'agent_settled') {
			settlePendingTimings();
			messageTimer = null;
			if (turn) {
				const ms = Date.now() - turn.startedAt;
				const entryId = turn.entryId || (turn.keyMessage ? resolveEntryId(turn.keyMessage) : '');
				addTiming('turn', entryId, ms);
				broadcast({
					kind: 'timer',
					scope: 'turn',
					phase: 'end',
					durationMs: Math.round(ms),
					startedAt: turn.startedAt,
					entryId,
				});
				turn = null;
			}
			flushTimings();
			return null;
		}
		if (type !== 'message_end') return null;
		// 先给上一条挂起的记录补 id：进到这里说明上一条已经写进会话文件了
		settlePendingTimings();
		const message = event.message;
		if (message?.role === 'assistant' && messageTimer) {
			const durationMs = Date.now() - messageTimer.startedAt;
			messageTimer = null;
			const entryId = resolveEntryId(message);
			if (entryId) addTiming('assistant', entryId, durationMs);
			else pendingTimings.push({ kind: 'assistant', message, ms: durationMs });
			return { durationMs };
		}
		// 回合的归属挂在触发它的那条用户消息上；steer 追加进来的消息不重开回合
		if (message?.role === 'user' && turn && !turn.keyMessage) {
			turn.keyMessage = message;
			turn.entryId = resolveEntryId(message);
		}
		return null;
	}

	/** 正在跑的回合（起始时刻 + 起始用户消息的条目 id）；空闲时为 null，页面据此在刷新后接着计时。 */
	function currentTurnInfo() {
		if (!turn) return null;
		if (!turn.entryId && turn.keyMessage) turn.entryId = resolveEntryId(turn.keyMessage);
		return { startedAt: turn.startedAt, entryId: turn.entryId || '' };
	}

	/** 给历史视图补上落盘的耗时：assistant 挂单次调用耗时，user 挂该回合总耗时。 */
	function withTiming(view, entryId) {
		if (view.role === 'assistant') {
			const ms = timingOf('assistant', entryId);
			if (ms !== null) view.durationMs = ms;
		} else if (view.role === 'user') {
			const ms = timingOf('turn', entryId);
			if (ms !== null) view.turnMs = ms;
		}
		return view;
	}

	/** 建立新会话后清除活跃计时；旧会话必须先由调用方落盘。 */
	function resetRun() {
		messageTimer = null;
		turn = null;
	}

	return { resolveEntryId, flushTimings, loadTimings, trackTiming, currentTurnInfo, withTiming, resetRun };
}
