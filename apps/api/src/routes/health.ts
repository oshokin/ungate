import { API_PROTOCOL_VERSION, UNGATE_VERSION } from '@ungate/shared';

import type { FastifyPluginCallback } from 'fastify';

const plugin: FastifyPluginCallback = (app) => {
	app.get('/health', async (_request, reply) => {
		return reply.send({ status: 'ok', service: 'ungate' });
	});

	app.get('/admin/health', async (_request, reply) => {
		return reply.send({
			status: 'ok',
			service: 'ungate',
			version: UNGATE_VERSION,
			protocolVersion: API_PROTOCOL_VERSION,
			pid: process.pid
		});
	});
};

export default plugin;
