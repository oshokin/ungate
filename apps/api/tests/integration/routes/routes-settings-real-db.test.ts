import { describe, expect, it } from 'vitest';

import settingsPlugin from 'src/routes/settings';
import { Settings } from 'src/database/app-settings';
import { getDb } from 'src/database';
import { sql } from 'drizzle-orm';

import { withPlugin } from '../test-harness';

describe('routes: settings (real database)', () => {
	const model = { id: 'audit-model', label: 'Audit', provider: 'claude' as const, upstreamModel: 'claude-test', sortOrder: 0, reasoningBudget: null, serviceTier: null, contextWindow: null, maxOutputTokens: null };

	it.each(['id', 'label', 'upstreamModel'])('rejects whitespace %s without changing settings', async (field) => {
		const app = await withPlugin(settingsPlugin);
		const before = Settings.get();
		const response = await app.inject({ method: 'POST', url: '/settings', payload: { quiet: !before.quiet, models: [{ ...model, [field]: '   ' }] } });
		expect(response.statusCode).toBe(400);
		expect(Settings.get()).toEqual(before);
		await app.close();
	});

	it('rejects case-insensitive duplicate IDs without changing settings', async () => {
		const app = await withPlugin(settingsPlugin);
		const before = Settings.get();
		const response = await app.inject({ method: 'POST', url: '/settings', payload: { models: [model, { ...model, id: ' AUDIT-MODEL ' }] } });
		expect(response.statusCode).toBe(400);
		expect(Settings.get()).toEqual(before);
		await app.close();
	});

	it('rolls back settings and model deletion when inserting models fails', () => {
		const before = Settings.get();
		const db = getDb();
		db.run(sql.raw("CREATE TEMP TRIGGER audit_fail BEFORE INSERT ON model_mappings BEGIN SELECT RAISE(ABORT, 'audit failure'); END"));
		try {
			expect(() => Settings.update({ quiet: !before.quiet, apiKey: 'replacement', models: [model] })).toThrow('audit failure');
			expect(Settings.get()).toEqual(before);
		} finally {
			db.run(sql.raw('DROP TRIGGER audit_fail'));
		}
	});

	it('strips unknown fields and saves model to database', async () => {
		const app = await withPlugin(settingsPlugin);

		const postRes = await app.inject({
			method: 'POST',
			url: '/settings',
			payload: {
				quiet: false,
				models: [
					{
						id: 'my-custom-model',
						label: 'My Custom Model',
						provider: 'claude',
						upstreamModel: 'claude-sonnet-4-7',
						sortOrder: 0,
						reasoningBudget: null,
						serviceTier: null,
						enabled: true
					}
				]
			}
		});
		expect(postRes.statusCode).toBe(200);

		const getRes = await app.inject({ method: 'GET', url: '/settings' });
		expect(getRes.statusCode).toBe(200);

		const body = getRes.json();
		const saved = body.models.find((m: { id: string }) => m.id === 'my-custom-model');

		expect(saved).toBeDefined();
		expect(saved).not.toHaveProperty('enabled');

		await app.close();
	});
});
