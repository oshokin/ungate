import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';

import { FILE_PERMISSION_BITS, PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from '@ungate/shared';
import { type RuntimeState } from '@ungate/shared/frontend';

import { CrossProcessLock } from '../utils/cross-process-lock';

import { config } from './config';
import { RuntimeStateDefaults } from './default-state';
import { RuntimeStateNormalizer } from './normalizer';

/** Lock file that serializes writes to the shared runtime state. */
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
			fs.writeFileSync(temp, JSON.stringify(next, null, 2), { mode: PRIVATE_FILE_MODE, flag: 'wx' });
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
			let stored = '';
			try {
				stored = fs.readFileSync(config.paths.stateFilePath, 'utf8');
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			}
			const next = mutator(current);
			if (JSON.stringify(next, null, 2) !== stored) this.write(next);

			return next;
		} finally {
			release();
		}
	}

	public static getFilePath(): string {
		return config.paths.stateFilePath;
	}

	/** Client ids currently stored, including ones past the liveness window. */
	public static storedClientIds(): string[] {
		try {
			const raw = JSON.parse(fs.readFileSync(config.paths.stateFilePath, 'utf8')) as { clients?: Record<string, unknown> };

			return Object.keys(raw.clients ?? {});
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
			throw error;
		}
	}

	private static ensureStorage(): void {
		fs.mkdirSync(config.baseDir, { recursive: true, mode: PRIVATE_DIR_MODE });
		if (process.platform === 'win32') return;
		if ((fs.statSync(config.baseDir).mode & FILE_PERMISSION_BITS) !== PRIVATE_DIR_MODE)
			fs.chmodSync(config.baseDir, PRIVATE_DIR_MODE);
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
