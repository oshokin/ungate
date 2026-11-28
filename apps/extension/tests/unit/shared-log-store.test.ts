import * as fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sharedLogTestBaseDir, sharedLogTestDir } from './helpers/shared-log-temp-dir';

vi.mock('../../src/runtime-state/config', async () => {
	const { sharedLogTestBaseDir: baseDir, sharedLogTestDir } = await import('./helpers/shared-log-temp-dir');

	return {
		config: {
			baseDir,
			paths: {
				logDir: sharedLogTestDir
			}
		}
	};
});

// eslint-disable-next-line import-x/order -- module under test loads after config mock
import { SharedLogStore } from '../../src/runtime-state/shared-log-store';

describe('SharedLogStore', () => {
	beforeEach(() => {
		fs.rmSync(sharedLogTestBaseDir, { recursive: true, force: true });
	});

	afterEach(() => {
		fs.rmSync(sharedLogTestBaseDir, { recursive: true, force: true });
	});

	it('clears only the selected source from the shared log file', () => {
		SharedLogStore.append('api', { timestamp: 1, level: 'info', message: 'api-1' });
		SharedLogStore.append('tunnel', { timestamp: 2, level: 'info', message: 'tunnel-1' });

		SharedLogStore.clear('api');

		expect(SharedLogStore.readAll('api')).toEqual([]);
		expect(SharedLogStore.readAll('tunnel')).toEqual([{ timestamp: 2, level: 'info', message: 'tunnel-1' }]);
	});

	it('keeps at most 500 entries per source', () => {
		for (let index = 0; index < 505; index += 1) {
			SharedLogStore.append('api', { timestamp: index, level: 'info', message: `api-${index}` });
		}

		const entries = SharedLogStore.readAll('api');

		expect(entries).toHaveLength(500);
		expect(entries[0]?.message).toBe('api-5');
		expect(entries.at(-1)?.message).toBe('api-504');
	});

	it('returns existing ngrok routine history unchanged without rewriting journal bytes', () => {
		const messages = [
			{ level: 'info' as const, message: 'started tunnel' },
			{ level: 'info' as const, message: 'session established' },
			{ level: 'info' as const, message: 'session reconnecting' },
			{ level: 'info' as const, message: 'received stop request' },
			{ level: 'info' as const, message: 'join connections' },
			{ level: 'warn' as const, message: 'join connections' },
			{ level: 'error' as const, message: 'join connections' },
			{ level: 'info' as const, message: 'join connections · error: connection refused' },
			{ level: 'info' as const, message: 'join connections · details: diagnostic' }
		];
		const ids = messages.map((entry, index) => SharedLogStore.append('tunnel', { ...entry, timestamp: index + 1 }));
		SharedLogStore.append('api', { timestamp: 1, level: 'info', message: 'join connections' });
		const files = fs.readdirSync(sharedLogTestDir);
		const before = files.map((file) => fs.readFileSync(`${sharedLogTestDir}/${file}`, 'utf8'));
		const snapshot = SharedLogStore.readSnapshot('tunnel', 100);
		expect(snapshot.entries.map(({ timestamp: _timestamp, ...entry }) => entry)).toEqual(messages);
		expect(snapshot.entryIds).toEqual(ids);
		expect(SharedLogStore.readAll('api')[0].message).toBe('join connections');
		expect(files.map((file) => fs.readFileSync(`${sharedLogTestDir}/${file}`, 'utf8'))).toEqual(before);
	});

	it('clears observed journal IDs across windows without trusting entry clocks', async () => {
		const now = Date.now();
		SharedLogStore.append('api', { timestamp: now + 60_000, level: 'info', message: 'old future clock' });
		vi.resetModules();
		const { SharedLogStore: otherWindow } = await import('../../src/runtime-state/shared-log-store');
		otherWindow.clear('api');
		SharedLogStore.append('api', { timestamp: now, level: 'info', message: 'same millisecond' });
		otherWindow.append('api', { timestamp: now - 60_000, level: 'info', message: 'clock moved backwards' });
		for (const window of [SharedLogStore, otherWindow]) {
			expect(window.readAll('api').map((entry) => entry.message)).toEqual(['clock moved backwards', 'same millisecond']);
		}
	});

	it('applies the requested display limit independently for each source', () => {
		for (let index = 0; index < 125; index++) {
			SharedLogStore.append('api', { timestamp: index, level: 'info', message: `entry-${index}` });
		}
		const snapshot = SharedLogStore.readSnapshot('api', 100);
		expect(snapshot.entries).toHaveLength(100);
		expect(snapshot.entryIds).toHaveLength(100);
		expect(snapshot.entries[0].message).toBe('entry-25');
		expect(SharedLogStore.readSnapshot('api', 1000).entries).toHaveLength(125);
	});

	it('ignores malformed records instead of breaking every dashboard log refresh', () => {
		SharedLogStore.append('api', { timestamp: 1, level: 'info', message: 'valid' });
		const file = `${sharedLogTestDir}/extension-corrupted-0.jsonl`;
		fs.writeFileSync(
			file,
			[
				{ kind: 'entry', id: 'missing-entry', source: 'api' },
				{ kind: 'entry', id: 'bad-message', source: 'api', entry: { timestamp: 2, level: 'info', message: null } },
				{ kind: 'clear', id: 'bad-clear', source: 'api', clearedAt: null }
			]
				.map((record) => JSON.stringify(record))
				.join('\n') + '\n'
		);
		expect(SharedLogStore.readAll('api')).toEqual([{ timestamp: 1, level: 'info', message: 'valid' }]);
	});

	it('returns stable record identities for API and Tunnel snapshots', () => {
		SharedLogStore.append('api', { timestamp: 1, level: 'info', message: 'same' });
		SharedLogStore.append('tunnel', { timestamp: 1, level: 'info', message: 'same' });

		const api = SharedLogStore.readSnapshot('api');
		const tunnel = SharedLogStore.readSnapshot('tunnel');

		expect(api.entries).toHaveLength(1);
		expect(tunnel.entries).toHaveLength(1);
		expect(api.entryIds).toHaveLength(1);
		expect(tunnel.entryIds).toHaveLength(1);
		expect(api.entryIds[0]).not.toBe(tunnel.entryIds[0]);
		expect(SharedLogStore.readSnapshot('api').entryIds).toEqual(api.entryIds);
		expect(SharedLogStore.readSnapshot('tunnel').entryIds).toEqual(tunnel.entryIds);
	});
});
