import { ANTHROPIC_API_VERSION, MINIMAX_BASE_URLS } from '@ungate/shared';

import { getProvider } from '../auth';
import { config } from '../config';
import { ProviderSettings } from '../database/provider-settings';
import { validateMiniMaxBaseUrl } from '../security/minimax-url';
import { fetchWithHeaderTimeout } from '../security/outbound-request';

import type { AnthropicRequest } from '../types';

export async function proxyMiniMaxAnthropicRequest(
	endpoint: '/v1/messages' | '/v1/messages/count_tokens',
	body: AnthropicRequest,
	upstreamModel: string,
	headers: Record<string, string>,
	signal?: AbortSignal
): Promise<Response> {
	const authHeader = await getProvider('minimax').getAuthHeader();
	if (!authHeader) {
		return Response.json(
			{ type: 'error', error: { type: 'authentication_error', message: 'No MiniMax API key configured' } },
			{ status: 401 }
		);
	}
	const settings = ProviderSettings.get('minimax');
	const root = await validateMiniMaxBaseUrl(settings?.baseUrl ?? config.minimax.baseUrlGlobal);
	const china = root === MINIMAX_BASE_URLS.china;
	const nativeEndpoint = `${root}/anthropic${endpoint}`;

	return fetchWithHeaderTimeout(
		nativeEndpoint,
		{
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'anthropic-version': headers['anthropic-version'] ?? ANTHROPIC_API_VERSION,
				...(headers['anthropic-beta'] ? { 'anthropic-beta': headers['anthropic-beta'] } : {}),
				...(china ? { 'X-Api-Key': authHeader.replace(/^Bearer\s+/iu, '') } : { Authorization: authHeader })
			},
			body: JSON.stringify({ ...body, model: upstreamModel })
		},
		signal,
		'minimax'
	);
}
