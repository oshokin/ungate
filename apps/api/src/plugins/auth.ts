import { timingSafeEqual } from 'node:crypto';

import type { Config } from '../config';
import type { onRequestAsyncHookHandler } from 'fastify';

export function apiKeyAuth(config: Config): onRequestAsyncHookHandler {
	return async (request, reply) => {
		if (!config.apiKey?.trim()) {
			return reply
				.code(503)
				.send({ error: { type: 'configuration_error', message: 'Ungate API key is required. Configure it in the dashboard.' } });
		}
		const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? '')?.[1];
		const key = bearer ?? (request.headers['x-api-key'] as string | undefined);
		if (
			typeof key !== 'string' ||
			Buffer.byteLength(key) !== Buffer.byteLength(config.apiKey) ||
			!timingSafeEqual(Buffer.from(key), Buffer.from(config.apiKey))
		) {
			return reply
				.code(403)
				.send({ type: 'error', error: { type: 'authentication_error', message: 'Unauthorized: Invalid API key' } });
		}
	};
}
