import { afterEach, describe, expect, it, vi } from 'vitest';

import { OAuth } from 'src/auth/oauth';
import { OpenAIOAuthService } from 'src/auth/openai';
import { ProviderSettings } from 'src/database/provider-settings';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('refresh ownership and concurrency', () => {
	it.each(['claude', 'openai'] as const)('shares one %s refresh and preserves account metadata', async (provider) => {
		ProviderSettings.upsertOAuth(provider, {
			accessToken: 'old',
			refreshToken: 'refresh',
			expiresAt: 1,
			email: 'account@example.org',
			accountId: 'account'
		});
		const fetcher = vi.fn().mockImplementation(async () => Response.json({ access_token: 'new', expires_in: 3600 }));
		vi.stubGlobal('fetch', fetcher);
		const service = provider === 'claude' ? OAuth : OpenAIOAuthService;
		const [first, second] = await Promise.all([service.getValidToken(), service.getValidToken()]);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(first?.accessToken).toBe('new');
		expect(second?.accessToken).toBe('new');
		expect(ProviderSettings.get(provider)).toMatchObject({
			refreshToken: 'refresh',
			email: 'account@example.org',
			accountId: 'account'
		});
	});
	it.each(['claude', 'openai'] as const)(
		'does not overwrite a newer %s login after an old refresh completes',
		async (provider) => {
			ProviderSettings.upsertOAuth(provider, { accessToken: 'old', refreshToken: 'old-refresh', expiresAt: 1 });
			let finish: (value: Response) => void = () => {};
			vi.stubGlobal(
				'fetch',
				vi.fn().mockReturnValue(
					new Promise<Response>((resolve) => {
						finish = resolve;
					})
				)
			);
			const pending = (provider === 'claude' ? OAuth : OpenAIOAuthService).getValidToken();
			ProviderSettings.upsertOAuth(provider, {
				accessToken: 'signed-in-again',
				refreshToken: 'fresh',
				expiresAt: Date.now() + 3600000
			});
			finish(Response.json({ access_token: 'stale-result', refresh_token: 'stale-refresh', expires_in: 3600 }));
			expect(await pending).toBeNull();
			expect(ProviderSettings.get(provider)?.accessToken).toBe('signed-in-again');
		}
	);
});
