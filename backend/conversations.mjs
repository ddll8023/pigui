/** 会话注册表：按 id 创建、查找、列出、回收同进程里的多个对话实例；不持有会话业务状态。 */
import { createConversationRuntime } from './session.mjs';

/** 同时生效的对话上限：每个对话都自带资源加载器与插件连接，超过就先回收最久未活动的空闲对话。 */
const MAX_CONVERSATIONS = 8;

/** 没有任何页签连接的空闲对话保留多久；超时后回收，释放它的 SDK 会话与资源。 */
const IDLE_CONVERSATION_TTL_MS = 5 * 60 * 1000;

/** 回收巡检间隔：每跳只做几次连接数查询与时间比较，成本可以忽略。 */
const SWEEP_INTERVAL_MS = 30 * 1000;

/**
 * 创建会话注册表。
 *
 * 一个对话就是一份独立的 createConversationRuntime 实例，注册表只负责 id 分配与生命周期；
 * 事件由各实例经 transport 按 id 分流，因此多个对话可以同时存在、同时运行。
 *
 * @param {object} options 组装参数。
 * @param {object} options.sdk 提供 createAgentSession 与 SessionManager 的 pi SDK。
 * @param {string} options.cwd 工作目录，决定资源发现与会话归属。
 * @param {object} options.transport 传输实例，提供 broadcastTo 与 getClientCount。
 * @param {boolean} [options.pluginUi=true] 是否把插件的 ctx.ui 接到页面上。
 * @param {(text: string) => void} [options.onLog] 日志回调。
 */
export function createConversationRegistry({ sdk, cwd, transport, pluginUi = true, onLog = () => {} }) {
	/**
	 * 生效中的对话：id → { conversation, lastActiveAt, everConnected, pinned }。
	 * lastActiveAt 是最近一次“有页签连着或正在跑回合”的时刻，回收与上限都按它排序。
	 */
	const entries = new Map();

	/**
	 * 本进程的 id 前缀。
	 * 带上随机段后，不同进程分配出的对话 id 不会撞在一起：服务重启后旧页签的 ?c= 必定失效，
	 * 不会静默连到新进程里恰好同号的那个对话上。
	 */
	const idPrefix = `c${Math.random().toString(36).slice(2, 8)}-`;

	/** id 序号：同一进程内不复用，回收后的旧 id 不会被新对话占用。 */
	let seq = 0;

	/** 回收巡检定时器；只在存在对话时运行。 */
	let sweepTimer = null;

	/** 新建一个对话并完成首次 boot；boot 失败时不留半成品。 */
	async function create(options = {}) {
		ensureCapacity();
		seq += 1;
		const id = `${idPrefix}${seq}`;
		const conversation = createConversationRuntime({
			id,
			sdk,
			cwd,
			transport,
			onLog,
			mode: options.mode === 'continue' ? 'continue' : 'new',
			sessionPath: typeof options.sessionPath === 'string' ? options.sessionPath : '',
			pluginUi,
		});
		const now = Date.now();
		entries.set(id, {
			conversation,
			lastActiveAt: now,
			everConnected: false,
			// 启动时创建的对话要等第一个页签连上再受回收规则约束，否则打印出去的 ?c= 地址会提前失效
			pinned: options.pinned === true,
		});
		startSweeping();
		try {
			await conversation.boot();
		} catch (err) {
			entries.delete(id);
			try { conversation.close(); } catch {}
			throw err;
		}
		return conversation;
	}

	/** 按 id 取对话；不存在时返回 null。 */
	function get(id) {
		if (typeof id !== 'string' || !id) return null;
		return entries.get(id)?.conversation ?? null;
	}

	/** 取最早创建、仍在生效的对话；未带 id 的旧请求回退到它。 */
	function first() {
		return entries.values().next().value?.conversation ?? null;
	}

	/** 列出全部生效对话，供页面展示与选择。 */
	function list() {
		return [...entries.values()].map((entry) => entry.conversation);
	}

	/** 关闭并移除一个对话；对话不存在时返回 false。 */
	function close(id) {
		const entry = entries.get(id);
		if (!entry) return false;
		entries.delete(id);
		try { entry.conversation.close(); } catch {}
		return true;
	}

	/** 关闭全部对话（服务关闭时调用）。 */
	function closeAll() {
		stopSweeping();
		for (const entry of [...entries.values()]) {
			try { entry.conversation.close(); } catch {}
		}
		entries.clear();
	}

	/** 进程退出兜底：同步把每个对话的耗时落盘（这里不能有异步操作）。 */
	function flushAll() {
		for (const entry of entries.values()) {
			try { entry.conversation.flushTimings(); } catch {}
		}
	}

	/** 这个对话现在是不是空闲：没有页签连着，也没在跑回合或压缩。 */
	function isIdle(id, entry) {
		if (entry.conversation.isBusy() || entry.conversation.isCompacting()) return false;
		return transport.getClientCount(id) === 0;
	}

	/** 容量已满时先回收最久未活动的空闲对话；没有可回收的就按 409 拒绝新建。 */
	function ensureCapacity() {
		if (entries.size < MAX_CONVERSATIONS) return;
		const idle = [...entries.entries()]
			.filter(([id, entry]) => isIdle(id, entry))
			.sort((a, b) => a[1].lastActiveAt - b[1].lastActiveAt);
		if (idle.length === 0) {
			throw Object.assign(new Error(`同时最多 ${MAX_CONVERSATIONS} 个对话，请先关掉一些页签`), { status: 409 });
		}
		close(idle[0][0]);
	}

	/** 巡检一遍：刷新活跃时间，并把长时间没页签连接的对话回收掉。 */
	function sweep() {
		const now = Date.now();
		for (const [id, entry] of [...entries]) {
			if (transport.getClientCount(id) > 0) {
				entry.everConnected = true;
				entry.lastActiveAt = now;
				continue;
			}
			// 运行或压缩中的对话不算空闲，同时刷新活跃时间，避免回合刚结束就被回收
			if (entry.conversation.isBusy() || entry.conversation.isCompacting()) {
				entry.lastActiveAt = now;
				continue;
			}
			if (entry.pinned && !entry.everConnected) continue;
			if (now - entry.lastActiveAt >= IDLE_CONVERSATION_TTL_MS) close(id);
		}
		if (entries.size === 0) stopSweeping();
	}

	/** 启动回收巡检；已有定时器时不重复启动。 */
	function startSweeping() {
		if (sweepTimer) return;
		sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
		sweepTimer.unref?.();
	}

	/** 停止回收巡检。 */
	function stopSweeping() {
		if (!sweepTimer) return;
		clearInterval(sweepTimer);
		sweepTimer = null;
	}

	return { create, get, first, list, close, closeAll, flushAll };
}
