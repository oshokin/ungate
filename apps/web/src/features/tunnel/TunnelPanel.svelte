<script lang="ts">
import IconCheck from 'virtual:icons/lucide/check';
import IconCopy from 'virtual:icons/lucide/copy';
import IconEye from 'virtual:icons/lucide/eye';
import IconEyeOff from 'virtual:icons/lucide/eye-off';

import { getActionStore, performAction, runDashboardAction } from '$shared/actions.svelte';
import { Api } from '$shared/api';
import { getServiceStore } from '$shared/service-store.svelte';
import { createToastWatcher, showToast } from '$shared/toast.svelte';

import { getTunnelStore } from './tunnel-store.svelte';

const store = getTunnelStore();
const service = getServiceStore();
const actions = getActionStore();
const watchTunnelError = createToastWatcher();
const labels = { stopped: 'Stopped', installing: 'Installing…', starting: 'Starting…', running: 'Running', error: 'Error' };
const tunnelLabel = $derived(labels[store.tunnel.status]);
let copied = $state(false);
let apiKeyCopied = $state(false);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;
let apiKeyCopiedTimer: ReturnType<typeof setTimeout> | null = null;
let apiKey = $state('');
let savedApiKey = $state('');
let revealApiKey = $state(false);
let savingApiKey = $state(false);

async function copyTunnelUrl(): Promise<void> {
	try {
		await runDashboardAction('copy-tunnel-url');
		copied = true;
		if (copiedTimer) clearTimeout(copiedTimer);
		copiedTimer = setTimeout(() => {
			copied = false;
		}, 3000);
	} catch {
		// The shared toast renders the error.
	}
}

async function copyApiKey(): Promise<void> {
	try {
		await runDashboardAction('copy-api-key');
		apiKeyCopied = true;
		if (apiKeyCopiedTimer) clearTimeout(apiKeyCopiedTimer);
		apiKeyCopiedTimer = setTimeout(() => {
			apiKeyCopied = false;
		}, 3000);
	} catch {
		// The shared toast renders the error.
	}
}

async function loadApiKey(): Promise<void> {
	try {
		const settings = await Api.fetchSettings();
		apiKey = settings.apiKey ?? '';
		savedApiKey = apiKey;
	} catch {
		// The settings page owns the persistent load error.
	}
}

async function saveApiKey(): Promise<void> {
	if (!apiKey.trim()) {
		showToast('Ungate API key cannot be empty', 'error');

		return;
	}
	savingApiKey = true;
	try {
		await Api.updateSettings({ apiKey: apiKey.trim() });
		savedApiKey = apiKey.trim();
		await runDashboardAction('restart-services');
		showToast('API key saved', 'status');
	} catch {
		// The shared action/toast layer renders the error.
	} finally {
		savingApiKey = false;
	}
}

$effect(() => {
	if (service.state.status === 'ready') void loadApiKey();
});
$effect(() => watchTunnelError(store.tunnel.error, 'error'));
</script>

<section
	class="ug-card ug-stack"
	aria-label="Connection">
	<div class="ug-row">
		<h1 class="ug-title">Connection</h1>
		<div class="ug-statuses">
			<span
				>API {service.state.version ?? (service.state.status === 'incompatible' ? 'legacy' : '')} · {service.state.status ===
				'ready'
					? 'Ready'
					: service.state.status}</span>
			<span
				><span
					class="ug-dot"
					class:ug-online={store.tunnel.status === 'running'}></span
				>Tunnel · {tunnelLabel}</span>
		</div>
	</div>
	{#if store.tunnel.url && store.tunnel.status === 'running'}
		<div class="ug-endpoint">
			<input
				readonly
				aria-label="Tunnel API URL"
				value={`${store.tunnel.url}/v1`} />
			<button
				class="ug-button ug-quiet"
				disabled={!!actions.busy}
				onclick={() => void copyTunnelUrl()}
				aria-label={copied ? 'Tunnel URL copied' : 'Copy tunnel URL'}
				title={copied ? 'Copied' : 'Copy tunnel URL'}>
				{#if copied}<IconCheck class="size-4" />{:else}<IconCopy class="size-4" />{/if}
			</button>
		</div>
		<label class="ug-label">
			API key
			<div class="ug-endpoint">
				<input
					type={revealApiKey ? 'text' : 'password'}
					aria-label="Ungate API key"
					autocomplete="off"
					bind:value={apiKey} />
				<button
					class="ug-button ug-quiet"
					type="button"
					aria-label={revealApiKey ? 'Hide API key' : 'Show API key'}
					title={revealApiKey ? 'Hide API key' : 'Show API key'}
					onclick={() => (revealApiKey = !revealApiKey)}>
					{#if revealApiKey}<IconEyeOff class="size-4" />{:else}<IconEye class="size-4" />{/if}
				</button>
				<button
					class="ug-button ug-quiet"
					type="button"
					disabled={!!actions.busy || service.state.status !== 'ready'}
					aria-label={apiKeyCopied ? 'API key copied' : 'Copy API key'}
					title={apiKeyCopied ? 'Copied' : 'Copy API key'}
					onclick={() => void copyApiKey()}>
					{#if apiKeyCopied}<IconCheck class="size-4" />{:else}<IconCopy class="size-4" />{/if}
				</button>
			</div>
		</label>
		{#if apiKey !== savedApiKey}
			<button
				class="ug-button"
				disabled={savingApiKey || !!actions.busy}
				onclick={() => void saveApiKey()}>{savingApiKey ? 'Saving…' : 'Save API key & restart API'}</button>
		{/if}
		<div class="ug-toolbar">
			<button
				class="ug-button ug-primary"
				disabled={!!actions.busy}
				onclick={() => performAction('open-cursor-models')}>Open Cursor Models</button>
		</div>
		<p class="ug-setup-hint">
			Paste both values, then turn on <strong>Use OpenAI API Key</strong>
			<span
				class="ug-shortcut"
				aria-label="Control Shift zero">
				<kbd>Ctrl</kbd><span>+</span><kbd>Shift</kbd><span>+</span><kbd>0</kbd>
			</span>
			<span class="ug-muted">Turn it off for Cursor models.</span>
		</p>
	{:else}
		<div class="ug-toolbar">
			<button
				class="ug-button ug-primary"
				disabled={!!actions.busy || service.state.status !== 'ready'}
				onclick={() => performAction('start-tunnel')}>
				{actions.busy === 'start-tunnel' ? 'Starting…' : 'Start tunnel'}
			</button>
			<span class="ug-muted">Shared by local and SSH windows on this computer.</span>
		</div>
	{/if}
	<details class="ug-details">
		<summary>Connection details</summary>
		<div class="ug-stack ug-muted">
			<p
				>Reloading a window keeps the shared API and tunnel alive. Restart tunnel reconnects cloudflared; if its URL changes, copy
				the new URL into Cursor.</p>
			<p
				>Ungate cannot automatically change Cursor’s Base URL or verify its billing route. Quick Tunnels may work in practice, but
				Cloudflare classifies them as development-only, provides no uptime guarantee, and does not officially support SSE.</p>
			<div class="ug-toolbar">
				<button
					class="ug-button"
					disabled={!!actions.busy}
					onclick={() => performAction('restart-tunnel')}>Restart tunnel</button>
				<button
					class="ug-button"
					disabled={!!actions.busy}
					onclick={() => performAction('stop-tunnel')}>Stop tunnel only</button>
			</div>
		</div>
	</details>
</section>
