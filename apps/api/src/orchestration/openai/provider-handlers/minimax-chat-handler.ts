import { ProxyResponseHeaders } from 'src/metrics';
import { CompletionErrorMapper, CompletionModelRouting, CompletionStreamingGateway } from 'src/orchestration/openai';
import { proxyMiniMaxRequest } from 'src/proxy/minimax-client';

import type { ModelMappingConfig } from '@ungate/shared';
import type { FastifyReply } from 'fastify';
import type { OpenAIChatRequest } from 'src/types/openai';

export class MiniMaxChatHandler {
	static async handle(
		openaiBody: OpenAIChatRequest,
		resolvedModel: ModelMappingConfig | null,
		reply: FastifyReply,
		signal?: AbortSignal
	): Promise<FastifyReply> {
		const minimaxBody = CompletionModelRouting.buildMiniMaxBody(openaiBody, resolvedModel);
		const { response, context } = await proxyMiniMaxRequest(minimaxBody, signal);

		if (!response.ok) {
			const errorMessage = CompletionErrorMapper.miniMaxErrorMessage(response, context);
			const errorLatencyMs = Date.now() - context.startTime;

			ProxyResponseHeaders.apply(reply, errorLatencyMs);

			return reply.code(response.status).send({
				error: { message: errorMessage, type: 'api_error' }
			});
		}

		if (minimaxBody.stream) {
			return CompletionStreamingGateway.sendMiniMaxStream(reply, response, minimaxBody.model, context);
		}

		const responseJson = await response.json();
		const openaiResponse = context.bodyJson ?? responseJson;
		const latencyMs = Date.now() - context.startTime;

		ProxyResponseHeaders.apply(reply, latencyMs);

		return reply.send(openaiResponse);
	}
}
