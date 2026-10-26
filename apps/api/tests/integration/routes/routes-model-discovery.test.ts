import { afterEach, describe, expect, it, vi } from 'vitest';

import { ModelMappings } from 'src/database/model-mappings';
import { ProviderSettings } from 'src/database/provider-settings';
import { protectAdministration } from 'src/plugins/administration';
import modelDiscoveryPlugin from 'src/routes/model-discovery';

import { createTestApp } from '../test-harness';

afterEach(() => {
	vi.unstubAllGlobals();
});

async function createApp() {
	const app = createTestApp();
	protectAdministration(app, 'admin');
	await app.register(modelDiscoveryPlugin);

	return app;
}

describe('model discovery boundary and provider catalogs', () => {
	it('requires the admin capability and validates the provider', async () => {
		const app = await createApp();
		try {
			expect((await app.inject({ method: 'POST', url: '/models/discover', payload: { provider: 'claude' } })).statusCode).toBe(
				403
			);
			expect(
				(
					await app.inject({
						method: 'POST',
						url: '/models/discover',
						headers: { authorization: 'Bearer admin' },
						payload: { provider: 'other' }
					})
				).statusCode
			).toBe(400);
		} finally {
			await app.close();
		}
	});

	it('reads and caches the account-scoped Codex catalog without changing mappings', async () => {
		ProviderSettings.upsertOAuth('openai', {
			accessToken: 'openai-secret',
			refreshToken: 'refresh',
			expiresAt: Date.now() + 60 * 60_000,
			accountId: 'account-1'
		});
		ModelMappings.replace([
			{
				id: 'custom',
				label: 'Custom',
				provider: 'openai',
				upstreamModel: 'custom-upstream',
				sortOrder: 0,
				reasoningBudget: null,
				serviceTier: null
			}
		]);
		const fetcher = vi.fn().mockResolvedValue(
			Response.json({
				models: [
					{
						slug: 'gpt-visible',
						display_name: 'GPT Visible',
						description: 'Balanced coding model',
						visibility: 'list',
						priority: 2,
						default_reasoning_level: 'medium',
						default_service_tier: 'priority',
						service_tiers: [
							{ id: 'priority', name: 'Fast', description: '2x speed' },
							{ id: 'unknown', name: 'Unknown' }
						],
						additional_speed_tiers: ['fast'],
						supported_reasoning_levels: [
							{ effort: 'low', description: 'Fast' },
							{ effort: 'medium', description: 'Balanced' },
							{ effort: 'xhigh', description: 'Deep' },
							{ effort: 'max', description: 'Maximum' }
						]
					},
					{
						slug: 'gpt-preferred',
						display_name: 'GPT Preferred',
						visibility: 'list',
						priority: 1,
						additional_speed_tiers: ['fast']
					},
					{ slug: 'gpt-hidden', display_name: 'GPT Hidden', visibility: 'hide' }
				]
			})
		);
		vi.stubGlobal('fetch', fetcher);
		const app = await createApp();
		try {
			const request = {
				method: 'POST' as const,
				url: '/models/discover',
				headers: { authorization: 'Bearer admin' },
				payload: { provider: 'openai' }
			};
			const first = await app.inject(request);
			const second = await app.inject(request);
			expect(first.statusCode).toBe(200);
			expect(first.json()).toMatchObject({
				status: 'ok',
				catalogComplete: true,
				models: [
					{
						id: 'gpt-preferred',
						label: 'GPT Preferred',
						upstreamModel: 'gpt-preferred',
						priority: 1,
						isProviderDefault: true,
						serviceTiers: ['priority']
					},
					{
						id: 'gpt-visible',
						label: 'GPT Visible',
						upstreamModel: 'gpt-visible',
						description: 'Balanced coding model',
						priority: 2,
						defaultReasoningLevel: 'medium',
						reasoningLevels: ['low', 'medium', 'xhigh', 'max'],
						serviceTiers: ['priority'],
						defaultServiceTier: 'priority'
					}
				]
			});
			expect(second.json()).toEqual(first.json());
			expect(fetcher).toHaveBeenCalledTimes(1);
			expect(fetcher.mock.calls[0]?.[0].toString()).toContain('/backend-api/codex/models?client_version=');
			expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
				Authorization: 'Bearer openai-secret',
				'ChatGPT-Account-ID': 'account-1'
			});
			expect(ModelMappings.list()).toHaveLength(1);
		} finally {
			await app.close();
		}
	});

	it('paginates Claude and normalizes display names', async () => {
		ProviderSettings.upsertOAuth('claude', {
			accessToken: 'claude-secret',
			refreshToken: 'refresh',
			expiresAt: Date.now() + 60 * 60_000
		});
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({ data: [{ id: 'claude-a', display_name: 'Claude A' }], has_more: true, last_id: 'claude-a' })
			)
			.mockResolvedValueOnce(Response.json({ data: [{ id: 'claude-b', display_name: 'Claude B' }], has_more: false }));
		vi.stubGlobal('fetch', fetcher);
		const app = await createApp();
		try {
			const response = await app.inject({
				method: 'POST',
				url: '/models/discover',
				headers: { authorization: 'Bearer admin' },
				payload: { provider: 'claude' }
			});
			expect(response.json()).toMatchObject({
				status: 'ok',
				models: [
					{ upstreamModel: 'claude-a', label: 'Claude A' },
					{ upstreamModel: 'claude-b', label: 'Claude B' }
				]
			});
			expect(fetcher.mock.calls[1]?.[0].toString()).toContain('after_id=claude-a');
		} finally {
			await app.close();
		}
	});

	it('allows only verified MiniMax regions and parses the OpenAI-shaped catalog', async () => {
		ProviderSettings.upsertApiKey('minimax', 'minimax-secret', 'https://example.com');
		const fetcher = vi.fn();
		vi.stubGlobal('fetch', fetcher);
		let app = await createApp();
		const unsupported = await app.inject({
			method: 'POST',
			url: '/models/discover',
			headers: { authorization: 'Bearer admin' },
			payload: { provider: 'minimax' }
		});
		expect(unsupported.json()).toMatchObject({ status: 'unsupported', catalogComplete: false });
		expect(fetcher).not.toHaveBeenCalled();
		await app.close();

		ProviderSettings.upsertApiKey('minimax', 'minimax-secret', 'https://api.minimax.io');
		fetcher.mockResolvedValueOnce(Response.json({ object: 'list', data: [{ id: 'MiniMax-M3', owned_by: 'minimax' }] }));
		app = await createApp();
		try {
			const response = await app.inject({
				method: 'POST',
				url: '/models/discover',
				headers: { authorization: 'Bearer admin' },
				payload: { provider: 'minimax' }
			});
			expect(response.json()).toMatchObject({
				status: 'ok',
				models: [{ id: 'MiniMax-M3', label: 'MiniMax-M3', upstreamModel: 'MiniMax-M3' }]
			});
			expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.minimax.io/v1/models');
		} finally {
			await app.close();
		}
	});

	it('fails closed on rejected, malformed and oversized provider responses without exposing credentials', async () => {
		ProviderSettings.upsertApiKey('minimax', 'private-model-key', 'https://api.minimax.io');
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(new Response('', { status: 403 }))
			.mockResolvedValueOnce(Response.json({ unexpected: [] }))
			.mockResolvedValueOnce(new Response('x'.repeat(1024 * 1024 + 1)));
		vi.stubGlobal('fetch', fetcher);
		const app = await createApp();
		const request = {
			method: 'POST' as const,
			url: '/models/discover',
			headers: { authorization: 'Bearer admin' },
			payload: { provider: 'minimax' }
		};
		try {
			const rejected = await app.inject(request);
			expect(rejected.json()).toMatchObject({ status: 'unsupported', catalogComplete: false });
			const malformed = await app.inject(request);
			expect(malformed.json()).toMatchObject({ status: 'error', catalogComplete: false });
			const oversized = await app.inject(request);
			expect(oversized.json()).toMatchObject({ status: 'error', catalogComplete: false });
			expect(`${rejected.body}${malformed.body}${oversized.body}`).not.toContain('private-model-key');
		} finally {
			await app.close();
		}
	});
});
