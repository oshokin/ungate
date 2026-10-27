import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';

import { type RuntimeState } from '@ungate/shared/frontend';

import { CrossProcessLock } from '../utils/cross-process-lock';

import { config } from './config';
import { RuntimeStateDefaults } from './default-state';
import { RuntimeStateNormalizer } from './normalizer';

const RUNTIME_STATE_LOCK = 'runtime-state.lock';

export class RuntimeStateFileStore {
	public static read(): RuntimeState {
		this.ensureStorage();
		const fallback = RuntimeStateDefaults.create();

		try {
			const raw = fs.readFileSync(config.paths.stateFilePath, 'utf8');
			const parsed = JSON.parse(raw) as Partial<RuntimeState>;

			return RuntimeStateNormalizer.normalize(parsed);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
			throw new Error(`Cannot read runtime state: ${error instanceof Error ? error.message : String(error)}`, {
				cause: error
			});
		}
	}

	public static write(next: RuntimeState): void {
		this.ensureStorage();
		const temp = `${config.paths.stateFilePath}.${process.pid}.${randomUUID()}.tmp`;
		try {
			fs.writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' });
			fs.renameSync(temp, config.paths.stateFilePath);
		} finally {
			fs.rmSync(temp, { force: true });
		}
	}

	public static async mutate(mutator: (current: RuntimeState) => RuntimeState): Promise<RuntimeState> {
		this.ensureStorage();
		const release = await CrossProcessLock.acquire(RUNTIME_STATE_LOCK);

		try {
			let current: RuntimeState;
			try {
				current = this.read();
			} catch (error) {
				this.quarantineCorruptState();
				throw error;
			}
			const next = mutator(current);
			this.write(next);

			return next;
		} finally {
			release();
		}
	}

	public static getFilePath(): string {
		return config.paths.stateFilePath;
	}

	private static ensureStorage(): void {
		fs.mkdirSync(config.baseDir, { recursive: true, mode: 0o700 });
		if (process.platform !== 'win32') fs.chmodSync(config.baseDir, 0o700);
	}

	private static quarantineCorruptState(): void {
		const quarantine = `${config.paths.stateFilePath}.corrupt-${Date.now()}-${randomUUID()}`;
		try {
			fs.renameSync(config.paths.stateFilePath, quarantine);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
	}
}
