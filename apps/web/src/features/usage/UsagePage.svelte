<script lang="ts">
import { onMount } from 'svelte';

import ProviderIcon from '$shared/ProviderIcon.svelte';
import { createToastWatcher } from '$shared/toast-store.svelte';

import { getUsageStore } from './usage-store.svelte';

import type { ModelMappingProvider, ProviderUsage } from '@ungate/shared/frontend';

const usage = getUsageStore();
const watchUsageError = createToastWatcher();
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
	return value === null ? 'Not reported' : `${value.toFixed(1)}%`;
}
onMount(() => {
	usage.ensureLoaded();
});
$effect(() => watchUsageError(usage.error, 'error'));
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
			class="ug-button ug-primary"
			disabled={usage.loading}
			onclick={() => void usage.refresh()}>{usage.loading ? 'Refreshing…' : 'Refresh'}</button>
	</div>
	{#each providers as providerName (providerName)}
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
							><span>{window.label}</span><span
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
				<p class="text-xs ug-description">Last data: {date(provider.fetchedAt)} · Checked: {date(provider.checkedAt)}</p>
			{:else}
				<p
					class="text-sm ug-description"
					role="status">Reading subscription limits…</p>
			{/if}
		</article>
	{/each}
</section>
