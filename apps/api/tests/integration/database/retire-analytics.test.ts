import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it } from 'vitest';

describe('retiring request history (#71)', () => {
	it('upgrades an existing database while preserving credentials, settings and model mappings', () => {
		const directory = mkdtempSync(join(tmpdir(), 'ungate-migration-'));
		const source = resolve(import.meta.dirname, '../../../drizzle');
		const old = join(directory, 'old');
		cpSync(source, old, { recursive: true });
		const journalPath = join(old, 'meta/_journal.json');
		const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
		journal.entries = journal.entries.filter((entry) => entry.idx < 10);
		writeFileSync(journalPath, JSON.stringify(journal));
		const sqlite = new BetterSqlite3(join(directory, 'data.db'));
		const db = drizzle(sqlite);
		try {
			migrate(db, { migrationsFolder: old });
			sqlite.exec(
				"INSERT INTO app_settings(id,api_key) VALUES(1,'model-key'); INSERT INTO provider_settings(provider,access_token,created_at) VALUES('minimax','credential',1); INSERT INTO model_mappings(id,label,provider,upstream_model,sort_order) VALUES('custom','Custom','minimax','MiniMax',0); INSERT INTO requests(timestamp,model,source,stream) VALUES(1,'old','claude',0);"
			);
			migrate(db, { migrationsFolder: source });
			expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='requests'").get()).toBeUndefined();
			expect(sqlite.prepare('SELECT api_key FROM app_settings WHERE id=1').get()).toEqual({ api_key: 'model-key' });
			expect(sqlite.prepare("SELECT access_token FROM provider_settings WHERE provider='minimax'").get()).toEqual({
				access_token: 'credential'
			});
			expect(sqlite.prepare("SELECT id FROM model_mappings WHERE id='custom'").get()).toEqual({ id: 'custom' });
		} finally {
			sqlite.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
