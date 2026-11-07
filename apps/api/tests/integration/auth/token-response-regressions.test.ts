import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpenAIOAuthClient } from 'src/auth/openai/oauth-client';
import { OpenAIOAuthService } from 'src/auth/openai/openai-oauth-service';
import { MAX_TOKEN_RESPONSE_BYTES, readTokenResponse } from 'src/auth/openai/token-response';
import { ProviderSettings } from 'src/database/provider-settings';
import { logger } from 'src/utils/logger';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('bounded OAuth responses and refresh', () => {
	it.each([0, -1, '1', null])('rejects invalid expiry %j', async (expires_in) => {
		await expect(readTokenResponse(new Response(JSON.stringify({ access_token: 'ok', expires_in })))).rejects.toMatchObject({
			code: 'invalid_token_response'
		});
	});

	it('accepts a fractional positive lifetime', async () => {
		await expect(readTokenResponse(new Response(JSON.stringify({ access_token: 'ok', expires_in: 0.5 })))).resolves.toMatchObject(
			{ expires_in: 0.5 }
		);
	});

	it('preserves the old refresh token when persisting a valid access-token renewal', async () => {
		const owner = {
			provider: 'openai',
			accessToken: 'old-access',
			refreshToken: 'old-refresh',
			expiresAt: 1,
			email: null,
			accountId: null,
			createdAt: 0,
			baseUrl: null
		} satisfies NonNullable<ReturnType<typeof ProviderSettings.get>>;
		vi.spyOn(ProviderSettings, 'get').mockReturnValue(owner);
		const persist = vi.spyOn(ProviderSettings, 'upsertOAuth').mockImplementation(() => {});
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"access_token":"new-access","expires_in":3600}')));
		const result = await OpenAIOAuthService.refreshToken('old-refresh');
		expect(result).toMatchObject({ accessToken: 'new-access', refreshToken: 'old-refresh' });
		expect(persist).toHaveBeenCalledWith('openai', expect.objectContaining({ refreshToken: 'old-refresh' }));
	});
	it.each([true, false])('rejects oversized body (declared=%s) and cancels it', async (declared) => {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(MAX_TOKEN_RESPONSE_BYTES + 1));
			},
			cancel
		});
		await expect(
			readTokenResponse(
				new Response(body, {
					headers: declared ? { 'content-length': String(MAX_TOKEN_RESPONSE_BYTES + 1) } : {}
				})
			)
		).rejects.toMatchObject({ code: 'invalid_token_response' });
		expect(cancel).toHaveBeenCalledOnce();
	});

	it('accepts a valid response exactly at the byte limit', async () => {
		const json = JSON.stringify({ access_token: 'ok' });
		const response = new Response(json.padEnd(MAX_TOKEN_RESPONSE_BYTES, ' '));
		await expect(readTokenResponse(response)).resolves.toEqual({ access_token: 'ok' });
	});

	it('classifies failure while reading HTTP 200 as network failure', async () => {
		vi.spyOn(logger, 'error').mockImplementation(() => {});
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.error(new TypeError('secret transport error'));
			}
		});
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
		await expect(OpenAIOAuthClient.exchangeCode('code', 'verifier')).rejects.toMatchObject({ code: 'network_error' });
	});

	it.each([
		{ access_token: 'ok', refresh_token: '' },
		{ access_token: 'ok', refresh_token: 42 },
		{ access_token: 'ok', expires_in: -1 },
		{ access_token: 'ok', expires_in: 1e300 },
		{ access_token: 'ok', expires_in: '3600' },
		{}
	])('rejects invalid refresh payload %j', async (payload) => {
		vi.spyOn(logger, 'error').mockImplementation(() => {});
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(payload))));
		await expect(OpenAIOAuthClient.refreshToken('secret')).resolves.toBeNull();
	});

	it('accepts omitted rotated refresh token', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"access_token":"ok","expires_in":3600}')));
		await expect(OpenAIOAuthClient.refreshToken('old')).resolves.toEqual({ access_token: 'ok', expires_in: 3600 });
	});

	it.each([true, false])('never logs refresh secrets (HTTP=%s)', async (http) => {
		const logs = vi.spyOn(logger, 'error').mockImplementation(() => {});
		vi.stubGlobal(
			'fetch',
			http
				? vi.fn().mockResolvedValue(new Response('secret-access secret-refresh', { status: 401 }))
				: vi.fn().mockRejectedValue(new Error('secret-access secret-refresh'))
		);
		await expect(OpenAIOAuthClient.refreshToken('secret-refresh')).resolves.toBeNull();
		expect(JSON.stringify(logs.mock.calls)).not.toContain('secret-');
	});
});
