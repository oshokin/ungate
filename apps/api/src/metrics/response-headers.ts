import { randomUUID } from 'node:crypto';

import { OPENAI_API_VERSION } from '@ungate/shared';

import type { FastifyReply } from 'fastify';

/** Protocol diagnostics only. No local request history or cost estimation. */
export class ProxyResponseHeaders {
	static apply(reply: FastifyReply, latencyMs: number): void {
		reply.header('x-request-id', `req_${randomUUID()}`);
		reply.header('openai-processing-ms', latencyMs.toString());
		reply.header('openai-version', OPENAI_API_VERSION);
	}
}
