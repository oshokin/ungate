import { MINIMAX_BASE_URLS } from '@ungate/shared';
import { validateMiniMaxBaseUrl } from 'src/security/minimax-url';

import { MAX_MODELS, REQUEST_TIMEOUT_MS, model, readJson, uniqueModels, type ProviderCatalog } from './common';

interface MiniMaxCatalog {
	data?: unknown;
}

export async function discoverMiniMaxModels(accessToken: string, baseUrl: string): Promise<ProviderCatalog> {
	const root = await validateMiniMaxBaseUrl(baseUrl);
	const china = root === MINIMAX_BASE_URLS.china;
	const url = china ? `${root}/anthropic/v1/models` : `${root}/v1/models`;
	const response = await fetch(url, {
		method: 'GET',
		redirect: 'error',
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		headers: {
			Accept: 'application/json',
			...(china ? { 'X-Api-Key': accessToken } : { Authorization: `Bearer ${accessToken}` })
		}
	});
	const rawPayload = await readJson(response);
	const payload = rawPayload as MiniMaxCatalog;
	if (!Array.isArray(payload.data)) throw new Error('MiniMax returned an unrecognized model catalog');
	const models = uniqueModels(
		payload.data
			.map((item) => {
				if (!item || typeof item !== 'object') return null;
				const row = item as Record<string, unknown>;

				return model(row.id, row.display_name ?? row.id);
			})
			.filter((item) => item !== null)
	);

	return { models, catalogComplete: payload.data.length <= MAX_MODELS };
}
