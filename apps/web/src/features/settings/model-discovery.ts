import { REASONING_BUDGET_TIERS } from '@ungate/shared/frontend';

import type {
	DiscoveredModel,
	ModelDiscoveryResponse,
	ModelMappingConfig,
	ModelMappingProvider,
	ModelServiceTier,
	ReasoningBudgetTier
} from '@ungate/shared/frontend';

export interface ModelReconciliation {
	models: ModelMappingConfig[];
	added: number;
	existing: number;
	renamed: { upstreamModel: string; id: string }[];
	notListedUpstreamModels: string[];
}

export interface RemovedModel {
	model: ModelMappingConfig;
	index: number;
}

export interface GroupedModelItem {
	model: ModelMappingConfig;
	index: number;
}

export interface ModelVariantRow {
	reasoningBudget: ReasoningBudgetTier | null;
	label: string;
	standard: GroupedModelItem[];
	fast: GroupedModelItem[];
}

export interface ModelFamilyGroup {
	key: string;
	upstreamModel: string;
	label: string;
	description: string | null;
	isProviderDefault: boolean;
	defaultReasoningLevel: ReasoningBudgetTier | null;
	defaultServiceTier: ModelServiceTier | null;
	supportsFast: boolean;
	rows: ModelVariantRow[];
}

function normalized(value: string): string {
	return value.trim().toLocaleLowerCase();
}

function uniqueId(base: string, provider: ModelMappingProvider, usedIds: Set<string>): string {
	if (!usedIds.has(normalized(base))) return base;
	const providerId = `${base}-${provider}`;
	if (!usedIds.has(normalized(providerId))) return providerId;

	let suffix = 2;
	while (usedIds.has(normalized(`${providerId}-${suffix}`))) suffix++;

	return `${providerId}-${suffix}`;
}

function validRemoteModels(models: DiscoveredModel[]): DiscoveredModel[] {
	const unique = new Map<string, DiscoveredModel>();
	for (const item of models) {
		const upstream = normalized(item.upstreamModel);
		if (!upstream || unique.has(upstream)) continue;
		unique.set(upstream, item);
	}

	return [...unique.values()];
}

const reasoningLabels: Record<ReasoningBudgetTier, string> = {
	none: 'None',
	minimal: 'Minimal',
	low: 'Low',
	medium: 'Medium',
	high: 'High',
	xhigh: 'Extra High',
	max: 'Max',
	ultra: 'Ultra',
	persistent: 'Persistent'
};

function candidateId(item: DiscoveredModel, tier: ReasoningBudgetTier | null, serviceTier: ModelServiceTier | null): string {
	const base = item.id.trim() || item.upstreamModel.trim();
	const reasoningId = tier && !normalized(base).endsWith(`-${tier}`) ? `${base}-${tier}` : base;

	return serviceTier === 'priority' && !normalized(reasoningId).endsWith('-fast') ? `${reasoningId}-fast` : reasoningId;
}

function isStandardServiceTier(tier: ModelServiceTier | null): boolean {
	return tier === null || tier === 'default';
}

function mappingExists(
	models: ModelMappingConfig[],
	provider: ModelMappingProvider,
	upstreamModel: string,
	tier: ReasoningBudgetTier | null,
	serviceTier: ModelServiceTier | null,
	matchAnyReasoning: boolean
): boolean {
	return models.some(
		(model) =>
			model.provider === provider &&
			normalized(model.upstreamModel) === normalized(upstreamModel) &&
			(matchAnyReasoning || model.reasoningBudget === tier) &&
			(serviceTier === 'priority' ? model.serviceTier === 'priority' : isStandardServiceTier(model.serviceTier))
	);
}

export function reconcileDiscoveredModels(current: ModelMappingConfig[], response: ModelDiscoveryResponse): ModelReconciliation {
	const remoteModels = validRemoteModels(response.models);
	const remoteUpstreams = new Set(remoteModels.map((item) => normalized(item.upstreamModel)));
	const usedIds = new Set(current.map((item) => normalized(item.id)).filter(Boolean));
	const next = [...current];
	const renamed: { upstreamModel: string; id: string }[] = [];
	let added = 0;
	let existing = 0;

	for (const item of remoteModels) {
		const hasReasoningMetadata = !!item.reasoningLevels?.length;
		const tiers: (ReasoningBudgetTier | null)[] = hasReasoningMetadata ? item.reasoningLevels! : [null];
		const serviceTiers: (ModelServiceTier | null)[] = [null, ...(item.serviceTiers ?? []).filter((tier) => tier === 'priority')];
		for (const tier of tiers) {
			for (const serviceTier of serviceTiers) {
				if (mappingExists(next, response.provider, item.upstreamModel, tier, serviceTier, !hasReasoningMetadata)) {
					existing++;
					continue;
				}

				const requestedId = candidateId(item, tier, serviceTier);
				const id = uniqueId(requestedId, response.provider, usedIds);
				if (id !== requestedId) renamed.push({ upstreamModel: item.upstreamModel.trim(), id });
				const baseLabel = item.label.trim() || item.upstreamModel.trim();
				const reasoningLabel = tier ? ` ${reasoningLabels[tier]}` : '';
				const serviceLabel = serviceTier === 'priority' ? ' Fast' : '';
				next.push({
					id,
					label: `${baseLabel}${reasoningLabel}${serviceLabel}`,
					provider: response.provider,
					upstreamModel: item.upstreamModel.trim(),
					sortOrder: next.length,
					reasoningBudget: tier,
					serviceTier
				});
				usedIds.add(normalized(id));
				added++;
			}
		}
	}

	const notListedUpstreamModels = response.catalogComplete
		? [
				...new Set(
					current
						.filter(
							(item) =>
								item.provider === response.provider &&
								item.upstreamModel.trim() &&
								!remoteUpstreams.has(normalized(item.upstreamModel))
						)
						.map((item) => item.upstreamModel)
				)
			]
		: [];

	return { models: next, added, existing, renamed, notListedUpstreamModels };
}

export function groupModelFamilies(
	models: ModelMappingConfig[],
	provider: ModelMappingProvider,
	catalog: DiscoveredModel[] = []
): ModelFamilyGroup[] {
	const catalogByUpstream = new Map(catalog.map((item) => [normalized(item.upstreamModel), item]));
	const groups = new Map<string, { upstreamModel: string; items: GroupedModelItem[]; order: number }>();

	models.forEach((model, index) => {
		if (model.provider !== provider) return;
		const upstream = model.upstreamModel.trim();
		const key = upstream ? normalized(upstream) : `#row-${index}`;
		const existing = groups.get(key);
		if (existing) existing.items.push({ model, index });
		else groups.set(key, { upstreamModel: upstream, items: [{ model, index }], order: groups.size });
	});

	return [...groups.entries()]
		.map(([key, group]): ModelFamilyGroup & { order: number; priority: number } => {
			const catalogItem = catalogByUpstream.get(key);
			const reasoning = new Set(group.items.map((item) => item.model.reasoningBudget));
			const advertisedReasoning = catalogItem?.reasoningLevels ?? [];
			for (const tier of advertisedReasoning) reasoning.add(tier);
			if (!reasoning.size) reasoning.add(null);
			const orderedReasoning = [
				...(reasoning.has(null) ? [null] : []),
				...REASONING_BUDGET_TIERS.filter((tier) => reasoning.has(tier))
			] as (ReasoningBudgetTier | null)[];
			const supportsFast =
				catalogItem?.serviceTiers?.includes('priority') === true ||
				group.items.some((item) => item.model.serviceTier === 'priority');
			const rows = orderedReasoning.map((tier): ModelVariantRow => {
				const matching = group.items.filter((item) => item.model.reasoningBudget === tier);

				return {
					reasoningBudget: tier,
					label: tier ? reasoningLabels[tier] : 'Default',
					standard: matching.filter((item) => isStandardServiceTier(item.model.serviceTier)),
					fast: matching.filter((item) => item.model.serviceTier === 'priority')
				};
			});
			const fallback = group.items[0]?.model;

			return {
				key,
				upstreamModel: group.upstreamModel,
				label:
					catalogItem?.label.trim() ||
					group.upstreamModel ||
					fallback?.label.trim() ||
					fallback?.id.trim() ||
					`Model ${group.items[0]?.index ?? group.order + 1}`,
				description: catalogItem?.description?.trim() || null,
				isProviderDefault: catalogItem?.isProviderDefault === true,
				defaultReasoningLevel: catalogItem?.defaultReasoningLevel ?? null,
				defaultServiceTier: catalogItem?.defaultServiceTier ?? null,
				supportsFast,
				rows,
				order: group.order,
				priority: catalogItem?.priority ?? Number.MAX_SAFE_INTEGER
			};
		})
		.sort((left, right) => left.priority - right.priority || left.order - right.order)
		.map(({ order: _order, priority: _priority, ...group }) => group);
}

export function removeNotListedModels(
	current: ModelMappingConfig[],
	provider: ModelMappingProvider,
	notListedUpstreamModels: string[]
): { models: ModelMappingConfig[]; removed: RemovedModel[] } {
	const targets = new Set(notListedUpstreamModels.map(normalized));
	const removed: RemovedModel[] = [];
	const models = current.filter((model, index) => {
		const shouldRemove = model.provider === provider && targets.has(normalized(model.upstreamModel));
		if (shouldRemove) removed.push({ model, index });

		return !shouldRemove;
	});

	return { models, removed };
}

export function restoreRemovedModels(current: ModelMappingConfig[], removed: RemovedModel[]): ModelMappingConfig[] {
	const models = [...current];
	const usedIds = new Set(models.map((model) => normalized(model.id)));

	for (const item of [...removed].sort((left, right) => left.index - right.index)) {
		if (usedIds.has(normalized(item.model.id))) continue;
		models.splice(Math.min(item.index, models.length), 0, item.model);
		usedIds.add(normalized(item.model.id));
	}

	return models;
}
