<script lang="ts">
import InfoTooltip from '$shared/InfoTooltip.svelte';

import { CLAUDE_CLI_VERSION_OPTIONS } from './claude-cli-version-options';
import { getSettingsFormStore } from './settings-form-store.svelte';

import type { ClaudeCliVersionMode } from '@ungate/shared/frontend';

const formStore = getSettingsFormStore();

const applyHint = 'Takes effect after Save & Restart in Server Configuration.';

function buttonClass(optionMode: ClaudeCliVersionMode): string {
	if (formStore.claudeCliVersionMode === optionMode) {
		return 'ug-primary';
	}

	return 'ug-quiet';
}
</script>

<div class="space-y-2 border-t ug-border pt-4">
	<div class="space-y-1">
		<p class="text-xs ug-description">Claude Code version</p>
		<p class="text-xs ug-foreground">{applyHint}</p>
	</div>

	<div class="flex flex-wrap items-center gap-2">
		<div class="inline-flex max-w-full flex-wrap rounded-lg border ug-border p-0.5">
			{#each CLAUDE_CLI_VERSION_OPTIONS as option}
				<InfoTooltip text={option.tooltip}>
					{#snippet children(tooltipId)}
						<button
							type="button"
							class="ug-button h-auto gap-1.5 rounded-md px-3 py-1 {buttonClass(option.mode)}"
							aria-pressed={formStore.claudeCliVersionMode === option.mode}
							aria-describedby={tooltipId}
							onclick={() => formStore.setClaudeCliVersionMode(option.mode)}>
							{option.label}
							{#if option.version}
								<span class="font-mono text-xs">{option.version}</span>
							{/if}
						</button>
					{/snippet}
				</InfoTooltip>
			{/each}
		</div>

		{#if formStore.claudeCliVersionMode === 'custom'}
			<input
				class="ug-input ug-version-input font-mono text-sm"
				type="text"
				placeholder="2.1.280"
				value={formStore.claudeCliVersionCustom}
				oninput={(event) => formStore.setClaudeCliVersionCustom(event.currentTarget.value)} />
		{/if}
	</div>
</div>
