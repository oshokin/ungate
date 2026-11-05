import { Settings } from '../database/app-settings';
import { apiKeyAuth } from '../plugins/auth';

import type { FastifyPluginCallback } from 'fastify';

/** Stable catalog timestamp. A model row is not a creation event. */
const MODEL_LIST_CREATED_AT = 1_700_000_000;

const plugin: FastifyPluginCallback = (app) => {
	app.get('/v1/models', { onRequest: apiKeyAuth(app.config) }, async (_request, reply) => {
		const settings = Settings.get();
		const data = settings.models.map((model) => ({
			id: model.id,
			object: 'model' as const,
			created: MODEL_LIST_CREATED_AT,
			owned_by: model.provider,
			...(model.contextWindow
				? {
						context_window: model.contextWindow,
						context_length: model.contextWindow,
						max_input_tokens: model.contextWindow
					}
				: {}),
			...(model.maxOutputTokens
				? {
						max_output_tokens: model.maxOutputTokens,
						max_completion_tokens: model.maxOutputTokens,
						max_tokens: model.maxOutputTokens
					}
				: {})
		}));

		return reply.send({
			object: 'list',
			data
		});
	});
};

export default plugin;
