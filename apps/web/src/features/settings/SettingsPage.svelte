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
	<TunnelPanel>
		{#snippet tunnelOptions()}
			{#if store.settings && availability === 'ready'}
				<label class="ug-label"
					>Cloudflare protocol<select
						class="ug-select"
						aria-label="Cloudflare protocol"
						value={form.tunnelProtocol}
						onchange={(event) => form.setTunnelProtocol(event.currentTarget.value)}>
						<option value="http2">HTTP/2</option>
						<option value="quic">QUIC</option>
						<option value="auto">Auto</option>
					</select></label>
				<p class="ug-muted"
					>HTTP/2 works through most firewalls. Changing protocol restarts a running Cloudflare tunnel and replaces its URL.</p>
				<button
					class="ug-button ug-primary"
					disabled={store.saving || store.restarting}
					onclick={save}>Save & restart API</button>
			{/if}
		{/snippet}
		{#snippet runtimeOptions()}
			<div class="ug-stack">
				{#if store.settings && availability === 'ready'}
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
				{/if}
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
				<p class="ug-muted"
					>Editor preferences save separately and apply on the next API start. API settings remain a draft until saved. Save &
					restart applies all API settings drafts, including model instructions and tunnel protocol.</p>
				{#if store.settings && availability === 'ready'}
					<button
						class="ug-button ug-primary"
						disabled={store.saving || store.restarting}
						onclick={save}>{store.restarting ? 'Restarting…' : 'Save & restart API'}</button>
				{/if}
			</div>
		{/snippet}
	</TunnelPanel>
	{#if service.state.status === 'ready'}
		{#if store.loading && !store.settings}<p role="status">Loading settings…</p>{/if}
		{#if store.error}
			<div
				class="ug-banner"
				role="alert">
				<div><strong>Unable to load settings</strong><p class="ug-muted">{store.error}</p></div>
				<button
					class="ug-button ug-primary"
					disabled={store.loading}
					onclick={() => void store.load()}>Retry</button>
			</div>
		{/if}
		{#if store.settings}
			<details class="ug-card ug-details">
				<summary>Model instructions</summary>
				<div class="ug-stack">
					<p class="ug-muted"> Additional system instruction for models. Save & restart applies all API settings drafts. </p>
					<label class="ug-label"
						>Global instruction<textarea
							class="ug-textarea"
							rows={3}
							value={form.extraInstruction}
							oninput={(event) => form.setExtraInstruction(event.currentTarget.value)}
							placeholder="Additional system instruction"></textarea
						></label>
					<div class="ug-toolbar ug-end">
						<button
							class="ug-button ug-primary"
							disabled={store.saving || store.restarting}
							onclick={save}>{store.restarting ? 'Restarting…' : 'Save & restart API'}</button>
					</div>
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
