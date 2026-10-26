import { Settings } from '../database/app-settings';
import { apiKeyAuth } from '../plugins/auth';

import type { FastifyPluginCallback } from 'fastify';

const plugin: FastifyPluginCallback = (app) => {
	app.get('/v1/models', { onRequest: apiKeyAuth(app.config) }, async (_request, reply) => {
		const settings = Settings.get();
		const data = settings.models.map((model) => ({
			id: model.id,
			object: 'model' as const,
			created: 1700000000,
			owned_by: model.provider
		}));

		return reply.send({
			object: 'list',
			data
		});
	});
};

export default plugin;
