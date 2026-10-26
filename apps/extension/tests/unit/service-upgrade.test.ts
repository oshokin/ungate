import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { getAdminToken, UNGATE_VERSION } from '@ungate/shared';
import { describe, expect, it, vi } from 'vitest';

import { ApiServer } from '../../src/api-server';
import { DashboardApiBridge } from '../../src/dashboard-api-bridge';
import { readApiHealth } from '../../src/local-api';
import { RuntimeStateStore } from '../../src/runtime-state';
import { config } from '../../src/runtime-state/config';
import { SharedServiceController } from '../../src/shared-service-controller';

vi.mock('vscode', () => ({ ExtensionMode: { Development: 1, Production: 2 } }));
vi.mock('@ungate/shared', async (original) => {
	const actual = await original<typeof import('@ungate/shared')>();

	return { ...actual, getAdminToken: () => 'isolated-upgrade-test-admin' };
});

async function freePort(): Promise<number> {
	const socket = createServer();
	await new Promise<void>((resolvePort) => socket.listen(0, '127.0.0.1', resolvePort));
	const address = socket.address();
	if (!address || typeof address === 'string') throw new Error('No port');
	await new Promise<void>((resolveClose) => socket.close(() => resolveClose()));

	return address.port;
}

// The package pipeline builds the actual API bundle before running this test.
describe('upgrade of a detached shared API', () => {
	it('replaces a legacy child with the bundled API, keeps the tunnel URL, and stays stopped after Stop all', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'ungate-upgrade-'));
		const savedConfig = structuredClone(config);
		const variables = ['PORT', 'DB_PATH', 'UNGATE_ADMIN_TOKEN', 'UNGATE_NODE_BIN'] as const;
		const savedEnv = Object.fromEntries(variables.map((key) => [key, process.env[key]]));
		let legacy: ChildProcess | undefined;
		let api: ApiServer | undefined;
		try {
			const port = await freePort();
			process.env.PORT = String(port);
			process.env.DB_PATH = join(directory, 'isolated.db');
			process.env.UNGATE_ADMIN_TOKEN = getAdminToken();
			process.env.UNGATE_NODE_BIN = process.execPath;
			config.baseDir = directory;
			config.paths.stateFilePath = join(directory, 'runtime-state.json');
			config.paths.lockPath = join(directory, 'runtime-state.lock');
			config.paths.sharedLogPath = join(directory, 'extension.log');
			const extensionPath = join(directory, 'extension');
			const packagedApi = join(extensionPath, 'bundled/api');
			mkdirSync(packagedApi, { recursive: true });
			cpSync(resolve('../api/bundle'), join(packagedApi, 'bundle'), { recursive: true });
			cpSync(resolve('../api/drizzle'), join(packagedApi, 'drizzle'), { recursive: true });
			symlinkSync(resolve('../api/node_modules'), join(packagedApi, 'node_modules'), 'junction');
			legacy = spawn(process.execPath, [resolve('tests/fixtures/legacy-api.mjs')], {
				env: process.env,
				stdio: ['ignore', 'pipe', 'pipe']
			});
			await new Promise<void>((resolveReady, reject) => {
				legacy!.once('error', reject);
				legacy!.stdout!.once('data', () => resolveReady());
			});
			await RuntimeStateStore.touchClient('old-window');
			await RuntimeStateStore.touchClient('new-window');
			await RuntimeStateStore.mutate((state) => {
				state.keyFix.enabled = true;
				Object.assign(state.api, { pid: legacy!.pid, port, status: 'running', ownerWindowId: 'old-window' });
				Object.assign(state.tunnel, { status: 'running', port, url: 'https://unchanged.trycloudflare.com' });

				return state;
			});
			const oldUsage = await fetch(`http://127.0.0.1:${port}/usage`);
			expect(oldUsage.status).toBe(404);
			const send = vi.fn<(value: { status: number; error?: string }) => void>();
			await new DashboardApiBridge(() => port, send).handle({
				type: 'api-request',
				id: randomBytes(8).toString('hex'),
				method: 'GET',
				path: '/usage'
			});
			expect(send.mock.calls[0][0]).toMatchObject({ status: 503 });
			expect(send.mock.calls[0][0].error).toContain('Update the API');
			const log: string[] = [];
			api = new ApiServer({ extensionPath, extensionMode: 2 } as never, {
				onLog: (_level, message) => log.push(message),
				onPortDetected: () => {},
				onStatusChange: () => {},
				isLeaderWindow: () => RuntimeStateStore.getLeaderWindowId(RuntimeStateStore.read()) === 'new-window',
				isExtensionHostActive: () => true,
				getWindowId: () => 'new-window'
			});
			const tunnel = { restart: vi.fn(), stop: vi.fn() };
			const services = new SharedServiceController(api, tunnel as never, 'new-window', () => true);
			await services.run('restart-services');
			const health = await readApiHealth(port);
			expect(health.version).toBe(UNGATE_VERSION);
			expect(health.pid).not.toBe(legacy.pid);
			expect(tunnel.restart).not.toHaveBeenCalled();
			expect(RuntimeStateStore.read().tunnel.url).toBe('https://unchanged.trycloudflare.com');
			const response = await fetch(`http://127.0.0.1:${port}/usage`, { headers: { Authorization: `Bearer ${getAdminToken()}` } });
			expect(response.status).toBe(200);
			await services.run('stop-services');
			expect(RuntimeStateStore.isApiStartSuppressed()).toBe(true);
			await RuntimeStateStore.prepareApiForBootstrap();
			expect(RuntimeStateStore.isApiStartSuppressed()).toBe(true);
			expect(RuntimeStateStore.read().api.status).toBe('stopped');
			expect(RuntimeStateStore.read().api.pid).toBeNull();
			expect(RuntimeStateStore.read().keyFix.enabled).toBe(false);
		} finally {
			api?.detach();
			if (api) await api.stop().catch(() => {});
			if (legacy?.exitCode === null) legacy.kill();
			Object.assign(config, savedConfig);
			for (const key of variables) {
				if (savedEnv[key] === undefined) delete process.env[key];
				else process.env[key] = savedEnv[key];
			}
			rmSync(directory, { recursive: true, force: true });
		}
	}, 60000);
});
