<script lang="ts">
import { formatUsageDuration, formatUsagePercent, type ModelMappingProvider, type ProviderUsage } from '@ungate/shared/frontend';
import { onMount } from 'svelte';

import ProviderIcon from '$shared/ProviderIcon.svelte';

import { getUsageStore } from './usage-store.svelte';

const usage = getUsageStore();
let preferenceError = $state<string | null>(null);
let intervalDraft = $state<number | undefined>(undefined);
let editingInterval = $state(false);
let saving = $state(false);
async function save(patch: Record<string, boolean | number>): Promise<void> {
	saving = true;
	preferenceError = null;
	try {
		await usage.savePreferences(patch);
	} catch (error) {
		preferenceError = error instanceof Error ? error.message : String(error);
	} finally {
		saving = false;
	}
}
function commitInterval(): void {
	if (!editingInterval) return;
	if (!Number.isInteger(intervalDraft) || intervalDraft! < 15 || intervalDraft! > 3600) {
		preferenceError = 'Enter a whole number from 15 to 3600 seconds.';

		return;
	}
	editingInterval = false;
	void save({ intervalSeconds: intervalDraft! });
}
const providers: ModelMappingProvider[] = ['claude', 'openai', 'minimax'];
const labels = { claude: 'Claude', openai: 'ChatGPT / Codex', minimax: 'MiniMax' };
const statuses = {
	ok: 'Connected',
	not_connected: 'Not connected',
	unsupported: 'Not supported',
	unavailable: 'Unavailable',
	error: 'Could not refresh'
};
function providerUsage(provider: ModelMappingProvider): ProviderUsage | null {
	return usage.data?.providers.find((item) => item.provider === provider) ?? null;
}
function date(value: string | null): string {
	return value ? new Date(value).toLocaleString() : 'Not reported';
}
function percent(value: number | null): string {
	return formatUsagePercent(value);
}
onMount(() => {
	usage.ensureLoaded();
});
</script>

<section
	class="w-full space-y-5"
	aria-label="Subscription usage">
	<div class="flex flex-wrap items-start justify-between gap-4">
		<div
			><h1 class="text-xl font-semibold">Subscription usage</h1><p class="text-sm ug-description mt-1"
				>Limits reported by your connected provider accounts.</p
			></div>
		<button
			class="ug-button ug-primary min-w-28"
			disabled={usage.loading}
			onclick={() => void usage.refresh()}>{usage.loading ? 'Refreshing…' : 'Refresh'}</button>
	</div>
	<div class="flex flex-wrap items-center gap-3 text-sm">
		<label class="flex items-center gap-2"
			><input
				type="checkbox"
				checked={usage.preferences.autoRefresh}
				disabled={saving}
				onchange={(event) => void save({ autoRefresh: event.currentTarget.checked })} />Automatically refresh</label>
		{#if usage.preferences.autoRefresh}
			<label class="flex items-center gap-2"
				>Every <input
					class="ug-input w-20"
					type="number"
					min="15"
					max="3600"
					step="1"
					aria-label="Refresh interval in seconds"
					value={editingInterval ? intervalDraft : usage.preferences.intervalSeconds}
					oninput={(event) => {
						editingInterval = true;
						intervalDraft = event.currentTarget.valueAsNumber;
					}}
					onblur={commitInterval}
					onkeydown={(event) => {
						if (event.key === 'Enter') commitInterval();
						if (event.key === 'Escape') {
							editingInterval = false;
							preferenceError = null;
						}
					}} /> seconds</label>
		{/if}
	</div>
	{#if !usage.preferences.autoRefresh}
		<p class="text-sm ug-description">Enable automatic refresh to use status bar widgets. Your widget selections are kept.</p>
	{/if}
	{#if preferenceError || usage.error}<p
			class="text-sm ug-warning"
			role="alert">{preferenceError ?? usage.error}</p
		>{/if}
	{#if usage.data && !usage.data.providers.some((provider) => provider.status !== 'not_connected')}<p class="ug-description"
			>Connect a provider in Connection to see subscription usage.</p
		>{/if}
	{#each providers.filter((name) => providerUsage(name)?.status !== 'not_connected' && providerUsage(name) !== null) as providerName (providerName)}
		{@const provider = providerUsage(providerName)}
		<article class="ug-panel p-5 space-y-4">
			<div class="flex flex-wrap justify-between gap-2">
				<h2 class="ug-provider-name font-semibold">
					<ProviderIcon provider={providerName} />
					{labels[providerName]}
				</h2>
				<span class="ug-connection-status text-sm ug-description">
					<span
						class="ug-dot"
						class:ug-online={provider?.status === 'ok'}></span>
					{provider ? statuses[provider.status] : 'Checking…'}</span
				></div>
			{#if provider}
				{#if provider.message}<p
						class="text-sm ug-description"
						role={provider.status === 'error' ? 'alert' : undefined}>{provider.message}</p
					>{/if}
				{#if provider.stale}<p class="text-sm ug-warning">Refresh failed. The figures below are from the previous update.</p>{/if}
				{#each provider.windows as window (window.id)}
					<div class="space-y-2">
						<div class="flex flex-wrap justify-between gap-2 text-sm"
							><span>{window.label} · {formatUsageDuration(window.windowSeconds)}</span><span
								>{percent(window.usedPercent)} used · {percent(window.remainingPercent)} remaining</span
							></div>
						{#if window.usedPercent !== null}<progress
								class="ug-progress w-full"
								aria-label={`${window.label} used`}
								value={Math.min(window.usedPercent, 100)}
								max="100"></progress
							>{/if}
						<p class="text-xs ug-description">Resets: {date(window.resetsAt)}</p>
					</div>
				{/each}
				<p class="text-xs ug-description">Last data: {date(provider.fetchedAt)}</p>
			{:else}
				<p
					class="text-sm ug-description"
					role="status">Reading subscription limits…</p>
			{/if}
			{#if usage.preferences.autoRefresh}<label class="flex items-center gap-2 text-sm"
					><input
						type="checkbox"
						aria-label={`Show ${labels[providerName]} limits in status bar`}
						checked={usage.preferences.widgets[providerName]}
						disabled={saving}
						onchange={(event) => void save({ [`widgets.${providerName}`]: event.currentTarget.checked })} />Show in status bar</label
				>{/if}
		</article>
	{/each}
</section>
