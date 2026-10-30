import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { LOG_LIMITS, normalizeLogEntryLimit } from '@ungate/shared';

import { config } from './config';

import type { LogEntry } from '@ungate/shared/frontend';

const logDir = config.paths.logDir;
const processToken = `${process.pid}-${randomUUID()}`;
let generation = 0;

type LogSource = 'api' | 'tunnel';

interface EntryRecord {
	kind: 'entry';
	id: string;
	source: 'api' | 'tunnel';
	entry: LogEntry;
}

interface ClearRecord {
	kind: 'clear';
	id: string;
	source: LogSource;
	clearedAt: number;
}

type SharedLogRecord = EntryRecord | ClearRecord;

export interface SharedLogSnapshot {
	entries: LogEntry[];
	entryIds: string[];
}

export class SharedLogStore {
	public static append(source: LogSource, entry: LogEntry): string {
		this.ensureDirectory();
		const record: EntryRecord = { kind: 'entry', id: randomUUID(), source, entry };
		this.appendRecord(record);

		return record.id;
	}

	public static clear(source: LogSource): void {
		this.ensureDirectory();
		this.appendRecord({ kind: 'clear', id: randomUUID(), source, clearedAt: Date.now() });
	}

	public static readAll(source: LogSource): LogEntry[] {
		return this.readSnapshot(source).entries;
	}

	public static readSnapshot(source: LogSource, maxEntries?: number): SharedLogSnapshot {
		this.ensureDirectory();
		const records = this.readAllRecords().filter((record) => record.source === source);
		const clearAt = records.reduce(
			(latest, record) => (record.kind === 'clear' ? Math.max(latest, record.clearedAt) : latest),
			Number.NEGATIVE_INFINITY
		);

		const entries = records
			.filter((record): record is EntryRecord => record.kind === 'entry' && record.entry.timestamp > clearAt)
			.sort((left, right) => left.entry.timestamp - right.entry.timestamp || left.id.localeCompare(right.id))
			.slice(-normalizeLogEntryLimit(maxEntries));

		return {
			entries: entries.map((record) => record.entry),
			entryIds: entries.map((record) => record.id)
		};
	}

	private static readAllRecords(): SharedLogRecord[] {
		const records: SharedLogRecord[] = [];
		for (const file of this.listLogFiles()) {
			let content: string;
			try {
				content = fs.readFileSync(path.join(logDir, file), 'utf8');
			} catch {
				continue;
			}
			// A writer may be between write syscalls; never parse an unterminated tail.
			const complete = content.endsWith('\n') ? content : content.slice(0, content.lastIndexOf('\n') + 1);
			for (const line of complete.split('\n')) {
				if (!line) continue;
				try {
					const record = JSON.parse(line) as SharedLogRecord;
					if (
						(record.kind === 'entry' || record.kind === 'clear') &&
						(record.source === 'api' || record.source === 'tunnel') &&
						typeof record.id === 'string' &&
						(record.kind === 'clear'
							? Number.isFinite(record.clearedAt)
							: record.entry &&
								Number.isFinite(record.entry.timestamp) &&
								['info', 'warn', 'error'].includes(record.entry.level) &&
								typeof record.entry.message === 'string')
					) {
						records.push(record);
					}
				} catch {}
			}
		}

		return records;
	}

	private static appendRecord(record: SharedLogRecord): void {
		const file = this.currentFile();
		const fd = fs.openSync(file, fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY, 0o600);
		try {
			fs.writeSync(fd, `${JSON.stringify(record)}\n`, undefined, 'utf8');
		} finally {
			fs.closeSync(fd);
		}
		if (fs.statSync(file).size >= LOG_LIMITS.maxFileBytes) generation += 1;
		this.pruneFiles();
	}

	private static currentFile(): string {
		return path.join(logDir, `extension-${processToken}-${generation}.jsonl`);
	}

	private static listLogFiles(): string[] {
		return fs
			.readdirSync(logDir)
			.filter((name) => /^extension-[\w-]+-\d+\.jsonl$/.test(name))
			.flatMap((name) => {
				try {
					return [{ name, mtime: fs.statSync(path.join(logDir, name)).mtimeMs }];
				} catch {
					// Another window can prune a file between readdir and stat.
					return [];
				}
			})
			.sort((left, right) => left.mtime - right.mtime || left.name.localeCompare(right.name))
			.slice(-LOG_LIMITS.maxFiles)
			.map(({ name }) => name);
	}

	private static pruneFiles(): void {
		const files = this.listLogFiles();
		const all = fs.readdirSync(logDir).filter((name) => name.startsWith('extension-') && name.endsWith('.jsonl'));
		const keep = new Set(files);
		for (const file of all) {
			if (!keep.has(file)) {
				try {
					fs.unlinkSync(path.join(logDir, file));
				} catch {}
			}
		}
	}

	private static ensureDirectory(): void {
		fs.mkdirSync(config.baseDir, { recursive: true, mode: 0o700 });
		fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
		if (process.platform !== 'win32') {
			fs.chmodSync(config.baseDir, 0o700);
			fs.chmodSync(logDir, 0o700);
		}
	}
}
