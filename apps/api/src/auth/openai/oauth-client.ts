import { OAUTH_HTTP_TIMEOUT_MS } from 'src/auth/oauth-limits';
import { config } from 'src/config';
import { logger } from 'src/utils/logger';

import { OpenAILoginError } from './login-error';
import { readTokenResponse } from './token-response';

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

			return await readTokenResponse(response);
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
				void response.body?.cancel().catch(() => {});
				logger.error('Token refresh failed:', response.status);

				return null;
			}

			return await readTokenResponse(response);
		} catch (error) {
			logger.error('Failed to refresh token:', error instanceof OpenAILoginError ? error.code : 'request_failed');

			return null;
		}
	}
}
