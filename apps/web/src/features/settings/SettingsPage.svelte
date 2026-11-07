<script lang="ts">
import { TCP_PORT_MAX, TCP_PORT_MIN } from '@ungate/shared/frontend';
import { untrack } from 'svelte';

import { getActionStore, performAction } from '$shared/actions.svelte';
import NumericPreference from '$shared/NumericPreference.svelte';
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
const actions = getActionStore();
const availability = $derived(service.state.status);
const watchSettingsError = createToastWatcher('settings');

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
	const settings = store.settings;
	if (settings) untrack(() => form.syncFromAppSettings(settings));
});
$effect(() => watchSettingsError(store.settings ? store.error : null, 'error'));
</script>

<div class="ug-stack">
	<TunnelPanel />
	<details class="ug-card ug-details">
		<summary>Advanced editor preferences</summary>
		<div class="ug-stack">
			<NumericPreference
				preference="network.providerHeaderTimeoutSeconds"
				label="Provider header timeout (s)"
				min={5}
				max={120}
				help="Applies to the next API restart; not a stream idle timeout." />
			<div>
				<button
					class="ug-button"
					disabled={!!actions.busy}
					onclick={() => performAction('choose-node-runtime')}>Choose Node.js executable</button>
				<p class="ug-muted">Choose a validated local runtime. A running shared API is not restarted.</p>
			</div>
		</div>
	</details>
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
								class="ug-input"
								type="number"
								min={TCP_PORT_MIN}
								max={TCP_PORT_MAX}
								step="1"
								required
								value={form.port}
								oninput={(event) => form.setPort(event.currentTarget.value)} /></label>
						<label class="ug-label"
							>Tunnel protocol<select
								class="ug-select"
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
							class="ug-textarea"
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
