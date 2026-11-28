import type { LogEntry } from '@ungate/shared/frontend';

const LOG_LEVELS = new Set<LogEntry['level']>(['info', 'warn', 'error']);
const DETAIL_FIELDS = ['location', 'protocol', 'target', 'status', 'details'] as const;

/** Skip routine ngrok forwarding diagnostics at ingestion, before journal append. */
export function isRoutineNgrokConnection(line: string): boolean {
	try {
		const raw = JSON.parse(line) as Record<string, unknown>;

		return raw.obj === 'join' && raw.msg === 'join connections' && raw.lvl === 'info' && !raw.err && !raw.error;
	} catch {
		return false;
	}
}

/** Converts tunnel JSON logs into one timestamped, human-readable entry. */
export function parseCloudflaredLogLine(line: string, receivedAt = Date.now()): LogEntry {
	try {
		const raw = JSON.parse(line) as Record<string, unknown>;
		const time = raw.time ?? raw.t;
		const parsedTime = typeof time === 'string' ? Date.parse(time) : Number.NaN;
		const rawLevel = typeof raw.level === 'string' ? raw.level : typeof raw.lvl === 'string' ? raw.lvl : '';
		const level = LOG_LEVELS.has(rawLevel as LogEntry['level']) ? (rawLevel as LogEntry['level']) : 'info';
		const text = typeof raw.message === 'string' && raw.message.trim() ? raw.message : raw.msg;
		const message = typeof text === 'string' && text.trim() ? text.trim() : 'cloudflared event';
		const details: string[] = [];
		const error = raw.error ?? raw.err;
		if (typeof error === 'string' && error.trim() && error.trim() !== message) {
			details.push(`error: ${error.trim()}`);
		}
		for (const field of DETAIL_FIELDS) {
			const value = raw[field];
			if ((typeof value === 'string' || typeof value === 'number') && String(value).trim()) {
				details.push(`${field}: ${String(value).trim()}`);
			}
		}

		return {
			timestamp: Number.isFinite(parsedTime) ? parsedTime : receivedAt,
			level,
			message: [message, ...details].join(' · ')
		};
	} catch {
		return { timestamp: receivedAt, level: 'info', message: line };
	}
}
