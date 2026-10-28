import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeFileSync
} from 'node:fs';
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
const MIGRATION_LOCK_TIMEOUT_MS = 30000;

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);

		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== 'ESRCH';
	}
}

function acquireMigrationLock(dbPath: string): () => void {
	const lockPath = `${dbPath}.migrate.lock`;
	const deadline = Date.now() + MIGRATION_LOCK_TIMEOUT_MS;
	while (true) {
		try {
			const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
			writeFileSync(fd, String(process.pid));
			closeSync(fd);

			return () => {
				try {
					if (readFileSync(lockPath, 'utf8').trim() === String(process.pid)) unlinkSync(lockPath);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
				}
			};
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== 'EEXIST') throw error;
			let owner: number;
			try {
				const stat = lstatSync(lockPath);
				if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe migration lock path: "${lockPath}"`);
				owner = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
			} catch (readError) {
				if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue;
				throw readError;
			}
			if (Number.isInteger(owner) && owner > 0 && !isProcessAlive(owner)) {
				try {
					unlinkSync(lockPath);
				} catch (unlinkError) {
					if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
				}
				continue;
			}
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for database migrations held by PID ${owner}`);
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
		}
	}
}

function protectPath(target: string, mode: number): void {
	if (process.platform !== 'win32') chmodSync(target, mode);
}

function assertSafeOwnedPath(target: string, kind: 'database' | 'directory'): void {
	const stat = lstatSync(target);
	if (stat.isSymbolicLink() || (kind === 'database' ? !stat.isFile() : !stat.isDirectory())) {
		throw new Error(
			`Unsafe ${kind} path: "${target}" must be a non-symlink ${kind === 'database' ? 'regular file' : 'directory'}`
		);
	}
	if (process.platform !== 'win32' && typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
		throw new Error(`Unsafe ${kind} path: "${target}" is not owned by the current user`);
	}
}

function prepareDatabasePath(dbPath: string): void {
	const directory = dirname(dbPath);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	assertSafeOwnedPath(directory, 'directory');
	protectPath(directory, 0o700);

	if (!existsSync(dbPath)) {
		try {
			const fd = openSync(dbPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
			closeSync(fd);
		} catch (error) {
			// A parallel starter may create the database after existsSync().
			// The path is validated below before it is opened by SQLite.
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		}
	}
	assertSafeOwnedPath(dbPath, 'database');
	protectPath(dbPath, 0o600);
}

function protectSqliteFiles(dbPath: string): void {
	for (const target of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
		if (!existsSync(target)) continue;
		assertSafeOwnedPath(target, 'database');
		protectPath(target, 0o600);
	}
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
		prepareDatabasePath(dbPath);
		const sqliteOptions = nativeBindingPath ? { nativeBinding: nativeBindingPath } : undefined;

		_sqlite = new BetterSqlite3(dbPath, sqliteOptions);
		_sqlite.pragma(`busy_timeout = ${DATABASE_BUSY_TIMEOUT_MS}`);
		try {
			_sqlite.pragma('journal_mode = WAL');
		} catch (error) {
			// A parallel starter may be changing the same database to WAL. Migrations
			// retain their own serialization; only tolerate SQLite's transient busy.
			if (!(error instanceof Error && 'code' in error && error.code === 'SQLITE_BUSY')) throw error;
		}
		protectSqliteFiles(dbPath);

		_db = drizzle(_sqlite, { schema, casing: 'snake_case' });
		_dbPath = dbPath;

		const releaseMigrationLock = acquireMigrationLock(dbPath);
		try {
			migrate(_db, { migrationsFolder: MIGRATIONS_PATH });
		} finally {
			releaseMigrationLock();
		}
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
