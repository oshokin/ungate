import * as path from 'node:path';

import { ProcessLockAttempt, sleep } from '@ungate/shared';

import { config } from '../runtime-state/config';

/** Pause between attempts to take a contended lock. */
const LOCK_POLL_MS = 20;
export class CrossProcessLock {
	static async acquire(lockName: string, timeoutMs = config.runtimeState.lockTimeoutMs): Promise<() => void> {
		const attempt = new ProcessLockAttempt(path.join(config.baseDir, lockName));
		const started = Date.now();
		try {
			while (!attempt.tryAcquire()) {
				if (Date.now() - started >= timeoutMs) throw new Error(`Timed out waiting for Ungate lock: ${lockName}`);
				await sleep(LOCK_POLL_MS);
			}

			return () => attempt.release();
		} catch (error) {
			attempt.release();
			throw error;
		}
	}
}
