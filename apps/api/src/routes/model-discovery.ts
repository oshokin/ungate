import { MODEL_MAPPING_PROVIDERS, type ModelMappingProvider } from '@ungate/shared';

import { ModelDiscoveryService } from '../model-discovery/service';

import type { FastifyPluginCallback } from 'fastify';

const plugin: FastifyPluginCallback = (app, _options, done) => {
	const service = new ModelDiscoveryService();
	app.post('/models/discover', async (request, reply) => {
		const body = request.body;
		const provider = body && typeof body === 'object' && 'provider' in body ? (body as { provider?: unknown }).provider : null;
		if (typeof provider !== 'string' || !MODEL_MAPPING_PROVIDERS.includes(provider as ModelMappingProvider)) {
			return reply.code(400).send({ error: 'A supported provider is required.' });
		}

		return service.discover(provider as ModelMappingProvider);
	});
	done();
};

export default plugin;
