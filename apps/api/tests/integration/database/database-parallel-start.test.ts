/* eslint-disable vitest/no-conditional-expect -- Crash phase and POSIX permission assertions are intentionally platform/phase-specific. */
import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import BetterSqlite3 from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { FILE_PERMISSION_BITS, PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from '@ungate/shared';

const execFileAsync = promisify(execFile);

interface WorkerResult {
	apiKey: string;
	integrity: string;
	rowCount: number;
}

describe('database parallel startup', () => {
	it.each(['clean', 'choosing', 'published'] as const)(
		'serializes migrations after %s startup across processes',
		async (phase) => {
			const directory = mkdtempSync(join(tmpdir(), 'ungate-db-race-'));
			const dbPath = join(directory, 'data.db');
			const worker = join(import.meta.dirname, 'parallel-start-worker.ts');
			const repoRoot = join(process.cwd(), '..', '..');
			const tsxLoader = pathToFileURL(createRequire(join(repoRoot, 'scripts', 'package.json')).resolve('tsx')).href;
			const environment = {
				...process.env,
				DB_PATH: dbPath,
				DRIZZLE_PATH: join(process.cwd(), 'drizzle'),
				TEST_MIGRATION_CRITICAL_SECTION: join(directory, 'migration-critical-section')
			};

			try {
				const tickets = `${dbPath}.migrate.lock.tickets`;
				if (phase !== 'clean') {
					// The real shared helper creates crash artifacts at the exact
					// path getDb() uses. SIGKILL bypasses release/finally handlers.
					const crashed = spawnSync(
						process.execPath,
						[
							'--input-type=module',
							'-e',
							`
					import { ProcessLockAttempt } from '@ungate/shared';
					const attempt = new ProcessLockAttempt(${JSON.stringify(`${dbPath}.migrate.lock`)});
					if (${phase === 'published'} && !attempt.tryAcquire()) throw new Error('unexpected contention');
					process.kill(process.pid, 'SIGKILL');
				`
						],
						{ cwd: process.cwd(), env: environment }
					);
					expect(crashed.signal === 'SIGKILL' || (process.platform === 'win32' && crashed.status !== 0)).toBe(true);
					const entries = readdirSync(tickets);
					expect(entries).toHaveLength(1);
					expect(readdirSync(join(tickets, entries[0]))).toEqual(phase === 'choosing' ? [] : ['ticket']);
				}
				const runs = await Promise.all(
					Array.from({ length: 4 }, () =>
						execFileAsync(process.execPath, ['--import', tsxLoader, worker], { cwd: process.cwd(), env: environment })
					)
				);
				const results = runs.map(({ stdout }) => JSON.parse(stdout) as WorkerResult);

				expect(results).toHaveLength(4);
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
					expect(statSync(directory).mode & FILE_PERMISSION_BITS).toBe(PRIVATE_DIR_MODE);
					expect(statSync(dbPath).mode & FILE_PERMISSION_BITS).toBe(PRIVATE_FILE_MODE);
				}
				expect(readFileSync(dbPath).byteLength).toBeGreaterThan(0);
				expect(readdirSync(tickets)).toEqual([]);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		}
	);
});
