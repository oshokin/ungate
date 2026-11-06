import { logger } from 'src/utils/logger';

import { ModelMappings } from '../database/model-mappings';
import { HeadersExtractor } from '../handlers/headers-extractor';
import { apiKeyAuth } from '../plugins/auth';
import { proxyRequest } from '../proxy/anthropic-client';
import { proxyMiniMaxAnthropicRequest } from '../proxy/minimax-anthropic-client';
import { anthropicRequestSchema } from '../schemas/proxy-requests';
import { createRequestAbortSignal } from '../security/outbound-request';

import type { AnthropicRequest, AnthropicError } from '../types';
import type { FastifyPluginCallback } from 'fastify';

export function classifyAnthropicRouteError(error: unknown): { status: number; message: string } {
	const code = nestedErrorCode(error);
	const name = error instanceof Error ? error.name : '';
	if (name === 'AbortError' || name === 'TimeoutError' || code === 'ETIMEDOUT' || code === 'UND_ERR_HEADERS_TIMEOUT') {
		return { status: 504, message: 'Upstream provider request timed out.' };
	}
	if (
		error instanceof TypeError ||
		code === 'ECONNRESET' ||
		code === 'ECONNREFUSED' ||
		code === 'ENETUNREACH' ||
		code === 'EHOSTUNREACH' ||
		code === 'EAI_AGAIN' ||
		code === 'UND_ERR_SOCKET'
	) {
		return { status: 502, message: 'Upstream provider request failed.' };
	}

	return { status: 500, message: 'Internal gateway error.' };
}

function nestedErrorCode(error: unknown): string | undefined {
	let current = error;
	for (let depth = 0; current && depth < 5; depth += 1) {
		if (typeof current !== 'object') return undefined;
		const candidate = current as { cause?: unknown; code?: unknown };
		if (typeof candidate.code === 'string') return candidate.code;
		current = candidate.cause;
	}

	return undefined;
}

const plugin: FastifyPluginCallback = (app) => {
	const { config } = app;

	app.post(
		'/v1/messages/count_tokens',
		{
			onRequest: apiKeyAuth(config),
			schema: {
				body: {
					type: 'object',
					required: ['model', 'messages'],
					properties: { model: { type: 'string', minLength: 1 }, messages: { type: 'array' } },
					additionalProperties: true
				}
			}
		},
		async (request, reply) => {
			const cancellation = createRequestAbortSignal(request, reply);
			try {
				const body = request.body as AnthropicRequest;
				const mapping = ModelMappings.resolveForChatCompletion(body.model);
				if (!mapping || mapping.provider === 'openai') {
					return reply.code(400).send({
						type: 'error',
						error: { type: 'invalid_request_error', message: 'Model is unknown or incompatible with the Anthropic API.' }
					});
				}
				const headers = HeadersExtractor.extractAnthropicHeaders(request.headers);
				let response: Response;
				if (mapping?.provider === 'minimax') {
					response = await proxyMiniMaxAnthropicRequest(
						'/v1/messages/count_tokens',
						body,
						mapping.upstreamModel,
						headers,
						cancellation.signal
					);
				} else {
					const result = await proxyRequest(
						'/v1/messages/count_tokens',
						{ ...body, model: mapping.upstreamModel },
						headers,
						cancellation.signal
					);
					response = result.response;
				}
				reply.code(response.status);

				if (response.body) return reply.send(response.body);
				const fallbackBody = await response.arrayBuffer();

				return reply.send(fallbackBody);
			} catch (error) {
				const classified = classifyAnthropicRouteError(error);

				return reply.code(classified.status).send({ type: 'error', error: { type: 'api_error', message: classified.message } });
			}
		}
	);

	app.post('/v1/messages', { onRequest: apiKeyAuth(config), schema: anthropicRequestSchema }, async (request, reply) => {
		const cancellation = createRequestAbortSignal(request, reply);
		try {
			HeadersExtractor.logRequestDetails(request.headers, request.url, request.method, 'Anthropic /v1/messages');

			const body = request.body as AnthropicRequest;
			const headers = HeadersExtractor.extractAnthropicHeaders(request.headers);
			const mapping = ModelMappings.resolveForChatCompletion(body.model);
			if (!mapping || mapping.provider === 'openai') {
				return reply.code(400).send({
					type: 'error',
					error: { type: 'invalid_request_error', message: 'Model is unknown or incompatible with the Anthropic API.' }
				});
			}

			logger.log(`→ Model: "${body.model}" | ${body.stream ? 'stream' : 'sync'} | max_tokens=${body.max_tokens}`);

			let response: Response;
			if (mapping?.provider === 'minimax') {
				response = await proxyMiniMaxAnthropicRequest('/v1/messages', body, mapping.upstreamModel, headers, cancellation.signal);
			} else {
				const result = await proxyRequest(
					'/v1/messages',
					{ ...body, model: mapping.upstreamModel },
					headers,
					cancellation.signal
				);
				response = result.response;
			}

			for (const [key, value] of response.headers.entries()) {
				if (['content-type', 'cache-control', 'request-id', 'anthropic-request-id', 'retry-after'].includes(key.toLowerCase())) {
					reply.header(key, value);
				}
			}

			reply.code(response.status);

			if (response.body) {
				return reply.send(response.body);
			}

			const fallbackBody = await response.arrayBuffer();

			return reply.send(fallbackBody);
		} catch (error) {
			const classified = classifyAnthropicRouteError(error);
			logger.error(
				`Anthropic request handling failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
			);

			const errorBody: AnthropicError = {
				type: 'error',
				error: { type: 'api_error', message: classified.message }
			};

			return reply.code(classified.status).send(errorBody);
		}
	});
};

export default plugin;
