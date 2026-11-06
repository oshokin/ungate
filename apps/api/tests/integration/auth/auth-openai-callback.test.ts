import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpenAICallbackServer } from 'src/auth/openai/callback-server';
import { OpenAIOAuthService } from 'src/auth/openai/openai-oauth-service';
import { OpenAIPkceSessionStore } from 'src/auth/openai/pkce-session-store';
import { config } from 'src/config';
import { logger } from 'src/utils/logger';

afterEach(async () => {
	vi.restoreAllMocks();
	await OpenAICallbackServer.stop();
});

describe('OpenAI callback failure containment', () => {
	it('returns a generic CSP-protected 500 when completeLogin rejects and consumes the session', async () => {
		const diagnostic = vi.spyOn(logger, 'error').mockImplementation(() => {});
		vi.spyOn(OpenAIOAuthService, 'completeLogin').mockRejectedValue(new Error('<script>secret-token</script>'));
		const { sessionId } = await OpenAIOAuthService.startLogin();
		const response = await fetch(`${config.openai.oauth.redirectUri}?code=code&state=${sessionId}`);
		expect(response.status).toBe(500);
		expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
		const html = await response.text();
		expect(html).not.toMatch(/secret-token|<script>/);
		expect(OpenAIPkceSessionStore.get(sessionId)).toBeUndefined();
		expect(diagnostic.mock.calls).toEqual([['OpenAI OAuth callback failed. Please restart login.']]);
		expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(/secret-token|code=|state=|<script>/);
	});

	it('contains failures after response headers have already been sent', async () => {
		const diagnostic = vi.spyOn(logger, 'error').mockImplementation(() => {});
		await OpenAICallbackServer.start((_url, _path, response) => {
			response.writeHead(200, { 'Content-Type': 'text/plain' });
			response.flushHeaders();

			return Promise.reject(new Error('post-header-secret'));
		});
		try {
			const response = await fetch(config.openai.oauth.redirectUri);
			await response.text();
		} catch {
			// The partially written response is intentionally destroyed.
		}
		expect(diagnostic.mock.calls).toEqual([['OpenAI OAuth callback failed. Please restart login.']]);
	});

	it('contains synchronous handler exceptions', async () => {
		await OpenAICallbackServer.start(() => {
			throw new Error('secret');
		});
		const response = await fetch(config.openai.oauth.redirectUri);
		expect(response.status).toBe(500);
		const html = await response.text();
		expect(html).not.toContain('secret');
	});

	it('completes normal login successfully', async () => {
		vi.spyOn(OpenAIOAuthService, 'completeLogin').mockResolvedValue({ ok: true });
		const { sessionId } = await OpenAIOAuthService.startLogin();
		const response = await fetch(`${config.openai.oauth.redirectUri}?code=code&state=${sessionId}`);
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain('Connected!');
	});

	it('does not reflect completion errors into HTML', async () => {
		vi.spyOn(OpenAIOAuthService, 'completeLogin').mockResolvedValue({ ok: false, error: '<script>secret</script>' });
		const { sessionId } = await OpenAIOAuthService.startLogin();
		const response = await fetch(`${config.openai.oauth.redirectUri}?code=code&state=${sessionId}`);
		expect(response.status).toBe(400);
		const html = await response.text();
		expect(html).not.toContain('secret');
	});

	it('does not stop a replacement server when an old callback rejects', async () => {
		let reject!: (error: Error) => void;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		await OpenAICallbackServer.start((_url, _path, response) => {
			response.end('pending');
			entered();

			return new Promise<void>((_resolve, rejectPromise) => {
				reject = rejectPromise;
			});
		});
		await fetch(config.openai.oauth.redirectUri);
		await started;
		await OpenAICallbackServer.start((_url, _path, response) => {
			response.end('replacement');

			return Promise.resolve();
		});
		reject(new Error('late failure'));
		const response = await fetch(config.openai.oauth.redirectUri);
		const html = await response.text();
		expect(html).toBe('replacement');
	});
});
