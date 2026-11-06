import { mkdirSync, rmdirSync } from 'node:fs';

import { ProcessLockAttempt } from '@ungate/shared';

import { getSqlite } from '../../../src/database';
import { Settings } from '../../../src/database/app-settings';

// Instrument the actual migration lock, not an independent test-only lock.
// Exclusive mkdir makes any overlapping successful acquisitions fail loudly.
const criticalSection = process.env.TEST_MIGRATION_CRITICAL_SECTION;
if (criticalSection) {
	const holders = new WeakSet<ProcessLockAttempt>();
	// Preserve methods for instrumentation; both are invoked with explicit this.
	// eslint-disable-next-line @typescript-eslint/unbound-method
	const acquire = ProcessLockAttempt.prototype.tryAcquire;
	// eslint-disable-next-line @typescript-eslint/unbound-method
	const release = ProcessLockAttempt.prototype.release;
	ProcessLockAttempt.prototype.tryAcquire = function () {
		const acquired = acquire.call(this);
		if (acquired) {
			mkdirSync(criticalSection);
			holders.add(this);
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
		}

		return acquired;
	};
	ProcessLockAttempt.prototype.release = function () {
		if (holders.delete(this)) rmdirSync(criticalSection);
		release.call(this);
	};
}

const settings = Settings.get();
const sqlite = getSqlite();
const integrity = sqlite.pragma('integrity_check', { simple: true });
const rowCount = sqlite.prepare('SELECT COUNT(*) AS count FROM app_settings WHERE id = 1').get() as { count: number };

process.stdout.write(JSON.stringify({ apiKey: settings.apiKey, integrity, rowCount: rowCount.count }));
