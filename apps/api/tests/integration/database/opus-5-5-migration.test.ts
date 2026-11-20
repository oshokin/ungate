import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it } from 'vitest';

const OPUS_IDS = [
	'unopus-5.5',
	'unopus-5.5-low',
	'unopus-5.5-medium',
	'unopus-5.5-high',
	'unopus-5.5-xhigh',
	'opus-5.5',
	'opus-5.5-low',
	'opus-5.5-medium',
	'opus-5.5-high',
	'opus-5.5-xhigh'
];

function openMigrated(folder: string, file: string): BetterSqlite3.Database {
	const sqlite = new BetterSqlite3(file);
	migrate(drizzle(sqlite), { migrationsFolder: folder });

	return sqlite;
}

describe('Opus 5.5 model seed', () => {
	it('rewrites a saved dotted id, keeps an explicit budget, and seeds both id families', () => {
		const directory = mkdtempSync(join(tmpdir(), 'ungate-opus-'));
		const source = resolve(import.meta.dirname, '../../../drizzle');
		const old = join(directory, 'old');
		cpSync(source, old, { recursive: true });
		const journalPath = join(old, 'meta/_journal.json');
		const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
		journal.entries = journal.entries.filter((entry) => entry.idx < 14);
		writeFileSync(journalPath, JSON.stringify(journal));
		const sqlite = openMigrated(old, join(directory, 'data.db'));
		try {
			sqlite.exec(`INSERT INTO model_mappings(id,label,provider,upstream_model,sort_order,reasoning_budget) VALUES
				('legacy-opus-5.5-high','Legacy','claude','claude-opus-5.5',4,NULL),
				('opus-5.5-low','Existing low','claude','claude-opus-5.5',5,'xhigh'),
				('keep-me','Keep','claude','claude-sonnet-4-6',3,'high')`);
			const base = sqlite.prepare('SELECT COALESCE(MAX(sort_order), -1) AS value FROM model_mappings').get() as { value: number };
			migrate(drizzle(sqlite), { migrationsFolder: source });
			expect(sqlite.prepare("SELECT id FROM model_mappings WHERE upstream_model = 'claude-opus-5.5'").all()).toEqual([]);
			expect(
				sqlite.prepare("SELECT upstream_model, reasoning_budget FROM model_mappings WHERE id = 'legacy-opus-5.5-high'").get()
			).toEqual({ upstream_model: 'claude-opus-5-5', reasoning_budget: 'high' });
			expect(sqlite.prepare("SELECT upstream_model, reasoning_budget, label FROM model_mappings WHERE id = 'opus-5.5-low'").get()).toEqual(
				{
					upstream_model: 'claude-opus-5-5',
					reasoning_budget: 'xhigh',
					label: 'Existing low'
				}
			);
			expect(sqlite.prepare("SELECT upstream_model, reasoning_budget FROM model_mappings WHERE id = 'keep-me'").get()).toEqual({
				upstream_model: 'claude-sonnet-4-6',
				reasoning_budget: 'high'
			});
			const seeded = sqlite
				.prepare(`SELECT id FROM model_mappings WHERE id IN (${OPUS_IDS.map(() => '?').join(',')})`)
				.all(...OPUS_IDS);
			expect(seeded).toHaveLength(OPUS_IDS.length);
			expect(sqlite.prepare("SELECT sort_order FROM model_mappings WHERE id = 'unopus-5.5'").get()).toEqual({
				sort_order: base.value + 1
			});

			const statements = readFileSync(join(source, '_0014.sql'), 'utf8')
				.split('--> statement-breakpoint')
				.map((statement) => statement.trim())
				.filter((statement) => statement.length > 0);
			for (const statement of statements) sqlite.exec(statement);
			expect(sqlite.prepare("SELECT COUNT(*) AS count FROM model_mappings WHERE id = 'opus-5.5'").get()).toEqual({ count: 1 });
			expect(sqlite.prepare("SELECT reasoning_budget FROM model_mappings WHERE id = 'opus-5.5-low'").get()).toEqual({
				reasoning_budget: 'xhigh'
			});
		} finally {
			sqlite.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it('seeds both Opus 5.5 id families on a new database', () => {
		const directory = mkdtempSync(join(tmpdir(), 'ungate-opus-fresh-'));
		const sqlite = openMigrated(resolve(import.meta.dirname, '../../../drizzle'), join(directory, 'data.db'));
		try {
			const rows = sqlite
				.prepare(
					`SELECT id, upstream_model, reasoning_budget FROM model_mappings WHERE id IN (${OPUS_IDS.map(() => '?').join(',')}) ORDER BY id`
				)
				.all(...OPUS_IDS) as { id: string; upstream_model: string; reasoning_budget: string | null }[];
			expect(rows.map((row) => row.id)).toEqual([...OPUS_IDS].sort());
			expect(rows.every((row) => row.upstream_model === 'claude-opus-5-5')).toBe(true);
			expect(rows.find((row) => row.id === 'opus-5.5')?.reasoning_budget).toBeNull();
			expect(rows.find((row) => row.id === 'opus-5.5-xhigh')?.reasoning_budget).toBe('xhigh');
			expect(rows.find((row) => row.id === 'unopus-5.5-low')?.reasoning_budget).toBe('low');
		} finally {
			sqlite.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
