import { secondsToMilliseconds } from 'date-fns';

import type { UsageWindow } from '@ungate/shared';

/** Seconds in one hour, used to label provider usage windows. */
const SECONDS_PER_HOUR = 60 * 60;
/** Seconds in one civil day. */
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;
/** Claude five-hour usage window when the payload omits a duration. */
const FIVE_HOUR_WINDOW_SECONDS = 5 * SECONDS_PER_HOUR;
/** Claude weekly usage window when the payload omits a duration. */
const SEVEN_DAY_WINDOW_SECONDS = 7 * SECONDS_PER_DAY;
/** ECMAScript time values must stay within ±8.64e15 milliseconds. */
const MAX_TIME_VALUE_MS = 8.64e15;

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function number(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
function reset(value: unknown, seconds = false): string | null {
	if (typeof value !== 'string' && typeof value !== 'number') return null;
	const at = typeof value === 'number' ? (seconds ? secondsToMilliseconds(value) : value) : Date.parse(value);

	return Number.isFinite(at) && at > 0 && at <= MAX_TIME_VALUE_MS ? new Date(at).toISOString() : null;
}

export function parseClaudeUsage(payload: unknown): UsageWindow[] {
	const data = record(payload);
	const windows: UsageWindow[] = [];
	const labels: Record<string, string> = {
		five_hour: 'Five hours',
		seven_day: 'Weekly',
		seven_day_opus: 'Weekly · Opus',
		seven_day_sonnet: 'Weekly · Sonnet',
		seven_day_oauth_apps: 'Weekly · OAuth apps'
	};
	for (const [id, label] of Object.entries(labels)) {
		const raw = record(data[id]);
		const used = number(raw.utilization);
		if (used === null) continue;
		windows.push({
			id,
			label,
			usedPercent: used,
			remainingPercent: Math.max(0, 100 - used),
			resetsAt: reset(raw.resets_at),
			windowSeconds: id === 'five_hour' ? FIVE_HOUR_WINDOW_SECONDS : SEVEN_DAY_WINDOW_SECONDS
		});
	}

	return windows;
}

export function parseOpenAiUsage(payload: unknown): UsageWindow[] {
	const data = record(payload);
	const windows: UsageWindow[] = [];
	for (const [pool, label] of [
		['rate_limit', 'Codex'],
		['code_review_rate_limit', 'Code review']
	] as const) {
		const limits = record(data[pool]);
		for (const name of ['primary_window', 'secondary_window']) {
			const raw = record(limits[name]);
			const used = number(raw.used_percent);
			if (used === null) continue;
			const duration = number(raw.limit_window_seconds);
			const windowLabel =
				duration === null
					? name.replace('_', ' ')
					: duration % SECONDS_PER_DAY === 0
						? `${duration / SECONDS_PER_DAY} days`
						: `${duration / SECONDS_PER_HOUR} hours`;
			windows.push({
				id: `${pool}.${name}`,
				label: `${label} · ${windowLabel}`,
				usedPercent: used,
				remainingPercent: Math.max(0, 100 - used),
				resetsAt: reset(raw.reset_at, true),
				windowSeconds: duration
			});
		}
	}

	return windows;
}

export function parseMiniMaxUsage(payload: unknown): UsageWindow[] {
	const data = record(payload);
	const status = record(data.base_resp);
	if (typeof status.status_code === 'number' && status.status_code !== 0)
		throw new Error('MiniMax rejected the subscription usage request');
	if (!Array.isArray(data.model_remains)) return [];
	const windows: UsageWindow[] = [];
	for (const value of data.model_remains) {
		const raw = record(value);
		if (typeof raw.model_name !== 'string') continue;
		const remaining = number(raw.current_interval_remaining_percent);
		// Usage-count and remains_time semantics are not a published contract. Do not infer totals or reset times.
		if (remaining !== null && remaining <= 100)
			windows.push({
				id: raw.model_name,
				label: raw.model_name,
				usedPercent: 100 - remaining,
				remainingPercent: remaining,
				resetsAt: null,
				windowSeconds: null
			});
	}

	return windows;
}
