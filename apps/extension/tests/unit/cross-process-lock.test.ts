import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ProcessLockAttempt } from '@ungate/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { config } from '../../src/runtime-state/config';
import { CrossProcessLock } from '../../src/utils/cross-process-lock';

const original = config.baseDir;
let temporary: string;
beforeEach(() => {
	temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ungate-lock-'));
	config.baseDir = temporary;
});
afterEach(() => {
	config.baseDir = original;
	fs.rmSync(temporary, { recursive: true, force: true });
});

describe('CrossProcessLock on the real filesystem', () => {
	it.each(['EPERM', 'EACCES', 'EBUSY'])('fails closed and recovers from %s ticket reads', (code) => {
		const child = spawnSync(
			process.execPath,
			[
				'-e',
				`
			const fs = require('node:fs');
			const assert = require('node:assert/strict');
			const { ProcessLockAttempt } = require(${JSON.stringify(path.resolve('../../packages/shared/lib/index.cjs'))});
			const target = ${JSON.stringify(path.join(temporary, 'fault.lock'))};
			const owner = new ProcessLockAttempt(target);
			assert.equal(owner.tryAcquire(), true);
			const root = target + '.tickets';
			const ownerName = fs.readdirSync(root)[0];
			const ownerTicket = require('node:path').join(root, ownerName, 'ticket');
			const read = fs.readFileSync;
			let fail = true;
			fs.readFileSync = function(file, ...args) {
				if (fail && file === ownerTicket) throw Object.assign(new Error('injected'), { code: ${JSON.stringify(code)} });
				return read.call(this, file, ...args);
			};
			const waiter = new ProcessLockAttempt(target);
			for (let i = 0; i < 20; i++) assert.equal(waiter.tryAcquire(), false);
			const waiterName = fs.readdirSync(root).find(name => name !== ownerName);
			assert.equal(fs.existsSync(require('node:path').join(root, waiterName, 'ticket')), false);
			fail = false;
			assert.equal(waiter.tryAcquire(), false);
			fail = true;
			for (let i = 0; i < 20; i++) assert.equal(waiter.tryAcquire(), false);
			fail = false;
			owner.release();
			assert.equal(waiter.tryAcquire(), true);
			waiter.release();
			assert.deepEqual(fs.readdirSync(root), []);
			`
			],
			{ encoding: 'utf8' }
		);
		expect(child.stderr).toBe('');
		expect(child.status).toBe(0);
	});

	it('serializes competing asynchronous operations without losing updates', async () => {
		let inCriticalSection = 0;
		let counter = 0;
		await Promise.all(
			Array.from({ length: 30 }, async () => {
				const release = await CrossProcessLock.acquire('state.lock', 5000);
				try {
					expect(inCriticalSection++).toBe(0);
					const previous = counter;
					await new Promise((resolve) => setTimeout(resolve, 1));
					counter = previous + 1;
					inCriticalSection--;
				} finally {
					release();
					release();
				}
			})
		);
		expect(counter).toBe(30);
		expect(fs.readdirSync(path.join(temporary, 'state.lock.tickets'))).toEqual([]);
	});

	it('times out without stealing a live lock', async () => {
		const release = await CrossProcessLock.acquire('state.lock');
		try {
			await expect(CrossProcessLock.acquire('state.lock', 30)).rejects.toThrow('Timed out');
		} finally {
			release();
		}
	});

	it('recovers dead owners before and after ticket publication', async () => {
		const dead = spawnSync(process.execPath, ['-e', '']);
		const root = path.join(temporary, 'state.lock.tickets');
		for (const suffix of ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002']) {
			const entry = path.join(root, `${dead.pid}-${suffix}`);
			fs.mkdirSync(entry, { recursive: true });
			if (suffix.endsWith('2')) fs.writeFileSync(path.join(entry, 'ticket'), '1');
		}
		const release = await CrossProcessLock.acquire('state.lock');
		release();
		const successor = await CrossProcessLock.acquire('state.lock');
		release(); // repeated stale callback must not affect successor
		await expect(CrossProcessLock.acquire('state.lock', 30)).rejects.toThrow('Timed out');
		successor();
	});

	it('does not steal an incomplete legacy lock whose owner is unknown', async () => {
		fs.mkdirSync(path.join(temporary, 'state.lock'));
		await expect(CrossProcessLock.acquire('state.lock', 30)).rejects.toThrow('Legacy lock');
	});

	it('never bypasses a live process paused before ticket publication', async () => {
		const choosing = new ProcessLockAttempt(path.join(temporary, 'state.lock'));
		await expect(CrossProcessLock.acquire('state.lock', 40)).rejects.toThrow('Timed out');
		expect(choosing.tryAcquire()).toBe(true);
		choosing.release();
		const release = await CrossProcessLock.acquire('state.lock', 100);
		release();
	});

	it('reports orphan legacy recovery guards and empty migration locks explicitly', async () => {
		fs.mkdirSync(path.join(temporary, 'state.lock.recovery'));
		await expect(CrossProcessLock.acquire('state.lock')).rejects.toThrow('Legacy lock');
		fs.writeFileSync(path.join(temporary, 'db.migrate.lock'), '');
		expect(() => new ProcessLockAttempt(path.join(temporary, 'db.migrate.lock'))).toThrow('Legacy lock');
	});

	it.skipIf(process.platform === 'win32')('recovers SIGKILL during choosing and while holding the lock', async () => {
		for (const publish of [false, true]) {
			const target = path.join(temporary, 'killed.lock');
			const child = spawnSync(process.execPath, [
				'-e',
				`
				const { ProcessLockAttempt } = require(${JSON.stringify(path.resolve('../../packages/shared/lib/index.cjs'))});
				const attempt = new ProcessLockAttempt(${JSON.stringify(target)});
				if (${publish}) {
					if (!attempt.tryAcquire()) throw new Error('unexpected contention');
				}
				process.kill(process.pid, 'SIGKILL');
			`
			]);
			expect(child.signal).toBe('SIGKILL');
			const release = await CrossProcessLock.acquire('killed.lock', 1000);
			release();
			expect(fs.readdirSync(`${target}.tickets`)).toEqual([]);
		}
	});

	it('serializes processes and concurrent dead-owner reapers', async () => {
		const target = path.join(temporary, 'parallel.lock');
		const counter = path.join(temporary, 'counter');
		fs.writeFileSync(counter, '0');
		const dead = spawnSync(process.execPath, ['-e', '']);
		const orphan = path.join(`${target}.tickets`, `${dead.pid}-00000000-0000-0000-0000-000000000001`);
		fs.mkdirSync(orphan, { recursive: true });
		await Promise.all(
			Array.from(
				{ length: 8 },
				() =>
					new Promise<void>((resolve, reject) => {
						const child = spawn(
							process.execPath,
							[
								'-e',
								`
				const fs = require('node:fs');
				const { ProcessLockAttempt } = require(${JSON.stringify(path.resolve('../../packages/shared/lib/index.cjs'))});
				for (let i = 0; i < 15; i++) {
					const attempt = new ProcessLockAttempt(${JSON.stringify(target)});
					while (!attempt.tryAcquire()) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
					const count = Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8'));
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
					fs.writeFileSync(${JSON.stringify(counter)}, String(count + 1));
					attempt.release();
				}
			`
							],
							{ stdio: ['ignore', 'ignore', 'pipe'] }
						);
						let errors = '';
						child.stderr.on('data', (data) => {
							errors += String(data);
						});
						child.on('error', reject);
						child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(errors))));
					})
			)
		);
		expect(fs.readFileSync(counter, 'utf8')).toBe('120');
		expect(fs.readdirSync(`${target}.tickets`)).toEqual([]);
	});
});
