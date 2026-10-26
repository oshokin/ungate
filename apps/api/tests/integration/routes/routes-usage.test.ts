import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProviderSettings } from 'src/database/provider-settings';
import { SubscriptionUsageService } from 'src/usage/subscription-usage';
import usagePlugin from 'src/routes/usage';
import { protectAdministration } from 'src/plugins/administration';

import { createTestApp } from '../test-harness';

afterEach(() => {
	vi.unstubAllGlobals();
});
describe('subscription usage boundary and provider access', () => {
	it('requires admin capability and returns disconnected accounts without network calls', async () => {
		const fetcher = vi.fn();
		vi.stubGlobal('fetch', fetcher);
		const app = createTestApp();
		protectAdministration(app, 'admin');
		await app.register(usagePlugin);
		try {
			expect((await app.inject('/usage')).statusCode).toBe(403);
			const response = await app.inject({ url: '/usage', headers: { authorization: 'Bearer admin' } });
			expect(response.statusCode).toBe(200);
			expect(response.json().providers.every((p: { status: string }) => p.status === 'not_connected')).toBe(true);
			expect(fetcher).not.toHaveBeenCalled();
		} finally {
			await app.close();
		}
	});
	it('uses the existing key once for concurrent reads, caches and refreshes', async () => {
		ProviderSettings.upsertApiKey('minimax', 'test-secret', 'https://api.minimax.io/v1');
		const fetcher = vi
			.fn()
			.mockImplementation(() =>
				Promise.resolve(Response.json({ model_remains: [{ model_name: 'MiniMax', current_interval_remaining_percent: 90 }] }))
			);
		vi.stubGlobal('fetch', fetcher);
		const service = new SubscriptionUsageService();
		const [a, b] = await Promise.all([service.read(), service.read()]);
		expect(a).toEqual(b);
		expect(fetcher).toHaveBeenCalledTimes(1);
		await service.read();
		expect(fetcher).toHaveBeenCalledTimes(1);
		await service.read(true);
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(a)).not.toContain('test-secret');
	});
	it('shows rejected credentials as unsupported and retains old data as stale after a later error', async () => {
		ProviderSettings.upsertApiKey('minimax', 'test-secret', 'https://api.minimax.io/v1');
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(Response.json({ model_remains: [{ model_name: 'M', current_interval_remaining_percent: 50 }] }))
			.mockResolvedValueOnce(new Response('', { status: 403 }));
		vi.stubGlobal('fetch', fetcher);
		const service = new SubscriptionUsageService();
		await service.read();
		const result = await service.read(true);
		const row = result.providers.find((p) => p.provider === 'minimax');
		expect(row).toMatchObject({ status: 'unsupported', stale: true });
		expect(row?.windows[0].usedPercent).toBe(50);
	});
	it('does not send keys to another region, custom endpoint or redirect', async () => {
		ProviderSettings.upsertApiKey('minimax', 'private', 'https://example.org/v1');
		const fetcher = vi.fn();
		vi.stubGlobal('fetch', fetcher);
		const response = await new SubscriptionUsageService().read();
		expect(response.providers.find((p) => p.provider === 'minimax')?.status).toBe('unsupported');
		expect(fetcher).not.toHaveBeenCalled();
	});
});
