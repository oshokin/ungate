<script lang="ts">
import { getServiceStore } from '$shared/service-store.svelte';
import { createToastWatcher, showToast } from '$shared/toast-store.svelte';

import TunnelPanel from '../tunnel/TunnelPanel.svelte';

import ProviderPanel from './ProviderPanel.svelte';
import { getSettingsFormStore } from './settings-form-store.svelte';
import { getSettingsStore } from './settings-store.svelte';
import { getSettingsUiStore } from './settings-ui-store.svelte';

const store = getSettingsStore();
const form = getSettingsFormStore();
const ui = getSettingsUiStore();
const service = getServiceStore();
const availability = $derived(service.state.status);
const watchSettingsError = createToastWatcher();

function save(): void {
	const validationError = form.validate();
	if (validationError) {
		showToast(validationError, 'error');

		return;
	}
	void store.saveAndRestart(form.toSavePayload());
}

// Reload only when a compatible service becomes available (also after an upgrade).
$effect(() => {
	if (availability === 'ready') {
		void store.load();
		void ui.refreshAuthStates();
	}
});
$effect(() => {
	if (store.settings) form.syncFromAppSettings(store.settings);
});
$effect(() => watchSettingsError(store.settings ? store.error : null, 'error'));
</script>

<div class="ug-stack">
	<TunnelPanel />
	{#if service.state.status === 'ready'}
		{#if store.loading && !store.settings}<p role="status">Loading settings…</p>{/if}
		{#if store.error}
			<div
				class="ug-banner"
				role="alert">
				<div><strong>Unable to load settings</strong><p class="ug-muted">{store.error}</p></div>
				<button
					class="ug-button"
					disabled={store.loading}
					onclick={() => void store.load()}>Retry</button>
			</div>
		{/if}
		{#if store.settings}
			<details class="ug-card ug-details">
				<summary>Advanced settings</summary>
				<div class="ug-stack">
					<div class="ug-form-grid">
						<label class="ug-label"
							>Port<input
								class="input"
								type="number"
								value={form.port}
								oninput={(event) => form.setPort(event.currentTarget.value)} /></label>
						<label class="ug-label"
							>Tunnel protocol<select
								class="select"
								aria-label="Tunnel protocol"
								value={form.tunnelProtocol}
								onchange={(event) => form.setTunnelProtocol(event.currentTarget.value)}>
								<option value="http2">HTTP/2</option>
								<option value="quic">QUIC</option>
								<option value="auto">Auto</option>
							</select></label>
					</div>
					<p class="ug-muted">
						HTTP/2 works through most firewalls. QUIC is for networks where HTTP/2 cannot reach Cloudflare. Saving a different
						protocol restarts a running tunnel and replaces its URL.
					</p>
					<label class="ug-label"
						>Global instruction<textarea
							class="textarea"
							rows={3}
							value={form.extraInstruction}
							oninput={(event) => form.setExtraInstruction(event.currentTarget.value)}
							placeholder="Additional system instruction"></textarea
						></label>
					<button
						class="ug-button ug-primary"
						disabled={store.saving || store.restarting}
						onclick={save}>{store.restarting ? 'Restarting…' : 'Save & restart API'}</button>
				</div>
			</details>
			<section
				class="ug-card"
				aria-label="Providers and models">
				<h2 class="ug-section-title">Providers & models</h2>
				<ProviderPanel />
			</section>
		{/if}
	{/if}
</div>
