import { describe, expect, it } from 'vitest';

import { apiKeyAuth } from 'src/plugins/auth';

import { createTestApp } from '../test-harness';

describe('plugins-auth', () => {
	it('rejects requests when no server key is configured', async () => {
		const app = createTestApp({});
		app.get('/x', { onRequest: apiKeyAuth({ port: 0, quietMode: true }) }, async () => ({ ok: true }));
		await app.ready();

		const response = await app.inject({ method: 'GET', url: '/x' });
		expect(response.statusCode).toBe(503);
		expect(response.json().error.type).toBe('configuration_error');
		await app.close();
	});

	it('rejects request with invalid key and accepts valid key', async () => {
		const app = createTestApp({ apiKey: 'secret' });
		app.get('/x', { onRequest: apiKeyAuth({ port: 0, apiKey: 'secret', quietMode: true }) }, async () => ({ ok: true }));
		await app.ready();

		const bad = await app.inject({ method: 'GET', url: '/x', headers: { 'x-api-key': 'wrong' } });
		expect(bad.statusCode).toBe(403);
		expect(bad.json().error.type).toBe('authentication_error');

		const good = await app.inject({
			method: 'GET',
			url: '/x',
			headers: { authorization: 'Bearer secret' }
		});
		expect(good.statusCode).toBe(200);
		await app.close();
	});
});
