import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
		expect(fs.readdirSync(temporary)).toEqual([]);
	});

	it('times out without stealing a live lock', async () => {
		const release = await CrossProcessLock.acquire('state.lock');
		try {
			await expect(CrossProcessLock.acquire('state.lock', 30)).rejects.toThrow('Timed out');
		} finally {
			release();
		}
	});

	it('recovers a dead owner and never deletes a successor from an old release callback', async () => {
		const dead = spawnSync(process.execPath, ['-e', '']);
		const target = path.join(temporary, 'state.lock');
		fs.mkdirSync(target);
		fs.writeFileSync(path.join(target, 'owner.json'), JSON.stringify({ pid: dead.pid, token: 'dead' }));
		const release = await CrossProcessLock.acquire('state.lock');
		fs.rmSync(target, { recursive: true });
		fs.mkdirSync(target);
		fs.writeFileSync(path.join(target, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'successor' }));
		release();
		const successor = JSON.parse(fs.readFileSync(path.join(target, 'owner.json'), 'utf8')) as { token: string };
		expect(successor.token).toBe('successor');
	});

	it('does not steal an incomplete legacy lock whose owner is unknown', async () => {
		fs.mkdirSync(path.join(temporary, 'state.lock'));
		await expect(CrossProcessLock.acquire('state.lock', 30)).rejects.toThrow('Timed out');
	});
});
