/** Transport deadlines leave the extension time to report an error before the UI times out. */
export const DASHBOARD_TRANSPORT = {
	requestTimeoutMs: 25_000,
	clientTimeoutMs: 30_000,
	actionTimeoutMs: 180_000,
	maxConcurrentRequests: 16,
	maxRequestBytes: 512 * 1024,
	portPollIntervalMs: 100
} as const;

export const LOG_LIMITS = {
	defaultEntries: 500,
	minEntries: 100,
	maxEntries: 5_000,
	maxFiles: 24,
	maxFileBytes: 512 * 1024,
	readChunkBytes: 64 * 1024
} as const;

export function normalizeLogEntryLimit(value: unknown): number {
	return typeof value === 'number' && Number.isInteger(value) && value >= LOG_LIMITS.minEntries && value <= LOG_LIMITS.maxEntries
		? value
		: LOG_LIMITS.defaultEntries;
}

export const UI_TIMING = {
	copyFeedbackMs: 3_000,
	savedFeedbackMs: 2_000,
	statusNoticeMs: 4_000
} as const;
