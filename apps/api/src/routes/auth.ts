import { OAuth } from '../auth/oauth';
import { OpenAIOAuthService } from '../auth/openai/openai-oauth-service';
import { config } from '../config';
import { ProviderSettings } from '../database/provider-settings';
import { validateMiniMaxBaseUrl } from '../security/minimax-url';

import type { FastifyPluginCallback, FastifyReply } from 'fastify';

const OAUTH_HTML_CSP =
	"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (character) => {
		const escaped: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

		return escaped[character];
	});
}

function oauthHtml(reply: FastifyReply, body: string) {
	return reply
		.header('Content-Security-Policy', OAUTH_HTML_CSP)
		.header('X-Content-Type-Options', 'nosniff')
		.type('text/html')
		.send(body);
}

const plugin: FastifyPluginCallback = (app) => {
	app.post('/auth/claude/start', async (_request, reply) => {
		const result = await OAuth.startLogin();

		return reply.send(result);
	});

	app.post('/auth/claude/complete', async (request, reply) => {
		const { code, sessionId } = request.body as { code: string; sessionId: string };

		if (!code || !sessionId) {
			return reply.code(400).send({ ok: false, error: 'Missing code or sessionId' });
		}

		const result = await OAuth.completeLogin(code, sessionId);

		return reply.send(result);
	});

	app.get('/auth/claude/status', (_request, reply) => {
		return reply.send(OAuth.getAuthStatus());
	});

	app.post('/auth/claude/logout', (_request, reply) => {
		OAuth.logout();

		return reply.send({ ok: true });
	});

	app.get('/auth/minimax/status', (_request, reply) => {
		const creds = ProviderSettings.get('minimax');

		return reply.send({
			authenticated: !!creds?.accessToken,
			baseUrl: creds?.baseUrl ?? config.minimax.baseUrlGlobal
		});
	});

	app.post('/auth/minimax/login', async (request, reply) => {
		const { apiKey, baseUrl } = request.body as { apiKey: string; baseUrl?: string };

		if (!apiKey?.trim()) {
			return reply.code(400).send({ ok: false, error: 'API key is required' });
		}

		let validatedBaseUrl: string;
		try {
			validatedBaseUrl = await validateMiniMaxBaseUrl(baseUrl?.trim() ?? config.minimax.baseUrlGlobal);
		} catch {
			return reply.code(400).send({ ok: false, error: 'MiniMax base URL is not allowed' });
		}
		ProviderSettings.upsertApiKey('minimax', apiKey.trim(), validatedBaseUrl);

		return reply.send({ ok: true });
	});

	app.post('/auth/minimax/base-url', async (request, reply) => {
		const { baseUrl } = request.body as { baseUrl?: string };
		const trimmedBaseUrl = baseUrl?.trim();

		if (!trimmedBaseUrl) {
			return reply.code(400).send({ ok: false, error: 'Base URL is required' });
		}

		let validatedBaseUrl: string;
		try {
			validatedBaseUrl = await validateMiniMaxBaseUrl(trimmedBaseUrl);
		} catch {
			return reply.code(400).send({ ok: false, error: 'MiniMax base URL is not allowed' });
		}
		const updated = ProviderSettings.updateBaseUrl('minimax', validatedBaseUrl);

		if (!updated) {
			return reply.code(400).send({ ok: false, error: 'MiniMax is not configured yet' });
		}

		return reply.send({ ok: true });
	});

	app.post('/auth/minimax/logout', (_request, reply) => {
		ProviderSettings.remove('minimax');

		return reply.send({ ok: true });
	});

	app.get('/auth/openai/start', async (_request, reply) => {
		const result = await OpenAIOAuthService.startLogin();

		return reply.send(result);
	});

	app.get('/auth/openai/callback', async (request, reply) => {
		const { code, state: sessionId } = request.query as { code?: string; state?: string };
		if (!code || !sessionId) {
			return oauthHtml(
				reply,
				'<html><body><h1>Missing code or session</h1><p>Please close this window and try again.</p></body></html>'
			);
		}
		const result = await OpenAIOAuthService.completeLogin(code, sessionId);
		if (result.ok) {
			return oauthHtml(reply, '<html><body><h1>Connected!</h1><p>You can close this window.</p></body></html>');
		}

		return oauthHtml(reply, `<html><body><h1>Error</h1><p>${escapeHtml(result.error ?? 'Unknown error')}</p></body></html>`);
	});

	app.get('/auth/openai/status', (_request, reply) => {
		return reply.send(OpenAIOAuthService.getAuthStatus());
	});

	app.post('/auth/openai/logout', (_request, reply) => {
		OpenAIOAuthService.logout();

		return reply.send({ ok: true });
	});
};

export default plugin;
