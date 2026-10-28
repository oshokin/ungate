import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { sleep } from '@ungate/shared';

import { config } from '../runtime-state/config';

interface Owner {
	pid: number;
	token: string;
}

export class CrossProcessLock {
	static async acquire(lockName: string, timeoutMs = config.runtimeState.lockTimeoutMs): Promise<() => void> {
		fs.mkdirSync(config.baseDir, { recursive: true, mode: 0o700 });
		const target = path.join(config.baseDir, lockName);
		const guard = `${target}.recovery`;
		const owner: Owner = { pid: process.pid, token: randomUUID() };
		const started = Date.now();
		while (true) {
			if (!fs.existsSync(guard)) {
				let created = false;
				try {
					fs.mkdirSync(target, { mode: 0o700 });
					created = true;
					fs.writeFileSync(this.ownerPath(target), JSON.stringify(owner), { mode: 0o600, flag: 'wx' });
					let released = false;

					return () => {
						if (released) return;
						released = true;
						if (this.readOwner(target)?.token === owner.token) this.removeDirectory(target);
					};
				} catch (error) {
					if (created) this.removeDirectory(target);
					if (!this.isContention(error)) {
						throw error;
					}
				}
				this.recoverDeadOwner(target, guard);
			}
			if (Date.now() - started >= timeoutMs) throw new Error(`Timed out waiting for Ungate lock: ${lockName}`);
			await sleep(20);
		}
	}

	private static isContention(error: unknown): boolean {
		const code = (error as NodeJS.ErrnoException).code;

		return code === 'EEXIST' || (process.platform === 'win32' && (code === 'EPERM' || code === 'ENOTEMPTY'));
	}

	private static readOwner(target: string): Owner | null {
		try {
			const ownerFile = fs.lstatSync(target).isDirectory() ? this.ownerPath(target) : target;
			const parsed = JSON.parse(fs.readFileSync(ownerFile, 'utf8')) as Partial<Owner>;

			return Number.isSafeInteger(parsed.pid) && typeof parsed.token === 'string'
				? { pid: parsed.pid!, token: parsed.token }
				: null;
		} catch {
			return null;
		}
	}

	private static ownerPath(target: string): string {
		return path.join(target, 'owner.json');
	}

	private static removeDirectory(target: string): void {
		fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
	}

	private static alive(pid: number): boolean {
		if (!Number.isSafeInteger(pid) || pid <= 0) return true;
		try {
			process.kill(pid, 0);

			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code !== 'ESRCH';
		}
	}

	private static recoverDeadOwner(target: string, guard: string): void {
		try {
			fs.mkdirSync(guard, { mode: 0o700 });
		} catch (error) {
			if (!this.isContention(error)) throw error;

			return;
		}
		try {
			// Serialize reapers and re-read ownership: a successor must never be unlinked.
			const owner = this.readOwner(target);
			if (owner && !this.alive(owner.pid)) this.removeDirectory(target);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		} finally {
			this.removeDirectory(guard);
		}
	}
}
