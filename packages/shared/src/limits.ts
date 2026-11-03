/** Transport deadlines leave the extension time to report an error before the UI times out. */
export const DASHBOARD_TRANSPORT = {
	/** One dashboard HTTP call. */
	requestTimeoutMs: 25_000,
	/** Webview wait for the extension reply, longer than the HTTP call. */
	clientTimeoutMs: 30_000,
	/** Long management action such as a service restart. */
	actionTimeoutMs: 180_000,
	/** Dashboard calls in flight before the next one is refused. */
	maxConcurrentRequests: 16,
	/** Largest management request the webview may send. */
	maxRequestBytes: 512 * 1024,
	/** How often the webview looks for the API port after startup. */
	portPollIntervalMs: 100
} as const;

/** Bounds for the log viewer and the files behind it. */
export const LOG_LIMITS = {
	/** Entries shown per source when the setting is missing. */
	defaultEntries: 500,
	/** Smallest value accepted for ungate.logs.maxEntries. */
	minEntries: 100,
	/** Largest value accepted for ungate.logs.maxEntries. */
	maxEntries: 5_000,
	/** Rotated log files kept on disk per source. */
	maxFiles: 24,
	/** Largest single log file read from disk. */
	maxFileBytes: 512 * 1024,
	/** Bytes read from the end of a log file in one pass. */
	readChunkBytes: 64 * 1024
} as const;

export function normalizeLogEntryLimit(value: unknown): number {
	return typeof value === 'number' && Number.isInteger(value) && value >= LOG_LIMITS.minEntries && value <= LOG_LIMITS.maxEntries
		? value
		: LOG_LIMITS.defaultEntries;
}

/** How long transient dashboard feedback stays on screen. */
export const UI_TIMING = {
	/** Copied confirmation for the API key and tunnel URL. */
	copyFeedbackMs: 3_000,
	/** Saved confirmation after settings are written. */
	savedFeedbackMs: 2_000,
	/** Status notice that is not an error. */
	statusNoticeMs: 4_000
} as const;
