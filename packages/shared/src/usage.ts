import type { ModelMappingProvider, ProviderUsage, UsageWindow } from './types';

export const USAGE_REFRESH = { defaultSeconds: 60, minSeconds: 15, maxSeconds: 3600 } as const;
export interface UsagePreferences {
	autoRefresh: boolean;
	intervalSeconds: number;
	widgets: Record<ModelMappingProvider, boolean>;
}
export interface UsageState {
	data: { providers: ProviderUsage[] } | null;
	preferences: UsagePreferences;
	loading: boolean;
	error: string | null;
	nextUpdate: string | null;
}
export function formatUsagePercent(value: number | null): string {
	if (value === null || !Number.isFinite(value)) return 'Not reported';
	if (value > 0 && value < 1) return '<1%';

	return `${Math.floor(Math.max(0, value))}%`;
}
export function formatUsageDuration(seconds: number | null): string {
	if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return 'Period not reported';
	let remaining = seconds;
	const parts: string[] = [];
	for (const [unit, size] of [
		['d', 86400],
		['h', 3600],
		['m', 60],
		['s', 1]
	] as const) {
		const amount = Math.floor(remaining / size);
		if (amount) parts.push(`${amount}${unit}`);
		remaining %= size;
	}

	return parts.join(' ') || `${seconds}s`;
}
export function basicUsageWindows(provider: ProviderUsage): UsageWindow[] {
	return provider.windows.filter(
		(window) =>
			provider.provider === 'minimax' ||
			(provider.provider === 'claude' ? ['five_hour', 'seven_day'].includes(window.id) : window.id.startsWith('rate_limit.'))
	);
}
export function limitingUsageWindow(provider: ProviderUsage): UsageWindow | undefined {
	return basicUsageWindows(provider)
		.filter((window) => window.remainingPercent !== null && Number.isFinite(window.remainingPercent))
		.sort(
			(a, b) =>
				a.remainingPercent! - b.remainingPercent! ||
				(a.resetsAt ? Date.parse(a.resetsAt) : Infinity) - (b.resetsAt ? Date.parse(b.resetsAt) : Infinity) ||
				a.id.localeCompare(b.id)
		)[0];
}
export function formatUsageReset(value: string | null, now = Date.now()): string {
	if (!value || !Number.isFinite(Date.parse(value))) return 'Reset time not reported';
	const delta = Date.parse(value) - now;

	return delta <= 0 ? 'Reset time passed; awaiting refresh' : `Resets in ${formatUsageDuration(Math.ceil(delta / 60000) * 60)}`;
}
