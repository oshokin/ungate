import { API_PROTOCOL_VERSION, UNGATE_VERSION } from '@ungate/shared';

import { ProviderHealth } from '../metrics/provider-health';
import { runningApiArtifactDigest } from '../services/artifact-identity';
import { readinessReport } from '../services/readiness';

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
			artifactDigest: runningApiArtifactDigest(),
			pid: process.pid
		});
	});

	app.get('/admin/health/ready', async (_request, reply) => {
		const report = readinessReport();

		return reply.code(report.ready ? 200 : 503).send(report);
	});

	app.get('/admin/health/providers', async (_request, reply) => {
		return reply.send({ providers: ProviderHealth.snapshot() });
	});
};

export default plugin;
