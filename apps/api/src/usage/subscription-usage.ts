import { createHash } from 'node:crypto';

import { OAuth } from '../auth/oauth';
import { OpenAIOAuthService } from '../auth/openai';
import { ProviderSettings } from '../database/provider-settings';
import { PROVIDER_READ_TIMEOUT_MS } from '../security/outbound-request';

import { parseClaudeUsage, parseMiniMaxUsage, parseOpenAiUsage } from './parsers';

import type { ModelMappingProvider, ProviderUsage, SubscriptionUsage } from '@ungate/shared';

/** Provider usage endpoints. internal means the path is not a public documented API. */
const definitions = {
	claude: { url: 'https://api.anthropic.com/api/oauth/usage', contract: 'internal', parse: parseClaudeUsage },
	openai: { url: 'https://chatgpt.com/backend-api/wham/usage', contract: 'internal', parse: parseOpenAiUsage },
	minimax: { url: 'https://www.minimax.io/v1/token_plan/remains', contract: 'public', parse: parseMiniMaxUsage }
} as const;

/** How long a successful usage snapshot is reused before the provider is asked again. */
const USAGE_CACHE_TTL_MS = 15_000;
/** Largest usage response body kept in memory. */
const MAX_USAGE_BODY_BYTES = 256 * 1024;

interface CacheEntry {
	identity: string;
	expiresAt: number;
	result: ProviderUsage;
}

function credentialIdentity(
	credentials: { accessToken: string; accountId?: string | null; baseUrl?: string | null } | undefined
): string {
	return createHash('sha256')
		.update(JSON.stringify([credentials?.accessToken, credentials?.accountId, credentials?.baseUrl]))
		.digest('hex');
}

/** Account usage snapshots stay in memory. No prompts, request history or credentials are returned. */
export class SubscriptionUsageService {
	private readonly cache = new Map<ModelMappingProvider, CacheEntry>();
	private readonly flights = new Map<string, Promise<ProviderUsage>>();

	async read(refresh = false): Promise<SubscriptionUsage> {
		return {
			providers: await Promise.all(
				(['claude', 'openai', 'minimax'] as const).map((provider) => this.readProvider(provider, refresh))
			)
		};
	}

	private readProvider(provider: ModelMappingProvider, refresh: boolean): Promise<ProviderUsage> {
		const credentials = ProviderSettings.get(provider);
		const identity = credentialIdentity(credentials);
		const previous = this.cache.get(provider);
		if (previous?.identity !== identity) this.cache.delete(provider);
		// The extension owns age-based freshness using its configured refresh cadence.
		// Here stale only records a failed provider refresh retaining earlier data.
		if (previous?.identity === identity && (!refresh || previous.expiresAt > Date.now())) return Promise.resolve(previous.result);
		if (!refresh)
			return Promise.resolve({
				provider,
				status: credentials ? 'unavailable' : 'not_connected',
				message: credentials ? 'Refresh to read subscription usage.' : 'Connect this provider in Connection.',
				checkedAt: new Date().toISOString(),
				fetchedAt: null,
				stale: false,
				windows: [],
				source: definitions[provider].url,
				contract: definitions[provider].contract
			});
		const key = `${provider}:${identity}`;
		const active = this.flights.get(key);
		if (active) return active;
		let requestIdentity = identity;
		const flight = this.fetchProvider(
			provider,
			credentials,
			previous?.identity === identity ? previous.result : undefined,
			(token) => {
				requestIdentity = credentialIdentity({ ...credentials, ...token });
			}
		)
			.then((result) => {
				const current = ProviderSettings.get(provider);
				const currentIdentity = credentialIdentity(current);
				if (currentIdentity === requestIdentity)
					this.cache.set(provider, {
						identity: requestIdentity,
						result,
						expiresAt: Date.now() + Math.max(USAGE_CACHE_TTL_MS, (result.retryAfterSeconds ?? 0) * 1000)
					});
				else return this.readProvider(provider, false);

				return result;
			})
			.finally(() => {
				this.flights.delete(key);
			});
		this.flights.set(key, flight);

		return flight;
	}

	private async fetchProvider(
		provider: ModelMappingProvider,
		credentials: ReturnType<typeof ProviderSettings.get>,
		previous?: ProviderUsage,
		bindToken?: (token: { accessToken: string; accountId?: string | null }) => void
	): Promise<ProviderUsage> {
		const definition = definitions[provider];
		const result: ProviderUsage = {
			provider,
			status: 'not_connected',
			message: 'Connect this provider in Settings.',
			checkedAt: new Date().toISOString(),
			fetchedAt: null,
			stale: false,
			windows: [],
			source: definition.url,
			contract: definition.contract
		};
		if (!credentials) return result;
		if (
			provider === 'minimax' &&
			credentials.baseUrl &&
			!['https://api.minimax.io/v1', 'https://api.minimax.io'].includes(credentials.baseUrl.replace(/\/+$/, ''))
		) {
			return {
				...result,
				status: 'unsupported',
				message: 'Usage is not verified for this MiniMax region or custom endpoint. The key is not sent to another region.'
			};
		}
		try {
			const token =
				provider === 'claude'
					? await OAuth.getValidToken()
					: provider === 'openai'
						? await OpenAIOAuthService.getValidToken()
						: credentials;
			if (!token)
				return {
					...result,
					status: 'unavailable',
					message: 'The existing provider session could not supply a valid token. Check its connection in Settings.'
				};
			bindToken?.(token);
			const accountId = 'accountId' in token ? token.accountId : credentials.accountId;
			const response = await fetch(definition.url, {
				method: 'GET',
				redirect: 'error',
				signal: AbortSignal.timeout(PROVIDER_READ_TIMEOUT_MS),
				headers: {
					Authorization: `Bearer ${token.accessToken}`,
					Accept: 'application/json',
					...(provider === 'claude' ? { 'anthropic-beta': 'oauth-2025-04-20' } : {}),
					...(provider === 'openai' && accountId ? { 'ChatGPT-Account-ID': accountId } : {})
				}
			});
			if (!response.ok) {
				await response.body?.cancel();
				const unsupported = [401, 403, 404].includes(response.status);
				const retry = response.headers.get('retry-after');
				const delay = retry ? (Number.isFinite(Number(retry)) ? Number(retry) : (Date.parse(retry) - Date.now()) / 1000) : 0;

				return {
					...result,
					status: unsupported ? 'unsupported' : 'error',
					...(Number.isFinite(delay) && delay > 0 ? { retryAfterSeconds: Math.ceil(delay) } : {}),
					message: `Provider usage returned HTTP ${response.status}. ${unsupported ? 'This endpoint is unavailable with the existing credentials.' : 'Refresh later.'}`,
					...(previous?.fetchedAt ? { windows: previous.windows, fetchedAt: previous.fetchedAt, stale: true } : {})
				};
			}
			const reader = response.body?.getReader();
			if (!reader) throw new Error('Missing usage body');
			const chunks: Uint8Array[] = [];
			let bytes = 0;
			try {
				while (true) {
					const part = await reader.read();
					if (part.done) break;
					bytes += part.value.byteLength;
					if (bytes > MAX_USAGE_BODY_BYTES) {
						await reader.cancel();
						throw new Error('Usage body exceeds limit');
					}
					chunks.push(part.value);
				}
			} finally {
				reader.releaseLock();
			}
			const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
			const windows = definition.parse(payload);
			if (!windows.length)
				return {
					...result,
					status: 'unavailable',
					message: 'The provider returned no recognized subscription windows. No allowance or reset time is inferred.'
				};

			return {
				...result,
				status: 'ok',
				message:
					provider === 'minimax'
						? 'Only explicitly reported percentages are shown; reset times are not inferred.'
						: definition.contract === 'internal'
							? 'Usage availability depends on your provider account and plan.'
							: null,
				windows,
				fetchedAt: new Date().toISOString()
			};
		} catch {
			return {
				...result,
				status: 'error',
				message: 'Unable to read provider usage (network, timeout or unrecognized response). Refresh later.',
				...(previous?.fetchedAt ? { windows: previous.windows, fetchedAt: previous.fetchedAt, stale: true } : {})
			};
		}
	}
}
