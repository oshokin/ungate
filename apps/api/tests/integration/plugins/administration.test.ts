import { describe, expect, it } from 'vitest';

import { protectAdministration } from 'src/plugins/administration';
import { apiKeyAuth } from 'src/plugins/auth';
import { createTestApp } from '../test-harness';

describe('administration boundary (#80)', () => {
	it('requires a separate capability for settings, login, logout, analytics and shutdown', async () => {
		const app = createTestApp({ apiKey: 'model-key' });
		protectAdministration(app, 'admin-key');
		const paths = ['/settings', '/auth/claude/start', '/auth/openai/logout', '/analytics', '/admin/shutdown'];
		for (const url of paths) app.get(url, () => ({ secret: 'private' }));
		app.get('/health', () => ({ service: 'ungate' }));
		app.get('/v1/models', { onRequest: apiKeyAuth(app.config) }, () => ({ data: [] }));
		try {
			for (const url of paths) {
				expect((await app.inject({ url })).statusCode).toBe(403);
				expect((await app.inject({ url, headers: { authorization: 'Bearer model-key' } })).statusCode).toBe(403);
				expect((await app.inject({ url, headers: { authorization: 'Bearer admin-key' } })).statusCode).toBe(200);
			}
			expect((await app.inject('/health')).statusCode).toBe(200);
			expect((await app.inject('/v1/models')).statusCode).toBe(403);
			expect((await app.inject({ url: '/v1/models', headers: { authorization: 'Bearer model-key' } })).statusCode).toBe(200);
		} finally {
			await app.close();
		}
	});
});
