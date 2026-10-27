import cors from '@fastify/cors';
import Fastify from 'fastify';

import { logger, setQuietMode } from 'src/utils/logger';

const BODY_LIMIT_BYTES = 32 * 1024 * 1024;

import { getConfig } from './config';
import { getDb } from './database/index';
import { Settings } from './database/settings';
import { protectAdministration } from './plugins/administration';
import anthropicPlugin from './routes/anthropic';
import authPlugin from './routes/auth';
import healthPlugin from './routes/health';
import modelDiscoveryPlugin from './routes/model-discovery';
import modelsPlugin from './routes/models';
import openaiPlugin from './routes/openai';
import settingsPlugin from './routes/settings';
import usagePlugin from './routes/usage';

export async function startServer(): Promise<void> {
	getDb();

	const settings = Settings.get();
	const config = getConfig(settings);
	setQuietMode(config.quietMode);

	const app = Fastify({ logger: false, bodyLimit: BODY_LIMIT_BYTES });
	app.decorate('config', config);
	// CORS must answer browser preflight before any capability check runs.
	await app.register(cors, { origin: '*' });
	protectAdministration(app);
	app.post('/admin/shutdown', async (_request, reply) => {
		setImmediate(() => {
			// Fastify waits for keep-alive connections during close(). A detached API must
			// still terminate promptly so its replacement can bind the same port.
			const forceExit = setTimeout(() => process.exit(0), 1000);
			forceExit.unref();
			void app.close().finally(() => process.exit(0));
		});

		return reply.send({ ok: true });
	});

	// Oversized bodies are rejected before any route runs. onError observes them without
	// replacing Fastify's default handler, which preserves the standard 413 response.
	app.addHook('onError', (request, _reply, error, done) => {
		if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
			const contentLength = request.headers['content-length'] ?? 'unknown';

			logger.error(`Request body too large: ${contentLength} bytes exceeds the ${BODY_LIMIT_BYTES}-byte limit.`);
		}

		done();
	});
	app.setErrorHandler((error, _request, reply) => {
		const apiError = error as { validation?: unknown; code?: string; statusCode?: number };
		if (apiError.validation) {
			return reply.code(400).send({
				error: { message: 'Request validation failed', type: 'invalid_request_error', code: 'invalid_request' }
			});
		}
		if (apiError.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
			return reply.code(413).send({
				error: { message: 'Request body too large', type: 'invalid_request_error', code: 'request_too_large' }
			});
		}
		logger.error('Unhandled API error');

		return reply.code(apiError.statusCode && apiError.statusCode < 500 ? apiError.statusCode : 500).send({
			error: { message: 'Request failed', type: 'api_error' }
		});
	});

	await app.register(healthPlugin);
	await app.register(authPlugin);
	await app.register(anthropicPlugin);
	await app.register(openaiPlugin);
	await app.register(modelsPlugin);
	await app.register(modelDiscoveryPlugin);
	await app.register(settingsPlugin);
	await app.register(usagePlugin);

	await app.listen({ port: config.port, host: '127.0.0.1' });

	// Always print port to stdout — extension parses this to detect the running port.
	// Uses globalThis.console to bypass quiet mode.
	const address = app.server.address();
	const actualPort = typeof address === 'object' && address ? address.port : config.port;
	globalThis.console.log(`[ungate] listening on localhost:${actualPort}`);
}
