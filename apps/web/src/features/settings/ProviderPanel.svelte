<script lang="ts">
import ProviderIcon from '$shared/ProviderIcon.svelte';
import { showToast } from '$shared/toast-store.svelte';

import ChatGPTAuthSection from '../auth/ChatGPTAuthSection.svelte';
import ClaudeAuthSection from '../auth/ClaudeAuthSection.svelte';
import MiniMaxAuthSection from '../auth/MiniMaxAuthSection.svelte';

import ClaudeCliVersionSection from './ClaudeCliVersionSection.svelte';
import { getModelDiscoveryStore } from './model-discovery-store.svelte';
import ModelsSection from './ModelsSection.svelte';
import { getSettingsFormStore } from './settings-form-store.svelte';
import { getSettingsStore } from './settings-store.svelte';
import { getSettingsUiStore, ProviderAuthState } from './settings-ui-store.svelte';

import type { ModelMappingProvider } from '@ungate/shared/frontend';

const ui = getSettingsUiStore();
const settings = getSettingsStore();
const form = getSettingsFormStore();
const discovery = getModelDiscoveryStore();
const providers: ModelMappingProvider[] = ['claude', 'openai', 'minimax'];
const labels = {
	[ProviderAuthState.Authorized]: 'Connected',
	[ProviderAuthState.NotAuthorized]: 'Not connected',
	[ProviderAuthState.Loading]: 'Checking…'
};
let expanded = $state<ModelMappingProvider | null>(null);

function manage(provider: ModelMappingProvider): void {
	expanded = expanded === provider ? null : provider;
	ui.setSelectedProvider(provider);
}
async function save(): Promise<void> {
	const validationError = form.validate();
	if (validationError) {
		showToast(validationError, 'error');

		return;
	}
	await settings.save(form.toSavePayload());
	if (!settings.error) form.markModelsSaved();
}
function refresh(): void {
	void ui.refreshAuthStates();
}
async function handleConnected(provider: ModelMappingProvider): Promise<void> {
	refresh();
	await discovery.syncAfterConnection(provider);
}
</script>

<div class="ug-provider-list">
	{#each providers as provider}
		<div class="ug-provider-row">
			<span class="ug-provider-name font-medium">
				<ProviderIcon provider={provider} />
				{ui.providerLabels[provider]}
			</span>
			<span class="ug-connection-status ug-muted">
				<span
					class="ug-dot"
					class:ug-online={ui.authStates[provider] === ProviderAuthState.Authorized}></span>
				{labels[ui.authStates[provider]]}
			</span>
			<button
				class="ug-button ug-quiet"
				aria-label={`${expanded === provider ? 'Close' : 'Manage'} ${ui.providerLabels[provider]}`}
				aria-expanded={expanded === provider}
				onclick={() => manage(provider)}>{expanded === provider ? 'Close' : 'Manage'}</button>
		</div>
		{#if expanded === provider}
			<div class="ug-provider-content ug-stack">
				{#if provider === 'claude'}
					<ClaudeAuthSection
						onAuthStatusChange={refresh}
						onConnected={() => handleConnected(provider)} />
					<ClaudeCliVersionSection />
				{:else if provider === 'openai'}
					<ChatGPTAuthSection
						onAuthStatusChange={refresh}
						onConnected={() => handleConnected(provider)} />
				{:else}
					<MiniMaxAuthSection
						onAuthStatusChange={refresh}
						onConnected={() => handleConnected(provider)} />
				{/if}
				<ModelsSection
					selectedProvider={provider}
					onSave={save}
					saving={settings.saving}
					saved={settings.saved}
					restarting={settings.restarting} />
			</div>
		{/if}
	{/each}
</div>
