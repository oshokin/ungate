import { chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import BetterSqlite3, { type Database as DatabaseType } from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import { schema } from './schema';

export type DrizzleDb = BetterSQLite3Database<typeof schema>;

const MIGRATIONS_PATH = process.env.DRIZZLE_PATH ?? join(process.cwd(), 'drizzle');

let _db: DrizzleDb | null = null;
let _sqlite: DatabaseType | null = null;
let _dbPath: string | null = null;
const nativeBindingPath = process.env.UNGATE_BETTER_SQLITE3_NATIVE_BINDING;
const DATABASE_BUSY_TIMEOUT_MS = 5000;

function protectPath(target: string, mode: number): void {
	if (process.platform !== 'win32') chmodSync(target, mode);
}

function resolveDbPath(): string {
	return process.env.DB_PATH ?? join(homedir(), '.ungate', 'data.db');
}

export function getCurrentDbPath(): string {
	return _dbPath ?? resolveDbPath();
}

export function getDb(): DrizzleDb {
	const dbPath = resolveDbPath();

	if (!_db) {
		const dbDirectory = dirname(dbPath);
		mkdirSync(dbDirectory, { recursive: true, mode: 0o700 });
		if (dbDirectory === join(homedir(), '.ungate')) protectPath(dbDirectory, 0o700);
		const sqliteOptions = nativeBindingPath ? { nativeBinding: nativeBindingPath } : undefined;

		_sqlite = new BetterSqlite3(dbPath, sqliteOptions);
		protectPath(dbPath, 0o600);
		_sqlite.pragma(`busy_timeout = ${DATABASE_BUSY_TIMEOUT_MS}`);
		_sqlite.pragma('journal_mode = WAL');

		_db = drizzle(_sqlite, { schema, casing: 'snake_case' });
		_dbPath = dbPath;

		migrate(_db, { migrationsFolder: MIGRATIONS_PATH });
	} else if (_dbPath !== dbPath) {
		throw new Error(
			`Database already initialized with "${_dbPath}", but current DB_PATH is "${dbPath}". Restart process to switch database.`
		);
	}

	return _db;
}

export function getSqlite(): DatabaseType {
	getDb();

	return _sqlite!;
}

export { schema };
