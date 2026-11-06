import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiServer } from '../../src/api-server';
import { BetterSqlite3Installer } from '../../src/utils/better-sqlite3-installer';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), inspect: vi.fn() }));
vi.mock('node:child_process', async (original) => {
	const actual = await original<typeof import('node:child_process')>();

	return { ...actual, spawn: mocks.spawn };
});
vi.mock('node:fs', async (original) => {
	const actual = await original<typeof import('node:fs')>();

	return { ...actual, openSync: () => 42, closeSync: () => {} };
});
vi.mock('vscode', () => ({
	ExtensionMode: { Development: 1, Production: 2 },
	workspace: { getConfiguration: () => ({ inspect: mocks.inspect }) }
}));
vi.mock('@ungate/shared', async (original) => {
	const actual = await original<typeof import('@ungate/shared')>();

	return { ...actual, getAdminToken: () => 'test-admin' };
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe('API spawn provider timeout snapshot', () => {
	it.each([undefined, '90000', 'Infinity'])('passes the setting with inherited override %s', (override) => {
		vi.stubEnv('UPSTREAM_HEADER_TIMEOUT_MS', override);
		mocks.inspect.mockReturnValue({ globalValue: 60 });
		vi.spyOn(BetterSqlite3Installer, 'resolveBindingPath').mockReturnValue('/native.node');
		mocks.spawn.mockReturnValue(Object.assign(new EventEmitter(), { unref: vi.fn() }));
		// Exercise the real spawn path without starting a process or health polling.
		const server = Object.assign(Object.create(ApiServer.prototype) as object, {
			context: { extensionMode: 2 },
			runtimePath: '/node',
			callbacks: { isLeaderWindow: () => true, isExtensionHostActive: () => true, onLog: vi.fn() },
			ensureBaseDir: vi.fn(),
			getServerCwd: () => '/api',
			attachLog: vi.fn(),
			writeRuntimeState: () => Promise.resolve(),
			startHealthCheck: vi.fn()
		}) as unknown as { spawn(): void };
		server.spawn();
		expect(mocks.spawn).toHaveBeenLastCalledWith(
			'/node',
			['bundle/main.cjs'],
			expect.objectContaining({
				env: expect.objectContaining({ UPSTREAM_HEADER_TIMEOUT_MS: override ?? '60000' })
			})
		);
	});
});
