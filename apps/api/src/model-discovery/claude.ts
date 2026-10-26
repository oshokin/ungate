import { config } from '../config';
import { RequestBuilder } from '../proxy/request-builder';

import { MAX_MODELS, MAX_PAGES, REQUEST_TIMEOUT_MS, model, readJson, uniqueModels, type ProviderCatalog } from './common';

import type { DiscoveredModel } from '@ungate/shared';

interface ClaudeCatalog {
	data?: unknown;
	has_more?: unknown;
	last_id?: unknown;
}

export async function discoverClaudeModels(accessToken: string): Promise<ProviderCatalog> {
	const discovered: DiscoveredModel[] = [];
	let afterId: string | null = null;

	for (let page = 0; page < MAX_PAGES && discovered.length < MAX_MODELS; page++) {
		const url = new URL('/v1/models', config.anthropic.apiUrl);
		url.searchParams.set('limit', '100');
		if (afterId) url.searchParams.set('after_id', afterId);
		const response = await fetch(url, {
			method: 'GET',
			redirect: 'error',
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			headers: RequestBuilder.getClaudeOAuthHeaders(accessToken)
		});
		const rawPayload = await readJson(response);
		const payload = rawPayload as ClaudeCatalog;
		if (!Array.isArray(payload.data)) throw new Error('Claude returned an unrecognized model catalog');

		for (const item of payload.data) {
			if (!item || typeof item !== 'object') continue;
			const row = item as Record<string, unknown>;
			const normalized = model(row.id, row.display_name);
			if (normalized) discovered.push(normalized);
		}

		if (payload.has_more !== true) return { models: uniqueModels(discovered), catalogComplete: true };
		if (typeof payload.last_id !== 'string' || !payload.last_id || payload.last_id === afterId) {
			throw new Error('Claude model pagination did not advance');
		}
		afterId = payload.last_id;
	}

	return { models: uniqueModels(discovered), catalogComplete: false };
}
