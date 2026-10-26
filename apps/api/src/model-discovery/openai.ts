import {
	isModelServiceTier,
	isReasoningBudgetTier,
	UNGATE_VERSION,
	type DiscoveredModel,
	type ModelServiceTier,
	type ReasoningBudgetTier
} from '@ungate/shared';

import { config } from '../config';

import { MAX_MODELS, REQUEST_TIMEOUT_MS, model, readJson, uniqueModels, type ProviderCatalog } from './common';

interface CodexCatalog {
	models?: unknown;
}

function reasoningLevels(value: unknown): ReasoningBudgetTier[] {
	if (!Array.isArray(value)) return [];
	const levels: ReasoningBudgetTier[] = [];
	for (const item of value) {
		const effort = item && typeof item === 'object' ? (item as Record<string, unknown>).effort : item;
		if (isReasoningBudgetTier(effort) && !levels.includes(effort)) levels.push(effort);
	}

	return levels;
}

function serviceTiers(item: Record<string, unknown>): ModelServiceTier[] {
	const tiers: ModelServiceTier[] = [];
	const advertised = Array.isArray(item.service_tiers) ? item.service_tiers : [];
	for (const entry of advertised) {
		const id = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).id : entry;
		if (isModelServiceTier(id) && id !== 'default' && !tiers.includes(id)) tiers.push(id);
	}
	if (Array.isArray(item.additional_speed_tiers) && item.additional_speed_tiers.includes('fast') && !tiers.includes('priority')) {
		tiers.push('priority');
	}

	return tiers;
}

function discoveredModel(item: Record<string, unknown>): DiscoveredModel | null {
	const base = model(item.slug, item.display_name);
	if (!base) return null;
	const levels = reasoningLevels(item.supported_reasoning_levels);
	const defaultLevel = isReasoningBudgetTier(item.default_reasoning_level) ? item.default_reasoning_level : null;
	const tiers = serviceTiers(item);
	const defaultTier = isModelServiceTier(item.default_service_tier) ? item.default_service_tier : null;
	const description = typeof item.description === 'string' && item.description.trim() ? item.description.trim() : null;
	const priority = typeof item.priority === 'number' && Number.isSafeInteger(item.priority) ? item.priority : null;

	return {
		...base,
		...(description ? { description } : {}),
		...(priority !== null ? { priority } : {}),
		...(levels.length ? { reasoningLevels: levels } : {}),
		...(defaultLevel ? { defaultReasoningLevel: defaultLevel } : {}),
		...(tiers.length ? { serviceTiers: tiers } : {}),
		...(defaultTier ? { defaultServiceTier: defaultTier } : {})
	};
}

export async function discoverOpenAiModels(accessToken: string, accountId: string): Promise<ProviderCatalog> {
	const url = new URL(`${config.openai.codexUrl}/models`);
	url.searchParams.set('client_version', UNGATE_VERSION);
	const response = await fetch(url, {
		method: 'GET',
		redirect: 'error',
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		headers: {
			Accept: 'application/json',
			Authorization: `Bearer ${accessToken}`,
			'ChatGPT-Account-ID': accountId,
			'User-Agent': `ungate/${UNGATE_VERSION}`
		}
	});
	const rawPayload = await readJson(response);
	const payload = rawPayload as CodexCatalog;
	if (!Array.isArray(payload.models)) throw new Error('ChatGPT returned an unrecognized model catalog');
	const rows = payload.models.filter(
		(item): item is Record<string, unknown> =>
			!!item && typeof item === 'object' && (item as Record<string, unknown>).visibility === 'list'
	);
	const models = uniqueModels(rows.map(discoveredModel).filter((item) => item !== null)).sort(
		(left, right) => (left.priority ?? Number.MAX_SAFE_INTEGER) - (right.priority ?? Number.MAX_SAFE_INTEGER)
	);
	const providerDefaultIndex = models.findIndex((item) => item.priority !== undefined);
	if (providerDefaultIndex >= 0) models[providerDefaultIndex] = { ...models[providerDefaultIndex], isProviderDefault: true };

	return { models, catalogComplete: rows.length <= MAX_MODELS };
}
