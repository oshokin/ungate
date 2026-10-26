import { SubscriptionUsageService } from '../usage/subscription-usage';

import type { FastifyPluginCallback } from 'fastify';

const plugin: FastifyPluginCallback = (app, _options, done) => {
	const service = new SubscriptionUsageService();
	app.get('/usage', () => service.read());
	app.post('/usage/refresh', () => service.read(true));
	done();
};
export default plugin;
