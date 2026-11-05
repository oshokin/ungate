import type { ModelMappingProvider } from '@ungate/shared';

export interface ProviderHealthSnapshot {
	provider: ModelMappingProvider;
	lastSuccessAt: number | null;
	lastErrorAt: number | null;
	lastStatus: number | null;
	errorCategory: string | null;
	consecutiveFailures: number;
}

const providers: ModelMappingProvider[] = ['claude', 'openai', 'minimax'];
const entries = new Map<ModelMappingProvider, ProviderHealthSnapshot>();

function entry(provider: ModelMappingProvider): ProviderHealthSnapshot {
	return (
		entries.get(provider) ?? {
			provider,
			lastSuccessAt: null,
			lastErrorAt: null,
			lastStatus: null,
			errorCategory: null,
			consecutiveFailures: 0
		}
	);
}

export const ProviderHealth = {
	success(provider: ModelMappingProvider, status: number): void {
		entries.set(provider, {
			...entry(provider),
			lastSuccessAt: Date.now(),
			lastStatus: status,
			errorCategory: null,
			consecutiveFailures: 0
		});
	},
	failure(provider: ModelMappingProvider, category: string, status: number | null = null): void {
		const current = entry(provider);
		entries.set(provider, {
			...current,
			lastErrorAt: Date.now(),
			lastStatus: status ?? current.lastStatus,
			errorCategory: category,
			consecutiveFailures: current.consecutiveFailures + 1
		});
	},
	snapshot(): ProviderHealthSnapshot[] {
		return providers.map((provider) => ({ ...entry(provider) }));
	}
};
