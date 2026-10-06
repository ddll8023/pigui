/** 外部账号额度查询与缓存 */

/** Codex 账号额度接口（ChatGPT 内部接口，非公开 API，随时可能失效）。 */
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

/** OpenCode Go 订阅用量接口（Zen 内部接口，非公开 API，随时可能失效）。 */
const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';

/** 外部额度的缓存时间：数字不会秒变，避免每次打开浮层都打接口。 */
const EXTERNAL_USAGE_TTL_MS = 60000;

/** 外部额度请求超时。 */
const EXTERNAL_USAGE_TIMEOUT_MS = 10000;

/**
 * 创建外部账号额度查询与缓存；资源和状态由实例持有。
 *
 * @param {object} options 组装参数。
 * @param {object} options.sdk pi SDK，提供 readStoredCredential 兜底。
 * @param {() => object|null} options.getModelRuntime 取一份可用的 ModelRuntime（用于 OAuth 自动刷新）；
 *   额度是账号级的，不绑定某个对话，因此取不到时退回文件读取。
 */
export function createExternalUsage({ sdk, getModelRuntime }) {
	/** 外部额度缓存：{ at, value }，TTL 内直接复用。 */
	let externalUsageCache = null;

	/** 把窗口秒数说成人话：5小时 / 7天。 */
	function windowLabel(seconds) {
		if (seconds % 604800 === 0) return `${seconds / 604800}周`;
		if (seconds % 86400 === 0) return `${seconds / 86400}天`;
		if (seconds % 3600 === 0) return `${seconds / 3600}小时`;
		if (seconds % 60 === 0) return `${seconds / 60}分钟`;
		return `${Math.round(seconds)}秒`;
	}

	/** 从 pi 的凭据里取某个 provider 的 key / access token（取不到或出错都返回空串）。 */
	async function providerKey(providerId) {
		const runtime = getModelRuntime();
		if (typeof runtime?.getAuth === 'function') {
			try {
				// 走 ModelRuntime 的好处：OAuth 过期时由 pi 自己刷新
				const resolved = await runtime.getAuth(providerId);
				const key = resolved?.auth?.apiKey ?? resolved?.auth?.key ?? resolved?.auth?.access;
				if (typeof key === 'string' && key) return key;
			} catch {
				/* 落到下面的文件读取 */
			}
		}
		// 兜底：直接从 pi 的 auth.json 读一次（没有存活会话、老版本 SDK 没有 getAuth，或 provider 不在模型目录里）
		try {
			if (typeof sdk.readStoredCredential !== 'function') return '';
			const credential = sdk.readStoredCredential(providerId);
			const key = credential?.apiKey ?? credential?.key ?? credential?.access;
			return typeof key === 'string' ? key : '';
		} catch {
			return '';
		}
	}

	/** 带超时的 JSON GET；非 2xx 与超时都抛错，由调用方转成简短原因。 */
	async function fetchJson(url, headers) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), EXTERNAL_USAGE_TIMEOUT_MS);
		try {
			const response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return await response.json();
		} finally {
			clearTimeout(timer);
		}
	}

	/** 失败原因只留一句短的，不要把响应体或凭据带出来。 */
	function shortError(err) {
		const message = String(err?.message ?? err);
		if (/abort/i.test(message)) return '请求超时';
		return message.slice(0, 120);
	}

	/** 解 Codex access token 里的账号 id（JWT 的 chatgpt_account_id）。 */
	function decodeCodexAccountId(token) {
		try {
			const part = String(token).split('.')[1];
			if (!part) return '';
			const json = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
			const id = json?.['https://api.openai.com/auth']?.chatgpt_account_id;
			return typeof id === 'string' ? id : '';
		} catch {
			return '';
		}
	}

	/** 把 wham/usage 的返回压成可展示的窗口列表（口径与 codex-usage 扩展一致）。 */
	function parseCodexQuota(payload) {
		const rateLimit = payload?.rate_limit && typeof payload.rate_limit === 'object' ? payload.rate_limit : {};
		const windows = [];
		for (const key of ['primary_window', 'secondary_window']) {
			const window = rateLimit[key];
			if (!window || typeof window !== 'object') continue;
			const seconds = Number(window.limit_window_seconds);
			const usedPercent = Number(window.used_percent);
			if (!Number.isFinite(seconds) || seconds <= 0) continue;
			if (!Number.isFinite(usedPercent)) continue;
			const resetAt = Number(window.reset_at);
			windows.push({
				label: windowLabel(seconds),
				seconds,
				remainingPercent: Math.max(0, Math.min(100, 100 - usedPercent)),
				resetAt: Number.isFinite(resetAt) && resetAt > 0 ? resetAt * 1000 : null,
			});
		}
		windows.sort((a, b) => a.seconds - b.seconds);
		const credits = payload?.credits && typeof payload.credits === 'object' ? payload.credits : null;
		let creditsText = '';
		if (credits?.unlimited === true) creditsText = '∞';
		else if (credits?.has_credits !== false && credits?.balance !== undefined && credits?.balance !== null) {
			const balance = String(credits.balance).trim();
			if (balance) creditsText = balance.startsWith('$') ? balance : `$${balance}`;
		}
		return { windows, credits: creditsText, limitReached: rateLimit.limit_reached === true };
	}

	/** Codex 账号额度：5 小时 / 7 天窗口的剩余百分比、重置时间与可用额度。 */
	async function fetchCodexQuota() {
		const token = await providerKey('openai-codex');
		if (!token) return { ok: false, error: '未登录 openai-codex' };
		const headers = { accept: 'application/json', authorization: `Bearer ${token}`, 'user-agent': 'pigui' };
		const accountId = decodeCodexAccountId(token);
		if (accountId) headers['chatgpt-account-id'] = accountId;
		try {
			return { ok: true, ...parseCodexQuota(await fetchJson(CODEX_USAGE_URL, headers)), fetchedAt: Date.now() };
		} catch (err) {
			return { ok: false, error: shortError(err) };
		}
	}

	/** OpenCode Go 套餐用量：rolling / weekly / monthly 三个窗口的**已用**百分比。 */
	async function fetchOpencodeGoUsage() {
		const key = await providerKey('opencode-go');
		if (!key) return { ok: false, error: '未登录 opencode-go' };
		try {
			const payload = await fetchJson(OPENCODE_GO_USAGE_URL, {
				accept: 'application/json',
				authorization: `Bearer ${key}`,
				'user-agent': 'pigui',
			});
			const usage = payload?.usage && typeof payload.usage === 'object' ? payload.usage : {};
			const labels = { rolling: '滚动窗口', weekly: '本周', monthly: '本月' };
			const windows = [];
			for (const name of ['rolling', 'weekly', 'monthly']) {
				const raw = usage[name];
				if (!raw || typeof raw !== 'object') continue;
				const used = Number(raw.percent);
				windows.push({
					key: name,
					label: labels[name],
					usedPercent: Number.isFinite(used) ? Math.max(0, Math.min(100, used)) : null,
					status: typeof raw.status === 'string' ? raw.status : '',
					resetsAt: typeof raw.resetsAt === 'string' ? raw.resetsAt : null,
				});
			}
			return { ok: true, windows, fetchedAt: Date.now() };
		} catch (err) {
			return { ok: false, error: shortError(err) };
		}
	}

	/** 取外部额度（60 秒缓存）；refresh 为真时强制重取。两个请求并行，各自降级。 */
	async function getExternalUsage(refresh = false) {
		if (!refresh && externalUsageCache && Date.now() - externalUsageCache.at < EXTERNAL_USAGE_TTL_MS) {
			return externalUsageCache.value;
		}
		const [codex, opencode] = await Promise.all([fetchCodexQuota(), fetchOpencodeGoUsage()]);
		const value = { fetchedAt: Date.now(), codex, opencode };
		externalUsageCache = { at: Date.now(), value };
		return value;
	}

	return { getExternalUsage };
}
