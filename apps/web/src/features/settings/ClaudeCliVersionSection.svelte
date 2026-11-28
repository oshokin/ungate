<script lang="ts">
import InfoTooltip from '$shared/InfoTooltip.svelte';

import { CLAUDE_CLI_VERSION_OPTIONS } from './claude-cli-version-options';
import { getSettingsFormStore } from './settings-form-store.svelte';

const formStore = getSettingsFormStore();

const applyHint = 'Takes effect after Save & Restart in Server Configuration.';
</script>

<div class="space-y-2 border-t ug-border pt-4">
	<div class="space-y-1">
		<p class="text-xs ug-description">Claude Code version</p>
		<p class="text-xs ug-foreground">{applyHint}</p>
	</div>

	<div class="flex flex-wrap items-center gap-2">
		<div class="ug-choice">
			{#each CLAUDE_CLI_VERSION_OPTIONS as option}
				<InfoTooltip text={option.tooltip}>
					{#snippet children(tooltipId)}
						<button
							type="button"
							class="ug-button ug-compact h-auto gap-1.5"
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
