import {
	limitingUsageWindow,
	formatUsageDuration,
	formatUsagePercent,
	formatUsageReset,
	type ModelMappingProvider,
	type ProviderUsage,
	type UsageWindow
} from '@ungate/shared/frontend';

const LABELS: Record<ModelMappingProvider, string> = {
	claude: 'Claude',
	openai: 'ChatGPT',
	minimax: 'MiniMax'
};

/** The two windows the status line shows. Other pools, such as code review, stay in the dashboard. */
function shownWindows(windows: UsageWindow[]): UsageWindow[] {
	return windows;
}

function windowLabel(window: UsageWindow): string {
	return formatUsageDuration(window.windowSeconds);
}

function used(window: UsageWindow): string | null {
	return window.remainingPercent === null ? null : formatUsagePercent(window.remainingPercent);
}

/** Connected providers that actually returned windows. Disconnected accounts are absent, not shown as zero. */
export function visibleLimitProviders(providers: ProviderUsage[]): ProviderUsage[] {
	return providers.filter((provider) => provider.status !== 'not_connected' && limitingUsageWindow(provider) !== undefined);
}

/** One status-bar line. Null means the item should stay hidden. */
export function formatSubscriptionLimitLine(providers: ProviderUsage[]): string | null {
	const parts = visibleLimitProviders(providers).map((provider) => {
		const windows = [limitingUsageWindow(provider)!]
			.map((window) => {
				const value = used(window);

				return value === null ? null : `${windowLabel(window)} ${value}`;
			})
			.filter((part): part is string => part !== null);

		return `${LABELS[provider.provider]} ${provider.provider === 'minimax' ? 'min ' : ''}${windows.join(' · ')} left${provider.stale ? ' (stale)' : ''}`;
	});

	return parts.length > 0 ? parts.join(' · ') : null;
}

export function formatSubscriptionLimitTooltip(providers: ProviderUsage[]): string {
	const lines: string[] = [];
	for (const provider of visibleLimitProviders(providers)) {
		lines.push(LABELS[provider.provider]);
		const selected = limitingUsageWindow(provider);
		for (const window of [selected!, ...shownWindows(provider.windows).filter((item) => item !== selected)]) {
			const value = used(window);
			if (value === null) continue;
			const basic = window.id === 'five_hour' || window.id === 'seven_day' || window.id.startsWith('rate_limit.');
			lines.push(`${basic ? windowLabel(window) : window.label} · ${value} left`);
			lines.push(formatUsageReset(window.resetsAt));
		}
		if (provider.stale) lines.push('Showing the last successful read');
		lines.push(`Updated: ${provider.fetchedAt ? new Date(provider.fetchedAt).toLocaleTimeString() : 'Not reported'}`);
	}

	return lines.join('\n');
}
