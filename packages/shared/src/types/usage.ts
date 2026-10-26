import type { ModelMappingProvider } from './settings';

export interface UsageWindow {
	id: string;
	label: string;
	usedPercent: number | null;
	remainingPercent: number | null;
	resetsAt: string | null;
	windowSeconds: number | null;
}

export interface ProviderUsage {
	provider: ModelMappingProvider;
	status: 'ok' | 'not_connected' | 'unsupported' | 'unavailable' | 'error';
	message: string | null;
	checkedAt: string;
	fetchedAt: string | null;
	stale: boolean;
	windows: UsageWindow[];
	source: string | null;
	contract: 'public' | 'internal';
}

export interface SubscriptionUsage {
	providers: ProviderUsage[];
}
