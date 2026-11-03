import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LOG_LIMITS } from '@ungate/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiServer } from '../../src/api-server';
import { config } from '../../src/runtime-state/config';
import { RuntimeStateDefaults } from '../../src/runtime-state/default-state';
import { RuntimeStateFileStore } from '../../src/runtime-state/file-store';

vi.mock('vscode', () => ({
	ExtensionMode: { Development: 1, Production: 2 }
}));
vi.mock('../../src/local-api', () => ({
	readApiHealth: vi.fn(() => Promise.resolve({ pid: 1, service: 'ungate', version: 'test', protocolVersion: 1 })),
	assertCompatibleApi: vi.fn(() => Promise.resolve())
}));
vi.mock('@ungate/shared', async (original) => {
	const actual = await original<typeof import('@ungate/shared')>();

	return { ...actual, getAdminToken: () => 'test-admin' };
});

describe('API process log retention', () => {
	let directory: string;
	let previousBaseDir: string;
	let previousPaths: typeof config.paths;
	let active: string;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), 'ungate-api-logs-'));
		previousBaseDir = config.baseDir;
		previousPaths = { ...config.paths };
		config.baseDir = directory;
		config.paths = {
			stateFilePath: join(directory, 'runtime-state.json'),
			lockPath: join(directory, 'runtime-state.lock'),
			logDir: join(directory, 'logs')
		};
		active = join(directory, 'api-active.log');
		writeFileSync(active, 'x'.repeat(LOG_LIMITS.maxFileBytes));
		const state = RuntimeStateDefaults.create();
		state.api.port = 9;
		state.api.logPath = active;
		RuntimeStateFileStore.write(state);
		vi.stubGlobal(
			'fetch',
			vi.fn((url: string) => {
				if (url.endsWith('/health')) throw new Error('stopped');

				return { ok: true };
			})
		);
	});

	afterEach(() => {
		config.baseDir = previousBaseDir;
		config.paths = previousPaths;
		rmSync(directory, { recursive: true, force: true });
		vi.unstubAllGlobals();
	});

	it('caps the attached API log from the health check and deletes logs past the retention count', async () => {
		const server = new ApiServer({} as never, {
			onLog: () => {},
			onPortDetected: () => {},
			onStatusChange: () => {},
			isLeaderWindow: () => true,
			isExtensionHostActive: () => true,
			getWindowId: () => 'window'
		});
		await server.start();
		await vi.waitFor(() => expect(statSync(active).size).toBe(0), { timeout: 3_000 });

		const stale = Array.from({ length: config.apiServer.retainedProcessLogs + 1 }, (_, index) => {
			const file = join(directory, `api-old-${index}.log`);
			writeFileSync(file, 'old');
			const time = new Date(1_700_000_000_000 + index * 1000);
			utimesSync(file, time, time);

			return file;
		});
		await server.stop();
		expect(existsSync(active)).toBe(true);
		expect(existsSync(stale[0])).toBe(false);
		expect(stale.slice(1).every((file) => existsSync(file))).toBe(true);
		server.detach();
	});
});
