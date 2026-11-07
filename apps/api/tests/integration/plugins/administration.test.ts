import { lookup } from 'node:dns/promises';

import { describe, expect, it, vi } from 'vitest';

import { protectAdministration } from 'src/plugins/administration';
import { apiKeyAuth } from 'src/plugins/auth';
import authPlugin from 'src/routes/auth';
import healthPlugin from 'src/routes/health';
import modelsPlugin from 'src/routes/models';
import settingsPlugin from 'src/routes/settings';

import { createTestApp } from '../test-harness';

const controls = vi.hoisted(() => ({
	get: vi.fn(() => ({ apiKey: 'model-key', quiet: false, models: [{ id: 'test-model', provider: 'claude' }] })),
	update: vi.fn(),
	claudeLogout: vi.fn(),
	openaiLogout: vi.fn(),
	upsertApiKey: vi.fn(),
	updateBaseUrl: vi.fn(() => true),
	remove: vi.fn()
}));

vi.mock('src/database/app-settings', () => ({ Settings: { get: controls.get, update: controls.update } }));
vi.mock('src/database/provider-settings', () => ({ ProviderSettings: controls }));
vi.mock('src/auth/oauth', () => ({ OAuth: { logout: controls.claudeLogout } }));
vi.mock('src/auth/openai/openai-oauth-service', () => ({ OpenAIOAuthService: { logout: controls.openaiLogout } }));
vi.mock('node:dns/promises', () => ({ lookup: vi.fn().mockResolvedValue([{ address: '8.8.8.8', family: 4 }]) }));

describe('administration boundary (#80)', () => {
	it('protects real settings and credential routes before any reads or mutations', async () => {
		vi.clearAllMocks();
		vi.mocked(lookup).mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never);
		controls.get.mockReturnValue({ apiKey: 'model-key', quiet: false, models: [{ id: 'test-model', provider: 'claude' }] });
		controls.updateBaseUrl.mockReturnValue(true);
		const app = createTestApp({ apiKey: 'model-key' });
		protectAdministration(app, 'admin-key');
		app.register(settingsPlugin);
		app.register(authPlugin);
		app.register(healthPlugin);
		app.register(modelsPlugin);
		const requests = [
			{ method: 'GET' as const, url: '/settings' },
			{ method: 'POST' as const, url: '/settings', payload: { quiet: true } },
			{ method: 'POST' as const, url: '/auth/claude/logout' },
			{ method: 'POST' as const, url: '/auth/openai/logout' },
			{ method: 'POST' as const, url: '/auth/minimax/logout' },
			{
				method: 'POST' as const,
				url: '/auth/minimax/login',
				payload: { apiKey: 'fake-minimax-key', baseUrl: 'https://api.minimax.io' }
			},
			{ method: 'POST' as const, url: '/auth/minimax/base-url', payload: { baseUrl: 'https://api.minimax.io' } }
		];
		try {
			for (const request of requests) {
				for (const headers of [{}, { authorization: 'Bearer model-key' }]) {
					const response = await app.inject({ ...request, headers });
					expect(response.statusCode, `${request.method} ${request.url}`).toBe(403);
					expect(response.body).not.toContain('model-key');
				}
			}
			for (const control of Object.values(controls)) expect(control).not.toHaveBeenCalled();

			for (const request of requests) {
				const response = await app.inject({ ...request, headers: { authorization: 'Bearer admin-key' } });
				expect(response.statusCode, `${request.method} ${request.url}: ${response.body}`).toBe(200);
			}
			expect(controls.get).toHaveBeenCalledTimes(1);
			expect(controls.update).toHaveBeenCalledExactlyOnceWith({ quiet: true });
			expect(controls.claudeLogout).toHaveBeenCalledTimes(1);
			expect(controls.openaiLogout).toHaveBeenCalledTimes(1);
			expect(controls.remove).toHaveBeenCalledExactlyOnceWith('minimax');
			expect(controls.upsertApiKey).toHaveBeenCalledExactlyOnceWith('minimax', 'fake-minimax-key', 'https://api.minimax.io');
			expect(controls.updateBaseUrl).toHaveBeenCalledExactlyOnceWith('minimax', 'https://api.minimax.io');

			const health = await app.inject('/health');
			expect(health.statusCode).toBe(200);
			expect(health.json()).toEqual({ status: 'ok', service: 'ungate' });
			for (const headers of [{}, { authorization: 'Bearer admin-key' }]) {
				const response = await app.inject({ url: '/v1/models', headers });
				expect(response.statusCode).toBe(403);
			}
			const models = await app.inject({ url: '/v1/models', headers: { authorization: 'Bearer model-key' } });
			expect(models.statusCode).toBe(200);
			expect(models.json()).toEqual({
				object: 'list',
				data: [{ id: 'test-model', object: 'model', created: 1700000000, owned_by: 'claude' }]
			});
		} finally {
			await app.close();
		}
	});

	it('requires a separate capability for settings, login, logout, analytics and shutdown', async () => {
		const app = createTestApp({ apiKey: 'model-key' });
		protectAdministration(app, 'admin-key');
		const paths = ['/settings', '/auth/claude/start', '/auth/openai/logout', '/analytics', '/admin/shutdown'];
		for (const url of paths) app.get(url, () => ({ secret: 'private' }));
		app.get('/health', () => ({ service: 'ungate' }));
		app.get('/v1/models', { onRequest: apiKeyAuth(app.config) }, () => ({ data: [] }));
		try {
			for (const url of paths) {
				const missing = await app.inject({ url });
				const model = await app.inject({ url, headers: { authorization: 'Bearer model-key' } });
				const admin = await app.inject({ url, headers: { authorization: 'Bearer admin-key' } });
				expect(missing.statusCode).toBe(403);
				expect(model.statusCode).toBe(403);
				expect(admin.statusCode).toBe(200);
			}
			const health = await app.inject('/health');
			const missingModels = await app.inject('/v1/models');
			const models = await app.inject({ url: '/v1/models', headers: { authorization: 'Bearer model-key' } });
			expect(health.statusCode).toBe(200);
			expect(missingModels.statusCode).toBe(403);
			expect(models.statusCode).toBe(200);
		} finally {
			await app.close();
		}
	});
});
