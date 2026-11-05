import type { LogEntry } from '@ungate/shared/frontend';

const LOG_LEVELS = new Set<LogEntry['level']>(['info', 'warn', 'error']);
const DETAIL_FIELDS = ['location', 'protocol', 'target', 'status', 'details'] as const;

/** Converts cloudflared JSON logs into one timestamped, human-readable entry. */
export function parseCloudflaredLogLine(line: string, receivedAt = Date.now()): LogEntry {
	try {
		const raw = JSON.parse(line) as Record<string, unknown>;
		const parsedTime = typeof raw.time === 'string' ? Date.parse(raw.time) : Number.NaN;
		const rawLevel = typeof raw.level === 'string' ? raw.level : '';
		const level = LOG_LEVELS.has(rawLevel as LogEntry['level']) ? (rawLevel as LogEntry['level']) : 'info';
		const message = typeof raw.message === 'string' && raw.message.trim() ? raw.message.trim() : 'cloudflared event';
		const details: string[] = [];
		if (typeof raw.error === 'string' && raw.error.trim() && raw.error.trim() !== message) {
			details.push(`error: ${raw.error.trim()}`);
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
