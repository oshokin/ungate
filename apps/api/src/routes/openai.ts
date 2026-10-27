import { ModelMappings } from 'src/database/model-mappings';
import { CompletionModelRouting } from 'src/orchestration/openai';
import { ClaudeChatHandler, MiniMaxChatHandler, OpenAiMappedChatHandler } from 'src/orchestration/openai/provider-handlers';
import { apiKeyAuth } from 'src/plugins/auth';
import { openAiChatRequestSchema } from 'src/schemas/proxy-requests';
import { createRequestAbortSignal } from 'src/security/outbound-request';
import { logger } from 'src/utils/logger';

import type { FastifyPluginCallback } from 'fastify';
import type { OpenAIChatRequest } from 'src/types/openai';

const plugin: FastifyPluginCallback = (app) => {
	const { config } = app;

	app.post('/v1/chat/completions', { onRequest: apiKeyAuth(config), schema: openAiChatRequestSchema }, async (request, reply) => {
		const cancellation = createRequestAbortSignal(request, reply);
		try {
			const openaiBody = request.body as OpenAIChatRequest;
			const resolvedModel = ModelMappings.resolveForChatCompletion(openaiBody.model);

			if (!resolvedModel) {
				return reply.code(404).send({ error: { message: 'Model not found', type: 'model_not_found', code: 'model_not_found' } });
			}

			if (resolvedModel.provider === 'minimax') {
				return MiniMaxChatHandler.handle(openaiBody, resolvedModel, reply, cancellation.signal);
			}

			if (CompletionModelRouting.isOpenAiMapped(resolvedModel)) {
				return OpenAiMappedChatHandler.handle(openaiBody, resolvedModel, reply, cancellation.signal);
			}

			return ClaudeChatHandler.handle(request, openaiBody, resolvedModel, reply, cancellation.signal);
		} catch {
			logger.error('OpenAI request handling failed');

			return reply.code(502).send({ error: { message: 'Upstream request failed', type: 'api_error' } });
		}
	});
};

export default plugin;
