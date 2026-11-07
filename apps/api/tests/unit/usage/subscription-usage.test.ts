/* eslint-disable @typescript-eslint/unbound-method -- These methods are replaced with vi.fn mocks above. */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('src/database/provider-settings', () => ({ ProviderSettings: { get: vi.fn() } }));
vi.mock('src/auth/oauth', () => ({ OAuth: { getValidToken: vi.fn() } }));
vi.mock('src/auth/openai', () => ({ OpenAIOAuthService: { getValidToken: vi.fn() } }));

import { OAuth } from 'src/auth/oauth';
import { ProviderSettings } from 'src/database/provider-settings';
import { SubscriptionUsageService } from 'src/usage/subscription-usage';

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('account-bound usage snapshots', () => {
	it.each(['success', 'logout', 'replacement'] as const)('handles token refresh followed by %s', async (change) => {
		let credentials = { accessToken: 'old-secret', accountId: 'account' } as ReturnType<typeof ProviderSettings.get>;
		vi.mocked(ProviderSettings.get).mockImplementation((provider) => (provider === 'claude' ? credentials : undefined));
		vi.mocked(OAuth.getValidToken).mockImplementation(() => {
			credentials = { ...credentials!, accessToken: 'refreshed-secret' };

			return Promise.resolve({
				accessToken: credentials.accessToken,
				refreshToken: 'refresh-secret',
				expiresAt: Date.now() + 3600_000,
				isExpired: false
			});
		});
		const fetcher = vi.fn(() => {
			if (change === 'logout') credentials = undefined;
			if (change === 'replacement') credentials = { ...credentials!, accessToken: 'other-secret', accountId: 'other' };

			return Promise.resolve(Response.json({ five_hour: { utilization: 20 } }));
		});
		vi.stubGlobal('fetch', fetcher);
		const service = new SubscriptionUsageService();
		const result = await service.read(true);
		expect(result.providers[0].windows).toHaveLength(change === 'success' ? 1 : 0);
		const cached = await service.read();
		expect(cached.providers[0].windows).toHaveLength(change === 'success' ? 1 : 0);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(result)).not.toContain('secret');
	});

	it('leaves cache-only age policy to the extension without fetching', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-11-07T12:00:00Z'));
		vi.mocked(ProviderSettings.get).mockImplementation((provider) =>
			provider === 'minimax'
				? ({ accessToken: 'secret', baseUrl: 'https://api.minimax.io/v1' } as ReturnType<typeof ProviderSettings.get>)
				: undefined
		);
		const fetcher = vi.fn(() =>
			Promise.resolve(Response.json({ model_remains: [{ model_name: 'M', current_interval_remaining_percent: 90 }] }))
		);
		vi.stubGlobal('fetch', fetcher);
		const service = new SubscriptionUsageService();
		await service.read(true);
		vi.advanceTimersByTime(60_000);
		const old = await service.read();
		expect(old.providers[2].stale).toBe(false);
		vi.setSystemTime(new Date('2026-11-07T11:00:00Z'));
		const rollback = await service.read();
		expect(rollback.providers[2].stale).toBe(false);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
});
