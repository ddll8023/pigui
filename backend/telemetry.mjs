/** 会话用量与输出速率 */

/** 实时速率的滑动窗口：只看最近这段时间的输出，与 token-rate 扩展一致。 */
const RATE_WINDOW_MS = 2000;

/** 实时速率的刷新间隔：每拍重算一次窗口（窗口会自己变短，所以静止时速率会衰减）。 */
const RATE_TICK_MS = 250;

/** 窗口小于这个时长时不给速率，避免刚开头几个 token 算出天量。 */
const RATE_MIN_ELAPSED_MS = 250;

/** 超过这么久没有新的输出事件就停表，并告诉页面实时速率收尾。 */
const RATE_QUIET_MS = 2000;

/** 用量帧的节流：getSessionStats 要遍历整个会话，不能每个事件都算一遍。 */
const USAGE_THROTTLE_MS = 400;

/** 创建会话用量与输出速率；资源和可变状态由实例持有。 */
export function createTelemetry({ sdk, getSession, broadcast }) {
	/** 用量帧的节流句柄：一串事件只算一次。 */
	let usageTimer = 0;

	/** 当前这波输出：{ tokens, source, samples: [{at, tokens}], lastEventAt, lastSentAt, timer }。 */
	let rateRun = null;

	/** 当前会话的用量快照；老版本 SDK 没有统计入口时返回 null。 */
	function usageInfo(session = getSession()) {
		if (typeof session?.getSessionStats !== 'function') return null;
		const stats = session.getSessionStats() ?? {};
		const tokens = stats.tokens ?? {};
		const context =
			typeof session.getContextUsage === 'function' ? session.getContextUsage() : stats.contextUsage;
		// null / undefined 不能当成 0（上下文百分比在压缩后就是 null，当成 0 会显示成 0%）
		/** 缺失或无效的累计统计数值按零展示。 */
		const number = (value) =>
			value === null || value === undefined ? 0 : Number.isFinite(Number(value)) ? Number(value) : 0;
		/** 未知的上下文占用保留 null，不能伪装成零。 */
		const nullable = (value) =>
			value === null || value === undefined ? null : Number.isFinite(Number(value)) ? Number(value) : null;
		return {
			input: number(tokens.input),
			output: number(tokens.output),
			cacheRead: number(tokens.cacheRead),
			cacheWrite: number(tokens.cacheWrite),
			total: number(tokens.total),
			cost: number(stats.cost),
			// 上下文占用：tokens / percent 在压缩后到下次响应前可能是 null，页面按未知处理
			context: context
				? {
						tokens: nullable(context.tokens),
						contextWindow: nullable(context.contextWindow),
						percent: nullable(context.percent),
					}
				: null,
		};
	}

	/** 广播用量帧（页面输入区下方那一行）。 */
	function broadcastUsage() {
		broadcast({ kind: 'usage', usage: usageInfo() });
	}

	/** 攒一拍再算用量：一个回合里会有多条消息与工具结果，没必要逐个重算。 */
	function scheduleUsage() {
		if (usageTimer) return;
		usageTimer = setTimeout(() => {
			usageTimer = 0;
			broadcastUsage();
		}, USAGE_THROTTLE_MS);
	}

	/** 从 message_update 事件里取输出 tokens：provider 报的优先，退化到 SDK 的估算。 */
	function rateTokens(event) {
		const partial = event?.assistantMessageEvent?.partial;
		if (!partial) return null;
		const provider = Number(partial.usage?.output);
		if (Number.isFinite(provider) && provider > 0) return { tokens: provider, source: 'provider' };
		if (typeof sdk.estimateTokens === 'function') {
			const estimated = Number(sdk.estimateTokens(partial));
			if (Number.isFinite(estimated) && estimated > 0) return { tokens: estimated, source: 'estimate' };
		}
		return null;
	}

	/** 窗口内的实时速率；窗口太短或没有增量就不给值。 */
	function rateLive() {
		const samples = rateRun?.samples ?? [];
		if (samples.length < 2) return null;
		const first = samples[0];
		const last = samples[samples.length - 1];
		const ms = last.at - first.at;
		if (ms < RATE_MIN_ELAPSED_MS) return null;
		const delta = last.tokens - first.tokens;
		if (delta <= 0) return null;
		return Math.round((delta / ms) * 10000) / 10;
	}

	/** 算并广播一帧实时速率。 */
	function emitRate() {
		if (!rateRun) return;
		rateRun.lastSentAt = Date.now();
		broadcast({ kind: 'rate', phase: 'live', live: rateLive(), output: rateRun.tokens });
	}

	/** 每拍重算窗口；静下来就停表。 */
	function tickRate() {
		if (!rateRun) return;
		if (Date.now() - rateRun.lastEventAt > RATE_QUIET_MS) {
			stopRateTimer();
			broadcast({ kind: 'rate', phase: 'idle', live: null });
			return;
		}
		emitRate();
	}

	/** 开一波新的输出采样（助手消息开始）。 */
	function rateStart() {
		stopRateTimer();
		rateRun = { tokens: 0, source: '', samples: [], lastEventAt: Date.now(), lastSentAt: 0, timer: null };
		rateRun.timer = setInterval(tickRate, RATE_TICK_MS);
	}

	/** 收到一段输出：推进滑动窗口，并按 RATE_TICK_MS 节流发给页面。 */
	function rateUpdate(event) {
		const snapshot = rateTokens(event);
		if (!snapshot) return;
		if (!rateRun) rateStart();
		// provider 的 usage 比估算可信；数字回退说明是新的一次调用，窗口重开
		const regressed = snapshot.tokens < rateRun.tokens;
		if (snapshot.source === 'provider' && (rateRun.source !== 'provider' || regressed)) {
			rateRun.samples = [];
			rateRun.source = 'provider';
			rateRun.tokens = snapshot.tokens;
		} else if (snapshot.source === 'provider' || rateRun.source !== 'provider') {
			rateRun.tokens = Math.max(rateRun.tokens, snapshot.tokens);
		}
		const now = Date.now();
		rateRun.lastEventAt = now;
		const last = rateRun.samples[rateRun.samples.length - 1];
		if (!last || last.tokens !== rateRun.tokens) rateRun.samples.push({ at: now, tokens: rateRun.tokens });
		const cutoff = now - RATE_WINDOW_MS;
		while (rateRun.samples.length > 1 && rateRun.samples[1].at < cutoff) rateRun.samples.shift();
		if (now - rateRun.lastSentAt >= RATE_TICK_MS) emitRate();
	}

	/** 一次模型调用结束：定格这次调用的平均速率（耗时用实测值）。 */
	function rateEnd(message, durationMs) {
		const run = rateRun;
		stopRateTimer();
		rateRun = null;
		const providerOutput = Number(message?.usage?.output);
		const output = Number.isFinite(providerOutput) && providerOutput > 0 ? providerOutput : (run?.tokens ?? 0);
		const ms = Number(durationMs);
		const average =
			Number.isFinite(ms) && ms >= RATE_MIN_ELAPSED_MS && output > 0 ? Math.round((output / ms) * 10000) / 10 : null;
		broadcast({
			kind: 'rate',
			phase: 'end',
			average,
			output,
			ms: Number.isFinite(ms) ? Math.round(ms) : null,
		});
	}

	/** 停掉速率定时器，但保留当前采样。 */
	function stopRateTimer() {
		if (rateRun?.timer) clearInterval(rateRun.timer);
		if (rateRun) rateRun.timer = null;
	}

	/** 会话切换 / 回合被中断：把速率收尾，别让页面停在旧值上。 */
	function rateReset() {
		if (!rateRun) return;
		stopRateTimer();
		rateRun = null;
		broadcast({ kind: 'rate', phase: 'idle', live: null });
	}

	/** 服务关闭时停掉用量节流与速率定时器，不再发送新帧。 */
	function close() {
		if (usageTimer) clearTimeout(usageTimer);
		usageTimer = 0;
		stopRateTimer();
	}

	return { usageInfo, scheduleUsage, rateStart, rateUpdate, rateEnd, rateReset, close };
}
