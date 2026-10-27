import { ProxyResponseHeaders } from 'src/metrics';
import { CompletionErrorMapper, CompletionModelRouting, CompletionStreamingGateway } from 'src/orchestration/openai';
import { proxyOpenAIRequest } from 'src/proxy/proxy-client';

import type { ModelMappingConfig } from '@ungate/shared';
import type { FastifyReply } from 'fastify';
import type { OpenAIChatRequest } from 'src/types/openai';

export class OpenAiMappedChatHandler {
	static async handle(
		openaiBody: OpenAIChatRequest,
		resolvedModel: ModelMappingConfig,
		reply: FastifyReply,
		signal?: AbortSignal
	): Promise<FastifyReply> {
		const upstreamBody = CompletionModelRouting.buildOpenAiUpstreamBody(openaiBody, resolvedModel);
		const { response, context } = await proxyOpenAIRequest(upstreamBody, 'openai', signal);

		if (!response.ok) {
			const errorMessage = await CompletionErrorMapper.openAiUpstreamErrorMessage(response);
			const latencyMs = Date.now() - context.startTime;

			ProxyResponseHeaders.apply(reply, latencyMs);

			return reply.code(response.status).send({ error: { message: errorMessage, type: 'api_error' } });
		}

		if (openaiBody.stream) {
			ProxyResponseHeaders.apply(reply, Date.now() - context.startTime);

			return CompletionStreamingGateway.sendOpenAiPassthroughStream(reply, response);
		}

		const responseJson = await response.json();
		const latencyMs = Date.now() - context.startTime;

		ProxyResponseHeaders.apply(reply, latencyMs);

		return reply.send(responseJson);
	}
}
