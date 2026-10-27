import { randomBytes } from 'node:crypto';

import { minutesToMilliseconds } from 'date-fns';

import { logger } from 'src/utils/logger';

import { config } from '../config';
import { ProviderSettings } from '../database/provider-settings';

import type { TokenInfo, TokenRefreshResponse, AuthStatus, LoginStart } from '../types/index';

interface PkceSession {
	codeVerifier: string;
	state: string;
	expiresAt: number;
}

interface TokenExchangeResponse extends TokenRefreshResponse {
	account?: { uuid: string; email_address: string };
}

export class OAuth {
	private static readonly refreshFlights = new Map<string, Promise<TokenInfo | null>>();
	private static readonly pkceStore = new Map<string, PkceSession>();
	private static readonly SESSION_TTL_MS = minutesToMilliseconds(15);

	static {
		setInterval(() => {
			const now = Date.now();

			for (const [sessionId, session] of this.pkceStore) {
				if (now >= session.expiresAt) {
					this.pkceStore.delete(sessionId);
				}
			}
		}, minutesToMilliseconds(1));
	}

	private static base64urlEncode(buf: Buffer): string {
		return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
	}

	private static async generatePkce(): Promise<{ verifier: string; challenge: string }> {
		const verifier = this.base64urlEncode(randomBytes(32));
		const enc = new TextEncoder();
		const digest = await crypto.subtle.digest('SHA-256', enc.encode(verifier));
		const challenge = this.base64urlEncode(Buffer.from(digest));

		return { verifier, challenge };
	}

	static async startLogin(): Promise<LoginStart> {
		const { verifier, challenge } = await this.generatePkce();
		const sessionId = this.base64urlEncode(randomBytes(32));
		const state = this.base64urlEncode(randomBytes(32));

		this.pkceStore.set(sessionId, {
			codeVerifier: verifier,
			state,
			expiresAt: Date.now() + this.SESSION_TTL_MS
		});

		const params = new URLSearchParams({
			code: 'true',
			response_type: 'code',
			client_id: config.claude.clientId,
			redirect_uri: config.claude.oauth.redirectUri,
			scope: 'org:create_api_key user:profile user:inference',
			code_challenge: challenge,
			code_challenge_method: 'S256',
			state
		});

		const result: LoginStart = {
			authUrl: `https://claude.ai/oauth/authorize?${params}`,
			sessionId
		};

		return result;
	}

	static async completeLogin(codeInput: string, sessionId: string): Promise<{ ok: boolean; email?: string; error?: string }> {
		const session = this.pkceStore.get(sessionId);

		if (!session) {
			return { ok: false, error: 'Session not found or expired' };
		}

		if (Date.now() >= session.expiresAt) {
			this.pkceStore.delete(sessionId);

			return { ok: false, error: 'Session expired' };
		}

		this.pkceStore.delete(sessionId);

		// Claude returns CODE#STATE for the manual redirect flow.
		const separator = codeInput.lastIndexOf('#');
		if (separator <= 0 || separator === codeInput.length - 1) {
			return { ok: false, error: 'Missing OAuth state' };
		}
		const code = codeInput.slice(0, separator).trim();
		const state = codeInput.slice(separator + 1).trim();
		if (state !== session.state) {
			return { ok: false, error: 'Invalid OAuth state' };
		}

		try {
			const response = await fetch(config.claude.oauth.tokenUrl, {
				method: 'POST',
				signal: AbortSignal.timeout(10000),
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					grant_type: 'authorization_code',
					client_id: config.claude.clientId,
					redirect_uri: config.claude.oauth.redirectUri,
					code,
					state,
					code_verifier: session.codeVerifier
				})
			});

			if (!response.ok) {
				const errorText = await response.text();
				logger.error('Token exchange failed:', response.status, errorText);

				return { ok: false, error: `Token exchange failed: ${response.status}` };
			}

			const data: TokenExchangeResponse = await response.json();
			const expiresAt = Date.now() + data.expires_in * 1000;
			const email = data.account?.email_address;

			ProviderSettings.upsertOAuth('claude', {
				accessToken: data.access_token,
				refreshToken: data.refresh_token,
				expiresAt,
				email
			});

			logger.log('✓ OAuth login complete', email ? `(${email})` : '');

			return { ok: true, email };
		} catch (error) {
			logger.error('completeLogin error:', error);

			return { ok: false, error: String(error) };
		}
	}

	static isTokenExpired(expiresAt: number): boolean {
		const bufferMs = minutesToMilliseconds(5);

		return Date.now() >= expiresAt - bufferMs;
	}

	static refreshToken(refreshTokenValue: string): Promise<TokenInfo | null> {
		const active = this.refreshFlights.get(refreshTokenValue);
		if (active) return active;
		const flight = this.performRefresh(refreshTokenValue).finally(() => {
			this.refreshFlights.delete(refreshTokenValue);
		});
		this.refreshFlights.set(refreshTokenValue, flight);

		return flight;
	}

	private static async performRefresh(refreshTokenValue: string): Promise<TokenInfo | null> {
		try {
			const owner = ProviderSettings.get('claude');
			logger.log('Refreshing OAuth token...');

			const response = await fetch(config.claude.oauth.tokenUrl, {
				method: 'POST',
				signal: AbortSignal.timeout(10000),
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					grant_type: 'refresh_token',
					refresh_token: refreshTokenValue,
					client_id: config.claude.clientId
				})
			});

			if (!response.ok) {
				const errorText = await response.text();
				logger.error('Token refresh failed:', response.status, errorText);

				return null;
			}

			const data: TokenRefreshResponse = await response.json();
			const expiresAt = Date.now() + data.expires_in * 1000;

			const current = ProviderSettings.get('claude');
			if (!current || current.accessToken !== owner?.accessToken || current.refreshToken !== refreshTokenValue) return null;
			const refreshToken = data.refresh_token ?? refreshTokenValue;
			if (typeof data.access_token !== 'string' || !data.access_token || !Number.isFinite(expiresAt) || expiresAt <= Date.now())
				return null;
			ProviderSettings.upsertOAuth('claude', {
				accessToken: data.access_token,
				refreshToken,
				expiresAt,
				email: current.email ?? undefined,
				accountId: current.accountId ?? undefined
			});

			logger.log('Token refreshed successfully');

			const result: TokenInfo = {
				accessToken: data.access_token,
				refreshToken,
				expiresAt,
				isExpired: false
			};

			return result;
		} catch (error) {
			logger.error('Failed to refresh token:', error);

			return null;
		}
	}

	static async getValidToken(): Promise<TokenInfo | null> {
		const row = ProviderSettings.get('claude');

		if (!row) {
			return null;
		}

		if (!this.isTokenExpired(row.expiresAt!)) {
			const result: TokenInfo = {
				accessToken: row.accessToken,
				refreshToken: row.refreshToken!,
				expiresAt: row.expiresAt!,
				isExpired: false
			};

			return result;
		}

		return this.refreshToken(row.refreshToken!);
	}

	// No-op — token state is DB-backed, no in-memory cache to clear
	static clearCachedToken(): void {}

	static getAuthStatus(): AuthStatus {
		const row = ProviderSettings.get('claude');

		if (!row) {
			return { authenticated: false };
		}

		return { authenticated: true, email: row.email ?? undefined };
	}

	static logout(): void {
		ProviderSettings.remove('claude');
		logger.log('✓ Logged out, OAuth tokens deleted');
	}
}
