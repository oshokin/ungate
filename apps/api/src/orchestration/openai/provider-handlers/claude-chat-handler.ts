import { AnthropicToOpenai } from 'src/adapter/anthropic-to-openai';
import { HeadersExtractor } from 'src/handlers/headers-extractor';
import { ProxyResponseHeaders } from 'src/metrics';
import { CompletionErrorMapper, CompletionModelRouting, CompletionStreamingGateway } from 'src/orchestration/openai';
import { proxyRequest } from 'src/proxy/anthropic-client';

import type { ModelMappingConfig } from '@ungate/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { OpenAIChatRequest } from 'src/types/openai';

export class ClaudeChatHandler {
	static async handle(
		request: FastifyRequest,
		openaiBody: OpenAIChatRequest,
		resolvedModel: ModelMappingConfig | null,
		reply: FastifyReply,
		signal?: AbortSignal
	): Promise<FastifyReply> {
		HeadersExtractor.logRequestDetails(request.headers, request.url, request.method, 'OpenAI /v1/chat/completions');

		const anthropicBody = CompletionModelRouting.toAnthropicRequest(openaiBody, resolvedModel);
		const headers = HeadersExtractor.extractAnthropicHeaders(request.headers);
		const { response, context } = await proxyRequest('/v1/messages', anthropicBody, headers, signal);

		if (!response.ok) {
			const errorJson = await response.json().catch(() => ({ error: { message: `HTTP ${response.status}`, type: 'api_error' } }));
			const payload = CompletionErrorMapper.claudeApiErrorPayload(errorJson);
			const errorLatencyMs = Date.now() - context.startTime;

			ProxyResponseHeaders.apply(reply, errorLatencyMs);

			const body: { error: { message: string; type?: string } } = {
				error: { message: payload.message }
			};

			if (payload.type) {
				body.error.type = payload.type;
			}

			return reply.code(response.status).send(body);
		}

		if (anthropicBody.stream) {
			const streamId = Date.now().toString();

			return CompletionStreamingGateway.sendClaudeAsOpenAiStream(reply, response, streamId, openaiBody.model, context);
		}

		const anthropicResponse = await response.json();
		const openaiResponse = AnthropicToOpenai.convert(anthropicResponse, openaiBody.model, context.reverseToolMapping);
		const latencyMs = Date.now() - context.startTime;

		ProxyResponseHeaders.apply(reply, latencyMs);

		return reply.send(openaiResponse);
	}
}
