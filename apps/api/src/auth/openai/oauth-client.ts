import { OAUTH_HTTP_TIMEOUT_MS } from 'src/auth/oauth-limits';
import { config } from 'src/config';
import { logger } from 'src/utils/logger';

import { OpenAILoginError } from './login-error';

export class OpenAIOAuthClient {
	public static async exchangeCode(code: string, codeVerifier: string): Promise<Record<string, unknown>> {
		const oauthConfig = config.openai.oauth;
		const redirectUri = oauthConfig.redirectUri;

		try {
			const response = await fetch(oauthConfig.tokenUrl, {
				method: 'POST',
				signal: AbortSignal.timeout(OAUTH_HTTP_TIMEOUT_MS),
				headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
				body: new URLSearchParams({
					grant_type: 'authorization_code',
					client_id: oauthConfig.clientId,
					code,
					redirect_uri: redirectUri,
					code_verifier: codeVerifier
				})
			});

			if (!response.ok) {
				void response.body?.cancel().catch(() => {});
				throw new OpenAILoginError(
					response.status === 429 || response.status >= 500 ? 'provider_unavailable' : 'authorization_rejected'
				);
			}

			let tokens: unknown;
			try {
				tokens = await response.json();
			} catch (error) {
				if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw error;
				throw new OpenAILoginError('invalid_token_response');
			}
			if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) throw new OpenAILoginError('invalid_token_response');
			const payload = tokens as Record<string, unknown>;
			if (
				typeof payload.access_token !== 'string' ||
				!payload.access_token.trim() ||
				(payload.refresh_token !== undefined && typeof payload.refresh_token !== 'string') ||
				(payload.id_token !== undefined && typeof payload.id_token !== 'string') ||
				(payload.expires_in !== undefined &&
					(typeof payload.expires_in !== 'number' || !Number.isFinite(payload.expires_in) || payload.expires_in <= 0))
			) {
				throw new OpenAILoginError('invalid_token_response');
			}

			return payload;
		} catch (error) {
			const causeCode = error instanceof Error ? (error.cause as { code?: unknown } | undefined)?.code : undefined;
			const failure =
				error instanceof OpenAILoginError
					? error
					: new OpenAILoginError(
							error instanceof Error &&
								(error.name === 'TimeoutError' ||
									error.name === 'AbortError' ||
									causeCode === 'UND_ERR_CONNECT_TIMEOUT' ||
									causeCode === 'ETIMEDOUT')
								? 'timeout'
								: 'network_error'
						);
			logger.error('OpenAI sign-in failed:', failure.code);
			throw failure;
		}
	}

	public static async refreshToken(refreshTokenValue: string): Promise<Record<string, unknown> | null> {
		const oauthConfig = config.openai.oauth;

		try {
			const response = await fetch(oauthConfig.tokenUrl, {
				method: 'POST',
				signal: AbortSignal.timeout(OAUTH_HTTP_TIMEOUT_MS),
				headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
				body: new URLSearchParams({
					grant_type: 'refresh_token',
					client_id: oauthConfig.clientId,
					refresh_token: refreshTokenValue
				})
			});

			if (!response.ok) {
				const errorText = await response.text();
				logger.error('Token refresh failed:', response.status, errorText);

				return null;
			}

			const parsedTokens = await response.json();
			const tokens = parsedTokens as Record<string, unknown>;

			return tokens;
		} catch (error) {
			logger.error('Failed to refresh token:', error);

			return null;
		}
	}
}
