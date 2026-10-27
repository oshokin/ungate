import { logger } from 'src/utils/logger';

import { HeadersExtractor } from '../handlers/headers-extractor';
import { apiKeyAuth } from '../plugins/auth';
import { proxyRequest } from '../proxy/anthropic-client';
import { anthropicRequestSchema } from '../schemas/proxy-requests';
import { createRequestAbortSignal } from '../security/outbound-request';

import type { AnthropicRequest, AnthropicError } from '../types';
import type { FastifyPluginCallback } from 'fastify';

const plugin: FastifyPluginCallback = (app) => {
	const { config } = app;

	app.post('/v1/messages', { onRequest: apiKeyAuth(config), schema: anthropicRequestSchema }, async (request, reply) => {
		const cancellation = createRequestAbortSignal(request, reply);
		try {
			HeadersExtractor.logRequestDetails(request.headers, request.url, request.method, 'Anthropic /v1/messages');

			const body = request.body as AnthropicRequest;
			const headers = HeadersExtractor.extractAnthropicHeaders(request.headers);

			logger.log(`→ Model: "${body.model}" | ${body.stream ? 'stream' : 'sync'} | max_tokens=${body.max_tokens}`);

			const { response } = await proxyRequest('/v1/messages', body, headers, cancellation.signal);

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
		} catch {
			logger.error('Anthropic request handling failed');

			const errorBody: AnthropicError = {
				type: 'error',
				error: { type: 'api_error', message: 'Upstream request failed' }
			};

			return reply.code(502).send(errorBody);
		}
	});
};

export default plugin;
