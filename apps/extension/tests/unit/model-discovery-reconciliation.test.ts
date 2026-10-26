import { describe, expect, it } from 'vitest';

import {
	groupModelFamilies,
	reconcileDiscoveredModels,
	removeNotListedModels,
	restoreRemovedModels
} from '../../../web/src/features/settings/model-discovery';

import type { ModelDiscoveryResponse, ModelMappingConfig } from '@ungate/shared';

const configured: ModelMappingConfig[] = [
	{
		id: 'my-sonnet',
		label: 'My Sonnet',
		provider: 'claude',
		upstreamModel: 'claude-sonnet-4-6',
		sortOrder: 0,
		reasoningBudget: 'high',
		serviceTier: null
	},
	{
		id: 'gpt-new',
		label: 'Custom collision',
		provider: 'minimax',
		upstreamModel: 'MiniMax-M3',
		sortOrder: 1,
		reasoningBudget: null,
		serviceTier: null
	},
	{
		id: 'legacy',
		label: 'Legacy',
		provider: 'claude',
		upstreamModel: 'claude-legacy',
		sortOrder: 2,
		reasoningBudget: null,
		serviceTier: null
	}
];

const response: ModelDiscoveryResponse = {
	provider: 'claude',
	status: 'ok',
	message: null,
	catalogComplete: true,
	fetchedAt: '2026-10-24T00:00:00.000Z',
	models: [
		{ id: 'sonnet-default', label: 'Provider Sonnet', upstreamModel: 'claude-sonnet-4-6' },
		{ id: 'gpt-new', label: 'GPT New', upstreamModel: 'gpt-new' }
	]
};

describe('model discovery reconciliation', () => {
	it('preserves custom rows, keeps both ID collisions and identifies models not listed by the provider', () => {
		const result = reconcileDiscoveredModels(configured, response);
		expect(result.added).toBe(1);
		expect(result.existing).toBe(1);
		expect(result.renamed).toEqual([{ upstreamModel: 'gpt-new', id: 'gpt-new-claude' }]);
		expect(result.notListedUpstreamModels).toEqual(['claude-legacy']);
		expect(result.models[0]).toEqual(configured[0]);
		expect(result.models[3]).toMatchObject({
			id: 'gpt-new-claude',
			label: 'GPT New',
			provider: 'claude',
			upstreamModel: 'gpt-new',
			reasoningBudget: null,
			serviceTier: null
		});
	});

	it('is idempotent and does not report absence from a truncated catalog', () => {
		const first = reconcileDiscoveredModels(configured, response);
		const second = reconcileDiscoveredModels(first.models, { ...response, catalogComplete: false });
		expect(second.added).toBe(0);
		expect(second.models).toEqual(first.models);
		expect(second.notListedUpstreamModels).toEqual([]);
	});

	it('bulk-removes only reviewed provider rows and restores them at their previous positions', () => {
		const removed = removeNotListedModels(configured, 'claude', ['claude-legacy']);
		expect(removed.models.map((model) => model.id)).toEqual(['my-sonnet', 'gpt-new']);
		expect(removed.removed).toHaveLength(1);
		expect(restoreRemovedModels(removed.models, removed.removed)).toEqual(configured);
	});

	it('adds every advertised Codex reasoning level without duplicating an existing tier', () => {
		const current: ModelMappingConfig[] = [
			{
				id: 'gpt-next-medium',
				label: 'GPT Next Medium',
				provider: 'openai',
				upstreamModel: 'gpt-next',
				sortOrder: 0,
				reasoningBudget: 'medium',
				serviceTier: 'default'
			}
		];
		const result = reconcileDiscoveredModels(current, {
			provider: 'openai',
			status: 'ok',
			message: null,
			catalogComplete: true,
			fetchedAt: '2026-10-24T00:00:00.000Z',
			models: [
				{
					id: 'gpt-next',
					label: 'GPT Next',
					upstreamModel: 'gpt-next',
					reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max']
				}
			]
		});
		expect(result.existing).toBe(1);
		expect(result.added).toBe(4);
		expect(result.models.map((model) => model.id)).toEqual([
			'gpt-next-medium',
			'gpt-next-low',
			'gpt-next-high',
			'gpt-next-xhigh',
			'gpt-next-max'
		]);
		expect(result.models.at(-2)?.label).toBe('GPT Next Extra High');
	});

	it('creates only advertised Standard/Fast combinations with deterministic IDs and remains idempotent', () => {
		const discovery: ModelDiscoveryResponse = {
			provider: 'openai',
			status: 'ok',
			message: null,
			catalogComplete: true,
			fetchedAt: '2026-10-24T00:00:00.000Z',
			models: [
				{
					id: 'gpt-fast',
					label: 'GPT Fast',
					upstreamModel: 'gpt-fast',
					reasoningLevels: ['low', 'high'],
					defaultReasoningLevel: 'high',
					serviceTiers: ['priority'],
					defaultServiceTier: 'priority',
					isProviderDefault: true,
					priority: 1
				}
			]
		};
		const first = reconcileDiscoveredModels([], discovery);
		expect(first.models.map((model) => [model.id, model.reasoningBudget, model.serviceTier])).toEqual([
			['gpt-fast-low', 'low', null],
			['gpt-fast-low-fast', 'low', 'priority'],
			['gpt-fast-high', 'high', null],
			['gpt-fast-high-fast', 'high', 'priority']
		]);
		const second = reconcileDiscoveredModels(first.models, discovery);
		expect(second.added).toBe(0);
		expect(second.existing).toBe(4);
		expect(second.models).toEqual(first.models);
	});

	it('groups flat variants into provider-agnostic matrices without hiding custom or unsupported cells', () => {
		const models: ModelMappingConfig[] = [
			{
				id: 'gpt-family-low',
				label: 'GPT Family Low',
				provider: 'openai',
				upstreamModel: 'gpt-family',
				sortOrder: 0,
				reasoningBudget: 'low',
				serviceTier: null
			},
			{
				id: 'gpt-family-high-fast',
				label: 'GPT Family High Fast',
				provider: 'openai',
				upstreamModel: 'gpt-family',
				sortOrder: 1,
				reasoningBudget: 'high',
				serviceTier: 'priority'
			},
			{
				id: 'claude-custom',
				label: 'Custom Claude',
				provider: 'claude',
				upstreamModel: 'claude-custom',
				sortOrder: 2,
				reasoningBudget: null,
				serviceTier: null
			},
			{
				id: 'minimax-custom',
				label: 'Custom MiniMax',
				provider: 'minimax',
				upstreamModel: 'minimax-custom',
				sortOrder: 3,
				reasoningBudget: null,
				serviceTier: null
			}
		];
		const openai = groupModelFamilies(models, 'openai', [
			{
				id: 'gpt-family',
				label: 'GPT Family',
				upstreamModel: 'gpt-family',
				description: 'Provider description',
				priority: 1,
				isProviderDefault: true,
				reasoningLevels: ['low', 'high'],
				defaultReasoningLevel: 'high',
				serviceTiers: ['priority']
			}
		]);
		expect(openai).toHaveLength(1);
		expect(openai[0]).toMatchObject({
			label: 'GPT Family',
			description: 'Provider description',
			isProviderDefault: true,
			supportsFast: true
		});
		expect(openai[0]?.rows.map((row) => [row.label, row.standard.length, row.fast.length])).toEqual([
			['Low', 1, 0],
			['High', 0, 1]
		]);
		expect(groupModelFamilies(models, 'claude')[0]?.rows[0]?.standard[0]?.model.id).toBe('claude-custom');
		expect(groupModelFamilies(models, 'minimax')[0]?.rows[0]?.standard[0]?.model.id).toBe('minimax-custom');
	});
});
