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
		const temporary = `${target}.${owner.token}.partial`;
		fs.writeFileSync(temporary, JSON.stringify(owner), { mode: 0o600, flag: 'wx' });
		const started = Date.now();
		try {
			while (true) {
				if (!fs.existsSync(guard)) {
					try {
						fs.linkSync(temporary, target);
						let released = false;

						return () => {
							if (released) return;
							released = true;
							if (this.readOwner(target)?.token === owner.token) fs.unlinkSync(target);
						};
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
					}
					this.recoverDeadOwner(target, guard);
				}
				if (Date.now() - started >= timeoutMs) throw new Error(`Timed out waiting for Ungate lock: ${lockName}`);
				await sleep(20);
			}
		} finally {
			fs.rmSync(temporary, { force: true });
		}
	}

	private static readOwner(target: string): Owner | null {
		try {
			return JSON.parse(fs.readFileSync(target, 'utf8')) as Owner;
		} catch {
			return null;
		}
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
			fs.mkdirSync(guard);
		} catch {
			return;
		}
		try {
			// Serialize reapers and re-read ownership: a successor must never be unlinked.
			const owner = this.readOwner(target);
			if (owner && !this.alive(owner.pid)) fs.unlinkSync(target);
			else if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
				const pidFile = path.join(target, 'pid');
				if (fs.existsSync(pidFile) && !this.alive(Number(fs.readFileSync(pidFile, 'utf8')))) {
					fs.unlinkSync(pidFile);
					fs.rmdirSync(target);
				}
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		} finally {
			fs.rmdirSync(guard);
		}
	}
}
