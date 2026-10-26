import cors from '@fastify/cors';
import Fastify from 'fastify';

import { logger, setQuietMode } from 'src/utils/logger';

const BODY_LIMIT_BYTES = 256 * 1024 * 1024;

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
			void app.close().then(() => process.exit(0));
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
