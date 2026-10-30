<script lang="ts">
import { createCopyFeedback } from '$shared/copy-feedback.svelte';
import { getSavedLogPanelHeight, type LogSource } from '$shared/vscode';

import { LOG_PANEL } from './log-tail';
import LogPanel from './LogPanel.svelte';
import { getLogsStore } from './logs-store.svelte';

const store = getLogsStore();
const sources = ['api', 'tunnel'] as const;
const copied = createCopyFeedback<LogSource>();
let error = $state<string | null>(null);

async function copy(source: LogSource): Promise<void> {
	error = null;
	try {
		await store.copy(source);
		copied.mark(source);
	} catch {
		error = 'Could not copy logs. Select and copy the text below.';
	}
}
</script>

<div class="ug-stack">
	{#if error}<p
			class="ug-error"
			role="alert">{error}</p
		>{/if}
	{#each sources as source}
		{@const entries = store.source(source).entries}
		{@const revision = store.source(source).revision}
		<LogPanel
			source={source}
			entries={entries}
			revision={revision}
			initialHeight={getSavedLogPanelHeight(source, LOG_PANEL.defaultHeight)}
			copied={copied.value === source}
			oncopy={() => copy(source)}
			onclear={() => store.clear(source)} />
	{/each}
</div>
