import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpenAICallbackServer } from 'src/auth/openai/callback-server';
import { LOGIN_ERROR_MESSAGES, type LoginErrorCode } from 'src/auth/openai/login-error';
import { OpenAIOAuthClient } from 'src/auth/openai/oauth-client';
import { OpenAIOAuthService } from 'src/auth/openai/openai-oauth-service';
import { OpenAIPkceSessionStore } from 'src/auth/openai/pkce-session-store';
import { config } from 'src/config';
import { ProviderSettings } from 'src/database/provider-settings';
import { logger } from 'src/utils/logger';

afterEach(async () => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	await OpenAICallbackServer.stop();
});

describe('safe OpenAI login diagnostics', () => {
	it.each([
		['DNS', new TypeError('secret', { cause: { code: 'ENOTFOUND' } }), 'network_error'],
		['connection', new TypeError('secret'), 'network_error'],
		['connect timeout', new TypeError('secret', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }), 'timeout'],
		['socket timeout', new TypeError('secret', { cause: { code: 'ETIMEDOUT' } }), 'timeout'],
		['deadline', new DOMException('secret', 'TimeoutError'), 'timeout'],
		['abort', new DOMException('secret', 'AbortError'), 'timeout']
	] as const)('classifies %s without exposing the exception', async (_name, error, code) => {
		const logs = vi.spyOn(logger, 'error').mockImplementation(() => {});
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error));
		await expect(OpenAIOAuthClient.exchangeCode('secret-code', 'secret-verifier')).rejects.toMatchObject({
			code,
			message: LOGIN_ERROR_MESSAGES[code]
		});
		expect(logs.mock.calls).toEqual([['OpenAI sign-in failed:', code]]);
	});

	it.each([400, 401, 403, 429, 500, 503])('classifies HTTP %s without logging or reflecting body', async (status) => {
		const logs = vi.spyOn(logger, 'error').mockImplementation(() => {});
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<script>secret-token</script>', { status })));
		const code = status === 429 || status >= 500 ? 'provider_unavailable' : 'authorization_rejected';
		await expect(OpenAIOAuthClient.exchangeCode('secret', 'secret')).rejects.toMatchObject({ code });
		expect(logs.mock.calls).toEqual([['OpenAI sign-in failed:', code]]);
	});

	it.each([
		'not-json',
		'null',
		'[]',
		'{}',
		'{"access_token":""}',
		'{"access_token":" "}',
		'{"access_token":123}',
		'{"access_token":"valid","refresh_token":123}',
		'{"access_token":"valid","id_token":false}',
		'{"access_token":"valid","expires_in":0}',
		'{"access_token":"valid","expires_in":-1}',
		'{"access_token":"valid","expires_in":"3600"}'
	])('rejects malformed token response %s without persisting', async (body) => {
		vi.spyOn(logger, 'error').mockImplementation(() => {});
		const persist = vi.spyOn(ProviderSettings, 'upsertOAuth');
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
		OpenAIPkceSessionStore.set('invalid', { codeVerifier: 'v', state: 'invalid', expiresAt: Date.now() + 60_000 });
		const result = await OpenAIOAuthService.completeLogin('code', 'invalid');
		expect(result).toMatchObject({
			ok: false,
			errorCode: 'invalid_token_response'
		});
		expect(persist).not.toHaveBeenCalled();
		expect(OpenAIPkceSessionStore.get('invalid')).toBeUndefined();
	});

	it('accepts a valid token and preserves the bounded request and PKCE fields', async () => {
		const tokens = { access_token: 'access', refresh_token: 'refresh', expires_in: 3600 };
		const request = vi.fn().mockResolvedValue(new Response(JSON.stringify(tokens)));
		vi.stubGlobal('fetch', request);
		const result = await OpenAIOAuthClient.exchangeCode('code', 'verifier');
		expect(result).toEqual(tokens);
		const options = request.mock.calls[0][1] as RequestInit;
		expect(options.signal).toBeInstanceOf(AbortSignal);
		expect(options.body).toBeInstanceOf(URLSearchParams);
		expect((options.body as URLSearchParams).get('code_verifier')).toBe('verifier');
	});

	it('maps unexpected exceptions to application-owned copy', async () => {
		vi.spyOn(OpenAIOAuthClient, 'exchangeCode').mockRejectedValue(new Error('<script>secret</script>'));
		OpenAIPkceSessionStore.set('unexpected', { codeVerifier: 'v', state: 'unexpected', expiresAt: Date.now() + 60_000 });
		const result = await OpenAIOAuthService.completeLogin('code', 'unexpected');
		expect(result).toEqual({
			ok: false,
			errorCode: 'unexpected_error',
			error: LOGIN_ERROR_MESSAGES.unexpected_error
		});
	});

	it.each(Object.keys(LOGIN_ERROR_MESSAGES) as LoginErrorCode[])(
		'renders safe actionable callback copy for %s',
		async (errorCode) => {
			vi.spyOn(OpenAIOAuthService, 'completeLogin').mockResolvedValue({ ok: false, errorCode, error: '<script>secret</script>' });
			const { sessionId } = await OpenAIOAuthService.startLogin();
			const response = await fetch(`${config.openai.oauth.redirectUri}?code=secret-code&state=${sessionId}`);
			const html = await response.text();
			expect(response.status).toBe(400);
			expect(response.headers.get('cache-control')).toBe('no-store');
			expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
			expect(html).toContain(LOGIN_ERROR_MESSAGES[errorCode]);
			expect(html).toContain('<main><h1>Sign-in failed</h1>');
			expect(html).not.toMatch(/secret|<script>|onclick=/);
			expect(OpenAIPkceSessionStore.get(sessionId)).toBeUndefined();
		}
	);
});
