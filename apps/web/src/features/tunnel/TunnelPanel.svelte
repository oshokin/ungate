<script lang="ts">
import IconCheck from 'virtual:icons/lucide/check';
import IconCopy from 'virtual:icons/lucide/copy';
import IconEye from 'virtual:icons/lucide/eye';
import IconEyeOff from 'virtual:icons/lucide/eye-off';

import { getActionStore, performAction, runDashboardAction } from '$shared/actions.svelte';
import { Api } from '$shared/api';
import { createCopyFeedback } from '$shared/copy-feedback.svelte';
import NumericPreference from '$shared/NumericPreference.svelte';
import { getServiceStore } from '$shared/service-store.svelte';
import { createToastWatcher, showToast } from '$shared/toast-store.svelte';
import { postExtensionMessage } from '$shared/vscode';

import { connectionState } from './connection-state';
import { getTunnelStore } from './tunnel-store.svelte';

import type { Snippet } from 'svelte';

let { tunnelOptions, runtimeOptions }: { tunnelOptions?: Snippet; runtimeOptions?: Snippet } = $props();
const store = getTunnelStore();
const service = getServiceStore();
const actions = getActionStore();
const watchTunnelError = createToastWatcher('tunnel');
const NGROK_TOKEN_URL = 'https://dashboard.ngrok.com/get-started/your-authtoken';
const tunnelChoices = [
	{ id: 'quick', label: 'Cloudflare' },
	{ id: 'ngrok', label: 'ngrok' }
] as const;
const connection = $derived(connectionState(store.tunnel, store.provider));
const copyFeedback = createCopyFeedback<'url' | 'key' | 'token'>();
const copied = $derived(copyFeedback.value === 'url');
const apiKeyCopied = $derived(copyFeedback.value === 'key');
let apiKey = $state('');
let savedApiKey = $state('');
let apiKeyLoadError = $state(false);
let loadingApiKey = $state(false);
let revealApiKey = $state(false);
let savingApiKey = $state(false);
let ngrokToken = $state('');
let savedNgrokToken = $state('');
let revealNgrokToken = $state(false);
let pendingProvider = $state<'quick' | 'ngrok' | null>(null);
let savingNgrokToken = $state(false);
let pendingRevision = $state(0);
const tunnelTransition = $derived(['installing', 'starting'].includes(store.tunnel.status));
const connectionBusy = $derived(!!actions.busy || !!pendingProvider || savingNgrokToken || tunnelTransition);
const needsToken = $derived(store.provider === 'ngrok' && !store.token.trim());

$effect(() => {
	if (store.configRevision <= pendingRevision) return;
	if (savingNgrokToken && store.token === ngrokToken.trim()) {
		savedNgrokToken = store.token;
		showToast('ngrok authtoken saved', 'status');
	} else if (savingNgrokToken) {
		showToast('The ngrok authtoken was not saved. Try again.', 'error');
	}
	pendingProvider = null;
	savingNgrokToken = false;
});

async function copyTunnelUrl(): Promise<void> {
	try {
		await runDashboardAction('copy-tunnel-url');
		copyFeedback.mark('url');
	} catch {
		// The shared toast renders the error.
	}
}

async function copyApiKey(): Promise<void> {
	try {
		await runDashboardAction('copy-api-key');
		copyFeedback.mark('key');
	} catch {
		// The shared toast renders the error.
	}
}

async function loadApiKey(): Promise<void> {
	loadingApiKey = true;
	apiKeyLoadError = false;
	try {
		const settings = await Api.fetchSettings();
		if (service.state.status !== 'ready') return;
		if (apiKey === savedApiKey) apiKey = settings.apiKey ?? '';
		savedApiKey = settings.apiKey ?? '';
	} catch {
		apiKeyLoadError = true;
	} finally {
		loadingApiKey = false;
	}
}

function chooseTunnel(provider: 'quick' | 'ngrok'): void {
	if (provider === store.provider || connectionBusy) return;
	pendingRevision = store.configRevision;
	if (postExtensionMessage({ type: 'set-tunnel-provider', provider })) pendingProvider = provider;
}

function saveNgrokToken(): void {
	const token = ngrokToken.trim();
	if (!token) {
		showToast('The ngrok authtoken is empty', 'error');

		return;
	}
	pendingRevision = store.configRevision;
	if (!postExtensionMessage({ type: 'set-ngrok-auth-token', token })) return;
	ngrokToken = token;
	savingNgrokToken = true;
}

async function copyNgrokToken(): Promise<void> {
	if (!ngrokToken) return;
	try {
		await navigator.clipboard.writeText(ngrokToken);
		copyFeedback.mark('token');
	} catch {
		showToast('Could not copy the ngrok authtoken.', 'error');
	}
}

$effect(() => {
	const incoming = store.token;
	if (ngrokToken !== savedNgrokToken || incoming === savedNgrokToken) return;
	ngrokToken = incoming;
	savedNgrokToken = incoming;
});

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
	// A restart-required build still stores the key. Cursor's OpenAI key toggle does not.
	if (service.state.status === 'ready') void loadApiKey();
	else revealApiKey = false;
});
$effect(() => watchTunnelError(store.tunnel.error, 'error'));
</script>

<section
	class="ug-card ug-stack"
	aria-label="Connection">
	<h1 class="ug-title">Connection</h1>
	<label class="ug-label"
		>Base URL
		{#if connection.endpoint}
			<div class="ug-endpoint">
				<input
					readonly
					aria-label="Tunnel API URL"
					value={connection.endpoint} />
				<button
					class="ug-button ug-quiet"
					disabled={!!actions.busy}
					onclick={() => void copyTunnelUrl()}
					aria-label={copied ? 'Tunnel URL copied' : 'Copy tunnel URL'}
					title={copied ? 'Copied' : 'Copy tunnel URL'}>
					{#if copied}<IconCheck class="size-4" />{:else}<IconCopy class="size-4" />{/if}
				</button>
			</div>
		{:else}
			<div class="ug-endpoint"
				><input
					readonly
					aria-label="Tunnel API URL"
					placeholder="Start a tunnel to get a Base URL" /><button
					class="ug-button ug-quiet"
					disabled
					aria-label="Copy tunnel URL"><IconCopy class="size-4" /></button
				></div>
		{/if}
	</label>
	<label class="ug-label">
		API key
		<div class="ug-endpoint">
			<input
				type={revealApiKey ? 'text' : 'password'}
				aria-label="Ungate API key"
				autocomplete="off"
				value={service.state.status === 'ready' ? apiKey : ''}
				placeholder={service.state.status !== 'ready'
					? 'Unavailable — Local API is not ready'
					: loadingApiKey
						? 'Loading API key…'
						: apiKeyLoadError
							? 'Could not load API key'
							: 'API key'}
				disabled={service.state.status !== 'ready' || loadingApiKey || savingApiKey}
				oninput={(event) => (apiKey = event.currentTarget.value)} />
			<button
				class="ug-button ug-quiet"
				type="button"
				aria-label={revealApiKey ? 'Hide API key' : 'Show API key'}
				title={revealApiKey ? 'Hide API key' : 'Show API key'}
				disabled={service.state.status !== 'ready' || !apiKey}
				onclick={() => (revealApiKey = !revealApiKey)}>
				{#if revealApiKey}<IconEyeOff class="size-4" />{:else}<IconEye class="size-4" />{/if}
			</button>
			<button
				class="ug-button ug-quiet"
				type="button"
				disabled={!!actions.busy || service.state.status !== 'ready' || !savedApiKey || apiKey !== savedApiKey}
				aria-label={apiKeyCopied ? 'API key copied' : 'Copy API key'}
				title={apiKeyCopied ? 'Copied' : 'Copy API key'}
				onclick={() => void copyApiKey()}>
				{#if apiKeyCopied}<IconCheck class="size-4" />{:else}<IconCopy class="size-4" />{/if}
			</button>
		</div>
	</label>
	{#if apiKey !== savedApiKey}
		<div class="ug-toolbar ug-end">
			<button
				class="ug-button ug-primary"
				disabled={savingApiKey || !!actions.busy}
				onclick={() => void saveApiKey()}>{savingApiKey ? 'Saving…' : 'Save API key & restart API'}</button>
		</div>
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
			aria-label="Control Shift top-row zero">
			<kbd>Ctrl</kbd><span>+</span><kbd>Shift</kbd><span>+</span><kbd>0</kbd>
		</span>
		<span>(top-row zero; shortcut depends on your keybindings).</span>
		<span class="ug-muted">Turn it off for Cursor models.</span>
	</p>
	<hr />
	<div
		class="ug-stack ug-service-controls"
		role="group"
		aria-label="Service controls">
		<div
			class="ug-row ug-service-control"
			data-service="tunnel">
			<span><strong>Tunnel</strong> · {connection.providerLabel} · {connection.status}</span>
			<div class="ug-toolbar">
				<button
					class="ug-button ug-compact"
					disabled={connectionBusy || needsToken || service.state.status !== 'ready'}
					onclick={() => performAction(store.tunnel.status === 'running' ? 'restart-tunnel' : 'start-tunnel')}
					>{store.tunnel.status === 'running' ? 'Restart tunnel' : 'Start tunnel'}</button>
				{#if store.tunnel.status === 'running'}
					<button
						class="ug-button ug-compact ug-caution"
						disabled={connectionBusy || store.tunnel.status !== 'running'}
						onclick={() => performAction('stop-tunnel')}>Stop</button>
				{/if}
			</div>
		</div>
	</div>
	<div class="ug-stack">
		<div
			class="ug-choice"
			role="group"
			aria-label="Tunnel">
			{#each tunnelChoices as choice}
				<button
					type="button"
					class="ug-button ug-compact"
					aria-pressed={store.provider === choice.id}
					disabled={connectionBusy}
					onclick={() => chooseTunnel(choice.id)}>
					{choice.label}
				</button>
			{/each}
		</div>
		{#if pendingProvider}
			<p
				class="ug-muted"
				role="status"
				>Selecting {pendingProvider === 'ngrok' ? 'ngrok' : 'Cloudflare'}… Check Cursor for a replacement confirmation.</p>
		{/if}

		{#if connection.mismatch}<p class="ug-muted"
				>Selected {store.provider === 'ngrok' ? 'ngrok' : 'Cloudflare'} differs from {connection.providerLabel}; the Base URL
				belongs to the running tunnel.</p
			>{/if}
	</div>
	{#if store.tunnel.status === 'running' && store.tunnel.publicStatus === 'unreachable'}<p
			class="ug-muted"
			role="status">Public route unavailable. {store.tunnel.publicError ?? 'Custom Ungate models may fail.'}</p
		>{/if}
	{#if store.provider === 'ngrok'}
		<details
			class="ug-details ug-ngrok-account"
			open={needsToken}
			><summary>ngrok account</summary>
			{#if needsToken}<p class="ug-muted">Save an ngrok authtoken before starting ngrok.</p>{/if}
			<label class="ug-label">
				Authtoken
				<div class="ug-endpoint">
					<input
						id="ngrok-authtoken"
						type={revealNgrokToken ? 'text' : 'password'}
						aria-label="ngrok authtoken"
						autocomplete="off"
						placeholder="Paste authtoken"
						disabled={savingNgrokToken}
						bind:value={ngrokToken} />
					<button
						class="ug-button ug-quiet"
						type="button"
						aria-label={revealNgrokToken ? 'Hide authtoken' : 'Show authtoken'}
						title={revealNgrokToken ? 'Hide authtoken' : 'Show authtoken'}
						onclick={() => (revealNgrokToken = !revealNgrokToken)}>
						{#if revealNgrokToken}<IconEyeOff class="size-4" />{:else}<IconEye class="size-4" />{/if}
					</button>
					<button
						class="ug-button ug-quiet"
						type="button"
						disabled={!ngrokToken}
						aria-label={copyFeedback.value === 'token' ? 'Authtoken copied' : 'Copy authtoken'}
						title={copyFeedback.value === 'token' ? 'Copied' : 'Copy authtoken'}
						onclick={() => void copyNgrokToken()}>
						{#if copyFeedback.value === 'token'}<IconCheck class="size-4" />{:else}<IconCopy class="size-4" />{/if}
					</button>
				</div>
			</label>
			<p class="ug-muted">
				The login for your ngrok account. Copy it from
				<a
					class="ug-link"
					href={NGROK_TOKEN_URL}
					target="_blank"
					rel="noopener noreferrer">dashboard.ngrok.com/get-started/your-authtoken</a
				>. Ungate passes it to ngrok as NGROK_AUTHTOKEN and keeps it in editor secret storage. Saving does not start or restart a
				tunnel.
			</p>
			{#if ngrokToken.trim() !== savedNgrokToken}
				<div class="ug-toolbar ug-end">
					<button
						class="ug-button ug-primary"
						type="button"
						disabled={!ngrokToken.trim() || connectionBusy}
						onclick={saveNgrokToken}>{savingNgrokToken ? 'Saving…' : 'Save'}</button>
				</div>
			{/if}
		</details>
	{/if}
	<details class="ug-details ug-tunnel-options"
		><summary>Tunnel options</summary>
		<NumericPreference
			preference="tunnel.connectTimeoutSeconds"
			label="Connect timeout (s)"
			min={15}
			max={120}
			help="Applies to the next tunnel start." />
		{#if store.provider === 'quick'}{@render tunnelOptions?.()}{/if}

		<div class="ug-stack ug-muted ug-operational-warnings">
			<p
				>Reloading a window keeps the shared API and tunnel alive. Cloudflare and ngrok cannot run together. Choosing the other
				one replaces the tunnel that is running, and Cursor needs the new URL.</p>
			<p
				>Ungate cannot automatically change Cursor’s Base URL or verify its billing route. Quick Tunnels may work in practice, but
				Cloudflare classifies them as development-only, provides no uptime guarantee, and does not officially support SSE.</p>
		</div>
	</details>
	<div
		class="ug-row ug-service-control"
		data-service="api">
		<span
			><strong>Local API</strong> · {service.state.status === 'ready'
				? service.state.logsConnected === false
					? 'Logging disconnected'
					: 'Ready'
				: service.state.status}</span>
		<button
			class="ug-button ug-compact"
			disabled={!!actions.busy}
			onclick={() => performAction('restart-services')}>
			{actions.busy === 'restart-services' ? 'Restarting…' : 'Restart API'}
		</button>
	</div>
	<details class="ug-details">
		<summary>API configuration</summary>
		{@render runtimeOptions?.()}
	</details>
</section>
