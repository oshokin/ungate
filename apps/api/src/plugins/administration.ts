import { getAdminToken } from '@ungate/shared';

import { apiKeyAuth } from './auth';

import type { FastifyInstance } from 'fastify';

export function protectAdministration(app: FastifyInstance, token = getAdminToken()): void {
	const authenticate = apiKeyAuth({ ...app.config, apiKey: token });
	app.addHook('onRequest', async (request, reply) => {
		const pathname = request.url.split('?')[0];
		if (pathname === '/health' || pathname.startsWith('/v1/')) return;

		return authenticate.call(app, request, reply);
	});
}
