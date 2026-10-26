import { Api } from '$shared/api';

import { reconcileDiscoveredModels, removeNotListedModels, restoreRemovedModels } from './model-discovery';
import { getSettingsFormStore } from './settings-form-store.svelte';

import type { ModelReconciliation, RemovedModel } from './model-discovery';
import type { DiscoveredModel, ModelMappingProvider } from '@ungate/shared/frontend';

interface ProviderDiscoveryState {
	loading: boolean;
	error: string | null;
	summary: Pick<ModelReconciliation, 'added' | 'existing' | 'renamed'> | null;
	notListedUpstreamModels: string[];
	catalogMessage: string | null;
	removedNotListed: RemovedModel[];
	autoSaved: boolean;
	usingFallback: boolean;
	catalog: DiscoveredModel[];
}

function emptyState(): ProviderDiscoveryState {
	return {
		loading: false,
		error: null,
		summary: null,
		notListedUpstreamModels: [],
		catalogMessage: null,
		removedNotListed: [],
		autoSaved: false,
		usingFallback: false,
		catalog: []
	};
}

const states = $state<Record<ModelMappingProvider, ProviderDiscoveryState>>({
	claude: emptyState(),
	openai: emptyState(),
	minimax: emptyState()
});
let autoSaveQueue: Promise<void> = Promise.resolve();

async function sync(provider: ModelMappingProvider): Promise<void> {
	const state = states[provider];
	state.loading = true;
	state.error = null;
	state.autoSaved = false;
	state.usingFallback = false;

	try {
		const response = await Api.discoverModels(provider);
		if (response.status !== 'ok') {
			state.notListedUpstreamModels = [];
			state.catalog = [];
			const configuredCount = getSettingsFormStore().models.filter((model) => model.provider === provider).length;
			if (configuredCount > 0) {
				state.summary = { added: 0, existing: configuredCount, renamed: [] };
				state.catalogMessage = `${response.message ?? 'The provider model catalog is unavailable.'} Configured models were kept as fallback.`;
				state.usingFallback = true;
			} else {
				state.summary = null;
				state.catalogMessage = null;
				state.error = response.message ?? 'The provider model catalog is unavailable.';
			}

			return;
		}

		const formStore = getSettingsFormStore();
		const reconciliation = reconcileDiscoveredModels(formStore.models, response);
		formStore.setModels(reconciliation.models);
		state.catalog = response.models;
		state.summary = {
			added: reconciliation.added,
			existing: reconciliation.existing,
			renamed: reconciliation.renamed
		};
		state.notListedUpstreamModels = reconciliation.notListedUpstreamModels;
		state.catalogMessage = response.message;
	} catch (error) {
		state.summary = null;
		state.notListedUpstreamModels = [];
		state.catalogMessage = null;
		state.catalog = [];
		state.error = error instanceof Error ? error.message : 'Unable to sync models.';
	} finally {
		state.loading = false;
	}
}

export function getModelDiscoveryStore() {
	return {
		state(provider: ModelMappingProvider): ProviderDiscoveryState {
			return states[provider];
		},
		sync,
		async syncAfterConnection(provider: ModelMappingProvider): Promise<void> {
			const state = states[provider];
			const formStore = getSettingsFormStore();
			const hadUnsavedModelEdits = formStore.modelsDirty;
			await sync(provider);
			if (hadUnsavedModelEdits || state.error || !state.summary?.added) return;
			autoSaveQueue = autoSaveQueue
				.catch(() => {})
				.then(async () => {
					await Api.updateSettings({ models: formStore.models });
					formStore.markModelsSaved();
				});
			try {
				await autoSaveQueue;
				state.autoSaved = true;
			} catch (error) {
				state.error =
					error instanceof Error
						? `Models were discovered but could not be saved: ${error.message}`
						: 'Models were discovered but could not be saved.';
			}
		},
		notListedModelCount(provider: ModelMappingProvider): number {
			const state = states[provider];
			const targets = state.notListedUpstreamModels.map((item) => item.trim().toLowerCase());

			return getSettingsFormStore().models.filter(
				(model) => model.provider === provider && targets.includes(model.upstreamModel.trim().toLowerCase())
			).length;
		},
		removeNotListed(provider: ModelMappingProvider): void {
			const state = states[provider];
			const formStore = getSettingsFormStore();
			const result = removeNotListedModels(formStore.models, provider, state.notListedUpstreamModels);
			if (!result.removed.length) return;
			formStore.setModels(result.models);
			state.removedNotListed = result.removed;
			state.notListedUpstreamModels = [];
		},
		undoRemoveNotListed(provider: ModelMappingProvider): void {
			const state = states[provider];
			if (!state.removedNotListed.length) return;
			const formStore = getSettingsFormStore();
			formStore.setModels(restoreRemovedModels(formStore.models, state.removedNotListed));
			state.notListedUpstreamModels = state.removedNotListed
				.map((item) => item.model.upstreamModel)
				.filter(
					(item, index, items) =>
						items.findIndex((candidate) => candidate.trim().toLowerCase() === item.trim().toLowerCase()) === index
				);
			state.removedNotListed = [];
		},
		acknowledgeSaved(provider: ModelMappingProvider): void {
			states[provider].removedNotListed = [];
		},
		isNotListed(provider: ModelMappingProvider, upstreamModel: string): boolean {
			const normalized = upstreamModel.trim().toLowerCase();

			return states[provider].notListedUpstreamModels.some((item) => item.trim().toLowerCase() === normalized);
		}
	};
}
