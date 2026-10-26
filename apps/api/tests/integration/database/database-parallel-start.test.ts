import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import BetterSqlite3 from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

interface WorkerResult {
	apiKey: string;
	integrity: string;
	rowCount: number;
}

describe('database parallel startup', () => {
	it('serializes migrations and singleton settings creation across processes', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'ungate-db-race-'));
		const dbPath = join(directory, 'data.db');
		const worker = join(import.meta.dirname, 'parallel-start-worker.ts');
		const repoRoot = join(process.cwd(), '..', '..');
		const tsxLoader = createRequire(join(repoRoot, 'scripts', 'package.json')).resolve('tsx');
		const environment = {
			...process.env,
			DB_PATH: dbPath,
			DRIZZLE_PATH: join(process.cwd(), 'drizzle')
		};

		try {
			const runs = await Promise.all([
				execFileAsync(process.execPath, ['--import', tsxLoader, worker], { cwd: process.cwd(), env: environment }),
				execFileAsync(process.execPath, ['--import', tsxLoader, worker], { cwd: process.cwd(), env: environment })
			]);
			const results = runs.map(({ stdout }) => JSON.parse(stdout) as WorkerResult);

			expect(results).toHaveLength(2);
			expect(results.every(({ integrity }) => integrity === 'ok')).toBe(true);
			expect(results.every(({ rowCount }) => rowCount === 1)).toBe(true);
			expect(new Set(results.map(({ apiKey }) => apiKey)).size).toBe(1);

			const sqlite = new BetterSqlite3(dbPath);
			const finalRow = sqlite.prepare('SELECT api_key AS apiKey FROM app_settings WHERE id = 1').get() as { apiKey: string };
			const count = sqlite.prepare('SELECT COUNT(*) AS count FROM app_settings').get() as { count: number };

			expect(finalRow.apiKey).toBe(results[0]?.apiKey);
			expect(count.count).toBe(1);
			expect(sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
			sqlite.close();

			if (process.platform !== 'win32') {
				expect(statSync(directory).mode & 0o777).toBe(0o700);
				expect(statSync(dbPath).mode & 0o777).toBe(0o600);
			}
			expect(readFileSync(dbPath).byteLength).toBeGreaterThan(0);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
