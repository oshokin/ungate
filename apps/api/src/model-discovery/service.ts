import { createHash } from 'node:crypto';

import { MINIMAX_BASE_URLS, type ModelDiscoveryResponse, type ModelMappingProvider } from '@ungate/shared';

import { OAuth } from '../auth/oauth';
import { OpenAIOAuthService } from '../auth/openai';
import { config } from '../config';
import { ProviderSettings } from '../database/provider-settings';

import { discoverClaudeModels } from './claude';
import { CatalogHttpError, type ProviderCatalog } from './common';
import { discoverMiniMaxModels } from './minimax';
import { discoverOpenAiModels } from './openai';

interface CacheEntry {
	identity: string;
	expiresAt: number;
	result: ModelDiscoveryResponse;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const allowedMiniMaxRoots = new Set<string>(Object.values(MINIMAX_BASE_URLS));

export class ModelDiscoveryService {
	private readonly cache = new Map<ModelMappingProvider, CacheEntry>();
	private readonly flights = new Map<string, Promise<ModelDiscoveryResponse>>();

	discover(provider: ModelMappingProvider): Promise<ModelDiscoveryResponse> {
		const credentials = ProviderSettings.get(provider);
		const identity = createHash('sha256')
			.update(`${credentials?.accessToken ?? ''}:${credentials?.accountId ?? ''}:${credentials?.baseUrl ?? ''}`)
			.digest('hex');
		const cached = this.cache.get(provider);
		if (cached?.identity === identity && cached.expiresAt > Date.now()) return Promise.resolve(cached.result);
		const flightKey = `${provider}:${identity}`;
		const active = this.flights.get(flightKey);
		if (active) return active;
		const flight = this.fetch(provider, credentials)
			.then((result) => {
				if (result.status === 'ok') {
					this.cache.set(provider, { identity, result, expiresAt: Date.now() + CACHE_TTL_MS });
				}

				return result;
			})
			.finally(() => this.flights.delete(flightKey));
		this.flights.set(flightKey, flight);

		return flight;
	}

	private async fetch(
		provider: ModelMappingProvider,
		credentials: ReturnType<typeof ProviderSettings.get>
	): Promise<ModelDiscoveryResponse> {
		if (!credentials?.accessToken) return this.result(provider, 'not_connected', 'Connect this provider before syncing models.');

		try {
			let catalog: ProviderCatalog;
			if (provider === 'claude') {
				const token = await OAuth.getValidToken();
				if (!token) return this.result(provider, 'error', 'The Claude session could not supply a valid token.');
				catalog = await discoverClaudeModels(token.accessToken);
			} else if (provider === 'openai') {
				const token = await OpenAIOAuthService.getValidToken();
				if (!token) return this.result(provider, 'error', 'The ChatGPT session could not supply a valid token.');
				const accountId = token.accountId ?? credentials.accountId;
				if (!accountId) {
					return this.result(provider, 'unsupported', 'ChatGPT account ID is missing. Reconnect ChatGPT and try again.');
				}
				catalog = await discoverOpenAiModels(token.accessToken, accountId);
			} else {
				const baseUrl = (credentials.baseUrl ?? config.minimax.baseUrlGlobal).replace(/\/+$/, '');
				if (!allowedMiniMaxRoots.has(baseUrl)) {
					return this.result(
						provider,
						'unsupported',
						'Model sync is available only for the verified MiniMax Global and China endpoints.'
					);
				}
				catalog = await discoverMiniMaxModels(credentials.accessToken, baseUrl);
			}

			return {
				provider,
				status: 'ok',
				message: catalog.catalogComplete ? null : 'The provider catalog was truncated at the safety limit.',
				models: catalog.models,
				catalogComplete: catalog.catalogComplete,
				fetchedAt: new Date().toISOString()
			};
		} catch (error) {
			if (error instanceof CatalogHttpError) {
				const unavailable = [401, 403, 404].includes(error.status);

				return this.result(
					provider,
					unavailable ? 'unsupported' : 'error',
					`Provider model catalog returned HTTP ${error.status}. ${
						unavailable ? 'It is unavailable with the current credentials.' : 'Try again later.'
					}`
				);
			}

			return this.result(provider, 'error', 'Unable to sync models due to a network or unrecognized provider response.');
		}
	}

	private result(
		provider: ModelMappingProvider,
		status: ModelDiscoveryResponse['status'],
		message: string
	): ModelDiscoveryResponse {
		return { provider, status, message, models: [], catalogComplete: false, fetchedAt: null };
	}
}
