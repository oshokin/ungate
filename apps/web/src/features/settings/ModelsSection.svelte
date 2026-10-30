<script lang="ts">
import { getProviderLabel, isReasoningBudgetTier, sleep } from '@ungate/shared/frontend';
import IconCheck from 'virtual:icons/lucide/check';
import IconChevronDown from 'virtual:icons/lucide/chevron-down';
import IconCopy from 'virtual:icons/lucide/copy';
import IconRefreshCw from 'virtual:icons/lucide/refresh-cw';
import IconTrash2 from 'virtual:icons/lucide/trash-2';
import IconTriangleAlert from 'virtual:icons/lucide/triangle-alert';

import { createToastWatcher } from '$shared/toast-store.svelte';
import { getSavedSettingsModelId, saveSettingsModelId } from '$shared/vscode';

import { groupModelFamilies } from './model-discovery';
import { getModelDiscoveryStore } from './model-discovery-store.svelte';
import { getSettingsFormStore } from './settings-form-store.svelte';

import type { GroupedModelItem, ModelFamilyGroup } from './model-discovery';
import type { ModelMappingConfig, ModelMappingProvider } from '@ungate/shared/frontend';

interface VisibleModelItem {
	model: ModelMappingConfig;
	index: number;
}

interface Props {
	selectedProvider: ModelMappingProvider;
	onSave: () => void;
	saving: boolean;
	saved: boolean;
	restarting: boolean;
}

let { selectedProvider, onSave, saving, saved, restarting }: Props = $props();

const formStore = getSettingsFormStore();
const discoveryStore = getModelDiscoveryStore();
const watchDiscoveryError = createToastWatcher();

let copiedId = $state<string | null>(null);
let confirmDeleteModelLabel = $state<string | null>(null);
let confirmDeleteIndex = $state<number | null>(null);
let activeModelIndex = $state<number | null>(null);
let expandedFamilyKey = $state<string | null>(null);

const providerExamples = {
	claude: { id: 'sonnet-4.6', label: 'Sonnet 4.6', upstreamModel: 'claude-sonnet-4-6' },
	openai: { id: 'gpt-5.6-sol-medium', label: 'GPT-5.6 Sol Medium', upstreamModel: 'gpt-5.6-sol' },
	minimax: { id: 'minimax-m2.7', label: 'MiniMax M2.7', upstreamModel: 'MiniMax-M2.7' }
};
const example = $derived(providerExamples[selectedProvider]);
const discoveryState = $derived(discoveryStore.state(selectedProvider));
const modelFamilies = $derived(groupModelFamilies(formStore.models, selectedProvider, discoveryState.catalog));
const notListedModelCount = $derived(discoveryStore.notListedModelCount(selectedProvider));
const discoveryReviewCount = $derived((discoveryState.summary?.renamed.length ?? 0) + notListedModelCount);

const commonReasoningOptions: { label: string; value: ModelMappingConfig['reasoningBudget'] }[] = [
	{ label: 'Default', value: null },
	{ label: 'None', value: 'none' },
	{ label: 'Low', value: 'low' },
	{ label: 'Medium', value: 'medium' },
	{ label: 'High', value: 'high' },
	{ label: 'Extra High', value: 'xhigh' },
	{ label: 'Max', value: 'max' }
];
const openAiReasoningOptions: { label: string; value: ModelMappingConfig['reasoningBudget'] }[] = [
	...commonReasoningOptions.slice(0, 2),
	{ label: 'Minimal', value: 'minimal' },
	...commonReasoningOptions.slice(2),
	{ label: 'Ultra', value: 'ultra' },
	{ label: 'Persistent', value: 'persistent' }
];
const reasoningOptions = $derived(selectedProvider === 'openai' ? openAiReasoningOptions : commonReasoningOptions);

const serviceTierOptions: { label: string; value: ModelMappingConfig['serviceTier'] }[] = [
	{ label: 'Default', value: null },
	{ label: 'Normal', value: 'default' },
	{ label: 'Fast / Priority', value: 'priority' }
];

function commit(nextModels: ModelMappingConfig[]) {
	formStore.setModels(nextModels);
}

function visibleModels(): VisibleModelItem[] {
	return formStore.models.map((model, index) => ({ model, index })).filter((item) => item.model.provider === selectedProvider);
}

function familyItems(group: ModelFamilyGroup): GroupedModelItem[] {
	return group.rows.flatMap((row) => [...row.standard, ...row.fast]);
}

function familyForIndex(index: number): ModelFamilyGroup | null {
	return modelFamilies.find((group) => familyItems(group).some((item) => item.index === index)) ?? null;
}

function variantCount(group: ModelFamilyGroup): number {
	return familyItems(group).length;
}

function reasoningCount(group: ModelFamilyGroup): number {
	return group.rows.length;
}

function toggleFamily(group: ModelFamilyGroup): void {
	expandedFamilyKey = expandedFamilyKey === group.key ? null : group.key;
}

function selectVariant(item: GroupedModelItem): void {
	activeModelIndex = item.index;
	expandedFamilyKey = familyForIndex(item.index)?.key ?? expandedFamilyKey;
	saveActiveModel(item);
}

function isProviderDefaultVariant(group: ModelFamilyGroup, item: GroupedModelItem): boolean {
	if (!group.isProviderDefault) return false;
	const reasoningMatches = group.defaultReasoningLevel === null || item.model.reasoningBudget === group.defaultReasoningLevel;
	const serviceMatches =
		group.defaultServiceTier === 'priority'
			? item.model.serviceTier === 'priority'
			: item.model.serviceTier === null || item.model.serviceTier === 'default';

	return reasoningMatches && serviceMatches;
}

function activeVisibleModel(): VisibleModelItem | null {
	if (activeModelIndex === null) {
		return null;
	}

	const active = visibleModels().find((item) => item.index === activeModelIndex);

	if (!active) {
		return null;
	}

	return active;
}

function modelTitle(item: VisibleModelItem): string {
	if (item.model.label.trim()) {
		return item.model.label;
	}

	if (item.model.id.trim()) {
		return item.model.id;
	}

	return `Model ${item.index + 1}`;
}

function modelSelectionId(item: VisibleModelItem): string {
	return item.model.id.trim() || `#row-${item.index}`;
}

function saveActiveModel(item: VisibleModelItem): void {
	saveSettingsModelId(selectedProvider, modelSelectionId(item));
}

function addModel() {
	const nextIndex = formStore.models.length;

	commit([
		...formStore.models,
		{
			id: '',
			label: '',
			provider: selectedProvider,
			upstreamModel: '',
			sortOrder: formStore.models.length,
			reasoningBudget: null,
			serviceTier: null
		}
	]);

	activeModelIndex = nextIndex;
	expandedFamilyKey = `#row-${nextIndex}`;
	saveSettingsModelId(selectedProvider, `#row-${nextIndex}`);
}

function inputValue(event: Event): string {
	const target = event.target;

	if (!target || !(target instanceof HTMLInputElement)) {
		return '';
	}

	return target.value;
}

function selectValue(event: Event): string {
	const target = event.target;

	if (!target || !(target instanceof HTMLSelectElement)) {
		return '';
	}

	return target.value;
}

function updateModelAtIndex(index: number, key: keyof ModelMappingConfig, value: string | number | null) {
	if (key === 'id' && activeModelIndex === index) {
		const modelId = typeof value === 'string' ? value.trim() : '';
		saveSettingsModelId(selectedProvider, modelId || `#row-${index}`);
	}

	commit(
		formStore.models.map((model, modelIndex) => {
			if (modelIndex !== index) {
				return model;
			}

			if (key === 'reasoningBudget') {
				if (isReasoningBudgetTier(value) || value === null) {
					return { ...model, reasoningBudget: value };
				}

				return { ...model, reasoningBudget: null };
			}

			if (key === 'serviceTier') {
				if (value === 'default' || value === 'priority' || value === null) {
					return { ...model, serviceTier: value };
				}

				return { ...model, serviceTier: null };
			}

			return { ...model, [key]: value };
		})
	);
}

async function copyModelId(id: string) {
	if (!id.trim()) {
		return;
	}

	await navigator.clipboard.writeText(id);
	copiedId = id;
	void (async () => {
		await sleep(1500);

		if (copiedId === id) {
			copiedId = null;
		}
	})();
}

function requestDelete(label: string, index: number) {
	confirmDeleteModelLabel = label;
	confirmDeleteIndex = index;
}

function cancelDelete() {
	confirmDeleteModelLabel = null;
	confirmDeleteIndex = null;
}

function showDeleteDialog(dialog: HTMLDialogElement): void {
	dialog.showModal();
}

function confirmDelete() {
	if (confirmDeleteIndex === null) {
		return;
	}

	commit(formStore.models.filter((_, modelIndex) => modelIndex !== confirmDeleteIndex));
	cancelDelete();
}

$effect(() => {
	if (saved) discoveryStore.acknowledgeSaved(selectedProvider);
});
$effect(() => watchDiscoveryError(discoveryState.error, 'error'));

$effect(() => {
	const visible = visibleModels();

	if (visible.length === 0) {
		activeModelIndex = null;

		return;
	}

	const active = visible.find((item) => item.index === activeModelIndex);

	if (!active) {
		const savedModelId = getSavedSettingsModelId(selectedProvider);
		const restored = visible.find((item) => modelSelectionId(item) === savedModelId) ?? visible[0];

		activeModelIndex = restored.index;
		saveActiveModel(restored);
		const restoredFamily = familyForIndex(restored.index);
		if (restoredFamily && expandedFamilyKey === null) expandedFamilyKey = restoredFamily.key;
	}
});
</script>

<div class="ug-panel p-5 space-y-4">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div class="space-y-1">
			<p class="text-sm font-semibold">Models · {getProviderLabel(selectedProvider)}</p>
			<p class="text-xs ug-description"> Use these IDs when adding custom models in Cursor. </p>
		</div>
		<div class="flex flex-wrap items-center gap-2">
			<button
				class="ug-button"
				type="button"
				onclick={() => void discoveryStore.sync(selectedProvider)}
				disabled={discoveryState.loading || restarting}>
				<IconRefreshCw class="size-4 {discoveryState.loading ? 'animate-spin' : ''}" />
				{discoveryState.loading ? 'Syncing' : 'Sync Models'}
			</button>
			<button
				class="ug-button"
				type="button"
				onclick={addModel}>
				Add Model
			</button>
			<button
				class="ug-button ug-primary"
				type="button"
				onclick={onSave}
				disabled={saving || restarting}>
				{saved ? 'Saved' : 'Save'}
			</button>
		</div>
	</div>

	{#if discoveryState.summary}
		<div class="ug-notice p-3 text-sm space-y-1">
			<p>
				{#if discoveryState.usingFallback}
					Using configured fallback · {discoveryState.summary.existing} models kept
				{:else if discoveryState.summary.added > 0}
					{discoveryState.summary.added} added to draft ·
				{:else}
					Catalog is up to date ·
				{/if}
				{discoveryState.summary.existing} already configured
				{#if discoveryReviewCount > 0}
					· {discoveryReviewCount} need review
				{/if}
			</p>
			{#if discoveryState.summary.added > 0}
				<p class="text-xs ug-description">
					{discoveryState.autoSaved ? 'New models were saved automatically.' : 'Review the additions, then save to apply.'}
				</p>
			{/if}
			{#if discoveryState.summary.renamed.length > 0}
				<details class="text-xs ug-description">
					<summary class="cursor-pointer">
						{discoveryState.summary.renamed.length} ID
						{discoveryState.summary.renamed.length === 1 ? 'conflict was' : 'conflicts were'} kept as separate models
					</summary>
					<ul class="mt-1 space-y-1 pl-4">
						{#each discoveryState.summary.renamed as item}
							<li><code>{item.upstreamModel}</code> → <code>{item.id}</code></li>
						{/each}
					</ul>
				</details>
			{/if}
			{#if notListedModelCount > 0}
				<div class="flex flex-wrap items-center justify-between gap-2 pt-1">
					<p class="text-xs ug-description">
						{notListedModelCount} configured {notListedModelCount === 1 ? 'model is' : 'models are'} not listed by the provider.
					</p>
					<button
						class="ug-button ug-danger"
						type="button"
						onclick={() => discoveryStore.removeNotListed(selectedProvider)}>
						<IconTrash2 class="size-4" />
						Remove {notListedModelCount}
					</button>
				</div>
			{:else if discoveryState.removedNotListed.length > 0}
				<div class="flex flex-wrap items-center justify-between gap-2 pt-1">
					<p class="text-xs ug-description">
						{discoveryState.removedNotListed.length} not-listed
						{discoveryState.removedNotListed.length === 1 ? 'model was' : 'models were'} removed from the draft.
					</p>
					<button
						class="ug-button"
						type="button"
						onclick={() => discoveryStore.undoRemoveNotListed(selectedProvider)}>Undo</button>
				</div>
			{/if}
			{#if discoveryState.catalogMessage}
				<p class="text-xs ug-description">{discoveryState.catalogMessage}</p>
			{/if}
		</div>
	{/if}

	<div class="space-y-3">
		{#if modelFamilies.length === 0}
			<div class="ug-panel p-4 text-sm ug-description">
				No models for {getProviderLabel(selectedProvider)}.
			</div>
		{:else}
			<div class="space-y-2">
				{#each modelFamilies as group (group.key)}
					<section class="rounded-md border ug-border">
						<button
							type="button"
							class="flex w-full items-center gap-3 rounded-md px-4 py-3 text-left ug-hover"
							aria-expanded={expandedFamilyKey === group.key}
							aria-controls={`model-family-${group.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`}
							onclick={() => toggleFamily(group)}>
							<span class="min-w-0 flex-1">
								<span class="flex flex-wrap items-center gap-2">
									<span class="text-sm font-semibold">{group.label}</span>
									{#if group.isProviderDefault}
										<span class="rounded-full ug-badge px-2 py-0.5 text-[11px] ug-description"> Provider default </span>
									{/if}
									{#if discoveryStore.isNotListed(selectedProvider, group.upstreamModel)}
										<span class="inline-flex items-center gap-1 text-[11px] ug-warning">
											<span class="inline-block size-1.5 rounded-full ug-warning-dot"></span>
											Not listed
										</span>
									{/if}
								</span>
								<span class="mt-0.5 block text-xs ug-description">
									{reasoningCount(group)} reasoning {reasoningCount(group) === 1 ? 'level' : 'levels'} ·
									{group.supportsFast ? 'Standard / Fast' : 'Standard'} · {variantCount(group)}
									{variantCount(group) === 1 ? 'variant' : 'variants'}
								</span>
								{#if group.description}
									<span class="mt-1 block text-xs ug-description">{group.description}</span>
								{/if}
							</span>
							<IconChevronDown
								class="size-4 shrink-0 transition-transform {expandedFamilyKey === group.key ? 'rotate-180' : ''}" />
						</button>

						{#if expandedFamilyKey === group.key}
							<div
								id={`model-family-${group.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`}
								class="border-t ug-border p-3 sm:p-4">
								<div class="overflow-x-auto rounded-md border ug-border">
									<table class="w-full min-w-[34rem] border-collapse text-left text-xs">
										<thead class="ug-table-heading ug-description">
											<tr>
												<th class="px-3 py-2 font-medium">Reasoning</th>
												<th class="px-3 py-2 font-medium">Standard</th>
												{#if group.supportsFast}<th class="px-3 py-2 font-medium">Fast</th>{/if}
											</tr>
										</thead>
										<tbody>
											{#each group.rows as row}
												<tr class="border-t ug-border">
													<th class="whitespace-nowrap px-3 py-2 font-medium ug-description">{row.label}</th>
													<td class="px-2 py-1.5">
														{#if row.standard.length}
															<div class="space-y-1">
																{#each row.standard as item}
																	<div class="flex items-center gap-1">
																		<button
																			type="button"
																			class="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left font-mono {activeModelIndex ===
																			item.index
																				? 'ug-selection'
																				: 'ug-hover'}"
																			aria-label={`Select ${item.model.id || 'unsaved model'} ${row.label} Standard`}
																			onclick={() => selectVariant(item)}>
																			<span class="block truncate">{item.model.id || 'Unsaved model'}</span>
																			{#if isProviderDefaultVariant(group, item)}
																				<span class="font-sans text-[10px] ug-description">Provider default</span>
																			{/if}
																		</button>
																		<button
																			type="button"
																			class="ug-button px-2"
																			aria-label={`Copy ${item.model.id}`}
																			title={copiedId === item.model.id ? 'Copied' : 'Copy model ID'}
																			disabled={!item.model.id.trim()}
																			onclick={() => void copyModelId(item.model.id)}>
																			{#if copiedId === item.model.id}
																				<IconCheck class="size-3.5" />
																			{:else}
																				<IconCopy class="size-3.5" />
																			{/if}
																		</button>
																	</div>
																{/each}
															</div>
														{:else}
															<span class="px-2 ug-foreground">Not available</span>
														{/if}
													</td>
													{#if group.supportsFast}
														<td class="border-l ug-border px-2 py-1.5">
															{#if row.fast.length}
																<div class="space-y-1">
																	{#each row.fast as item}
																		<div class="flex items-center gap-1">
																			<button
																				type="button"
																				class="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left font-mono {activeModelIndex ===
																				item.index
																					? 'ug-selection'
																					: 'ug-hover'}"
																				aria-label={`Select ${item.model.id || 'unsaved model'} ${row.label} Fast`}
																				onclick={() => selectVariant(item)}>
																				<span class="block truncate">{item.model.id || 'Unsaved model'}</span>
																				{#if isProviderDefaultVariant(group, item)}
																					<span class="font-sans text-[10px] ug-description">Provider default</span>
																				{/if}
																			</button>
																			<button
																				type="button"
																				class="ug-button px-2"
																				aria-label={`Copy ${item.model.id}`}
																				title={copiedId === item.model.id ? 'Copied' : 'Copy model ID'}
																				disabled={!item.model.id.trim()}
																				onclick={() => void copyModelId(item.model.id)}>
																				{#if copiedId === item.model.id}
																					<IconCheck class="size-3.5" />
																				{:else}
																					<IconCopy class="size-3.5" />
																				{/if}
																			</button>
																		</div>
																	{/each}
																</div>
															{:else}
																<span class="px-2 ug-foreground">Not available</span>
															{/if}
														</td>
													{/if}
												</tr>
											{/each}
										</tbody>
									</table>
								</div>

								{#if activeVisibleModel() && familyItems(group).some((item) => item.index === activeModelIndex)}
									{@const activeItem = activeVisibleModel()!}
									{@const model = activeItem.model}
									{@const index = activeItem.index}
									<div
										class="mt-3 space-y-3 rounded-md border ug-border p-3"
										aria-label={`Edit ${modelTitle(activeItem)}`}>
										<div class="flex flex-wrap items-center justify-between gap-2">
											<div>
												<p class="text-sm font-medium">{modelTitle(activeItem)}</p>
												<p class="text-xs ug-description">Selected model</p>
											</div>
											<button
												class="ug-button ug-danger"
												type="button"
												onclick={() => requestDelete(model.id.trim() || model.label.trim() || 'Unsaved model', index)}>
												<IconTrash2 class="size-4" />
												Remove
											</button>
										</div>

										{#if discoveryStore.isNotListed(selectedProvider, model.upstreamModel)}
											<div class="flex items-start gap-2 rounded-md ug-warning-note p-3 text-xs ug-warning">
												<IconTriangleAlert class="mt-0.5 size-4 shrink-0" />
												<span>
													Not listed in the latest provider catalog. It may still work, so Ungate kept this model unchanged.
												</span>
											</div>
										{/if}

										<div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
											<label class="ug-label">
												<span class=" text-xs">Model ID</span>
												<input
													class="ug-input text-sm font-mono"
													type="text"
													value={model.id}
													oninput={(event) => updateModelAtIndex(index, 'id', inputValue(event))}
													placeholder={example.id} />
											</label>
											<label class="ug-label">
												<span class=" text-xs">Label</span>
												<input
													class="ug-input text-sm"
													type="text"
													value={model.label}
													oninput={(event) => updateModelAtIndex(index, 'label', inputValue(event))}
													placeholder={example.label} />
											</label>
											<label class="ug-label md:col-span-2 xl:col-span-1">
												<span class=" text-xs">Upstream Model</span>
												<input
													class="ug-input text-sm font-mono"
													type="text"
													value={model.upstreamModel}
													oninput={(event) => updateModelAtIndex(index, 'upstreamModel', inputValue(event))}
													placeholder={example.upstreamModel} />
											</label>
										</div>

										<details class="rounded-md border ug-border">
											<summary class="cursor-pointer px-3 py-2 text-xs font-medium">Advanced options</summary>
											<div
												class="grid grid-cols-1 gap-4 border-t ug-border p-3 {selectedProvider === 'openai'
													? 'md:grid-cols-2'
													: ''}">
												<label class="ug-label">
													<span class=" text-xs">Reasoning Budget</span>
													<select
														class="ug-select text-sm"
														value={model.reasoningBudget ?? ''}
														onchange={(event) => {
															const value = selectValue(event);
															updateModelAtIndex(index, 'reasoningBudget', value ? value : null);
														}}>
														{#each reasoningOptions as option}
															<option value={option.value ?? ''}>{option.label}</option>
														{/each}
													</select>
												</label>
												{#if selectedProvider === 'openai'}
													<label class="ug-label">
														<span class=" text-xs">Service Tier</span>
														<select
															class="ug-select text-sm"
															value={model.serviceTier ?? ''}
															onchange={(event) => {
																const value = selectValue(event);
																updateModelAtIndex(index, 'serviceTier', value ? value : null);
															}}>
															{#each serviceTierOptions as option}
																<option value={option.value ?? ''}>{option.label}</option>
															{/each}
														</select>
													</label>
												{/if}
											</div>
										</details>
									</div>
								{/if}
							</div>
						{/if}
					</section>
				{/each}
			</div>
		{/if}
	</div>
</div>

{#if confirmDeleteModelLabel}
	<dialog
		class="ug-dialog space-y-4"
		aria-labelledby="remove-model-title"
		aria-describedby="remove-model-description remove-model-hint"
		use:showDeleteDialog
		oncancel={cancelDelete}>
		<p
			id="remove-model-title"
			class="text-sm font-semibold">Remove model</p>
		<p
			id="remove-model-description"
			class="text-sm ug-description">
			Remove <strong>{confirmDeleteModelLabel}</strong> from Ungate?
		</p>
		<p
			id="remove-model-hint"
			class="text-xs ug-description">The deletion takes effect after you save the model list.</p>
		<div class="flex justify-end gap-2">
			<button
				class="ug-button"
				type="button"
				onclick={cancelDelete}>
				Cancel
			</button>
			<button
				class="ug-button ug-danger"
				type="button"
				disabled={confirmDeleteIndex === null}
				onclick={confirmDelete}>
				<IconTrash2 class="size-4" />
				Remove
			</button>
		</div>
	</dialog>
{/if}
