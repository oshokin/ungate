import { logger } from 'src/utils/logger';

import { OAuth } from '../auth/oauth';
import { config } from '../config';
import { ProviderSettings } from '../database/provider-settings';
import { fetchWithHeaderTimeout } from '../security/outbound-request';

import { RequestBuilder } from './request-builder';
import { ToolMapper } from './tool-mapper';

import type { RequestSource, AnthropicRequest, AnthropicError, Tool } from '../types';
import type { ProxyResult } from '../types/proxy';

type RequestResult =
	| { success: true; response: Response; source: RequestSource; reverseToolMapping: Record<string, string> }
	| { success: false; error: string; status: number };

async function makeClaudeCodeRequest(
	endpoint: string,
	body: AnthropicRequest,
	_headers: Record<string, string>,
	signal?: AbortSignal
): Promise<RequestResult> {
	const token = await OAuth.getValidToken();

	if (!token) {
		return { success: false, error: 'No valid OAuth token', status: 401 };
	}

	try {
		const preparedBody = RequestBuilder.prepareClaudeCodeBody(body);

		let reverseToolMapping: Record<string, string> = {};
		if (preparedBody.tools && preparedBody.tools.length > 0) {
			const mapped = ToolMapper.map(preparedBody.tools);
			preparedBody.tools = mapped.tools;
			reverseToolMapping = mapped.reverseMapping;
		}

		const url = `${config.anthropic.apiUrl}${endpoint}?beta=true`;

		const response = await fetchWithHeaderTimeout(
			url,
			{
				method: 'POST',
				headers: RequestBuilder.getClaudeOAuthHeaders(token.accessToken),
				body: JSON.stringify(preparedBody)
			},
			signal
		);

		if (response.status === 429) {
			logger.log('Claude Code rate limited');

			return { success: false, error: 'Rate limited', status: 429 };
		}

		if (response.status === 401) {
			const errorBody = await response.clone().text();
			logger.error(`Claude Code 401 error: ${errorBody}`);

			const row = ProviderSettings.get('claude');

			if (row?.refreshToken) {
				logger.log('Attempting token refresh after 401...');
				const refreshed = await OAuth.refreshToken(row.refreshToken);

				if (refreshed) {
					const retryResponse = await fetchWithHeaderTimeout(
						url,
						{
							method: 'POST',
							headers: RequestBuilder.getClaudeOAuthHeaders(refreshed.accessToken),
							body: JSON.stringify(preparedBody)
						},
						signal
					);

					logger.log(`Retry after refresh: ${retryResponse.status}`);

					return { success: true, response: retryResponse, source: 'claude', reverseToolMapping };
				}
			}

			return { success: false, error: 'OAuth token invalid', status: 401 };
		}

		if (response.status === 403) {
			const errorBody = await response.clone().text();
			logger.error(`Claude Code 403 error: ${errorBody}`);

			return { success: false, error: 'Permission denied', status: 403 };
		}

		if (response.status === 400) {
			const errorJson = await response
				.clone()
				.json()
				.catch(() => ({}));
			const errorBody = errorJson as { error?: { message?: string; type?: string } };
			const errorMessage = errorBody?.error?.message ?? '';
			const errorType = errorBody?.error?.type ?? '';

			logger.error(`API 400 Error: type=${errorType || 'unknown'} messageLength=${errorMessage.length}`);

			if (errorMessage.includes('illegal value') || errorMessage.includes('invalid') || errorMessage.includes('argument')) {
				logger.rareError(errorMessage.slice(0, 300), {
					errorType,
					requestBody: {
						model: preparedBody.model,
						messagesCount: preparedBody.messages?.length ?? 0,
						toolsCount: preparedBody.tools?.length ?? 0,
						stream: preparedBody.stream
					},
					toolNames: preparedBody.tools?.map((tool: Tool) => tool.name).slice(0, 100) ?? []
				});
			}

			if (errorMessage.includes('only authorized for use with Claude Code')) {
				return { success: false, error: 'OAuth not authorized for API', status: 403 };
			}

			return { success: false, error: errorMessage || 'Bad request', status: 400 };
		}

		return { success: true, response, source: 'claude', reverseToolMapping };
	} catch (error) {
		logger.error(`Claude Code OAuth request failed: ${String(error)}`);

		return { success: false, error: String(error), status: 500 };
	}
}

async function extractUsage(response: Response, stream: boolean): Promise<{ inputTokens: number; outputTokens: number }> {
	if (stream) {
		return { inputTokens: 0, outputTokens: 0 };
	}

	try {
		const json = await response.clone().json();
		const data = json as { usage?: { input_tokens?: number; output_tokens?: number } };
		const usage = data.usage ?? {};

		return {
			inputTokens: usage.input_tokens ?? 0,
			outputTokens: usage.output_tokens ?? 0
		};
	} catch {
		return { inputTokens: 0, outputTokens: 0 };
	}
}

export async function proxyRequest(
	endpoint: string,
	body: AnthropicRequest,
	headers: Record<string, string>,
	signal?: AbortSignal
): Promise<ProxyResult> {
	const startTime = Date.now();
	const model = body.model;
	const stream = body.stream ?? false;

	const claudeResult = await makeClaudeCodeRequest(endpoint, body, headers, signal);

	if (claudeResult.success) {
		logger.log('✓ Request served via Claude Code');

		const { inputTokens, outputTokens } = await extractUsage(claudeResult.response, stream);

		return {
			response: claudeResult.response,
			context: {
				model,
				source: claudeResult.source,
				startTime,
				reverseToolMapping: claudeResult.reverseToolMapping,
				inputTokens,
				outputTokens
			}
		};
	}

	const errorResponse: AnthropicError = {
		type: 'error',
		error: { type: 'api_error', message: claudeResult.error }
	};

	return {
		response: new Response(JSON.stringify(errorResponse), {
			status: claudeResult.status,
			headers: { 'Content-Type': 'application/json' }
		}),
		context: {
			model,
			source: 'error',
			startTime,
			reverseToolMapping: {},
			inputTokens: 0,
			outputTokens: 0
		}
	};
}
