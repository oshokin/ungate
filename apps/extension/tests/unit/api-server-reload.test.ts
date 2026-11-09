import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiServer } from '../../src/api-server';

import { TestHelper } from './helpers/test-helper';

import type { RuntimeState } from '@ungate/shared/frontend';

const mocks = vi.hoisted(() => ({
	read: vi.fn<() => RuntimeState>(),
	mutate: vi.fn<(mutator: (state: RuntimeState) => RuntimeState) => Promise<RuntimeState>>(),
	alive: vi.fn(),
	ungate: vi.fn(),
	compatible: vi.fn()
}));
vi.mock('vscode', () => ({
	workspace: { getConfiguration: () => ({ inspect: () => undefined }) },
	ExtensionMode: { Development: 1, Production: 2 }
}));
vi.mock('@ungate/shared', async (original) => {
	const actual = await original<typeof import('@ungate/shared')>();

	return { ...actual, getAdminToken: () => 'test-admin' };
});
vi.mock('../../src/runtime-state', () => ({
	RuntimeStateStore: {
		read: mocks.read,
		mutate: mocks.mutate,
		isApiStartSuppressed: () => false,
		suppressApiAutoStart: () => Promise.resolve()
	}
}));
vi.mock('../../src/local-api', () => ({ assertCompatibleApi: mocks.compatible, readApiHealth: vi.fn() }));
vi.mock('../../src/utils/cross-process-lock', () => ({ CrossProcessLock: { acquire: () => Promise.resolve(() => {}) } }));
vi.mock('../../src/utils/managed-process', () => ({
	ManagedProcess: { isAlive: mocks.alive, isUngateApi: mocks.ungate }
}));

interface Internals {
	checkPortHealth(port: number): Promise<boolean>;
	spawn(): void;
	ensureNativeDeps(): Promise<void>;
	startHealthCheck(): void;
	stopHealthCheck(): void;
}

function createServer() {
	const callbacks = {
		onLog: vi.fn(),
		onPortDetected: vi.fn(),
		onStatusChange: vi.fn(),
		isLeaderWindow: () => true,
		isExtensionHostActive: () => true,
		getWindowId: () => 'reloaded-window'
	};
	const server = new ApiServer({ extensionMode: 1, extensionPath: '/tmp/ungate-reload-test' } as never, callbacks);
	const internals = server as unknown as Internals;
	const spawn = vi.spyOn(internals, 'spawn').mockImplementation(() => {
		throw new Error('unexpected process spawn');
	});
	const native = vi.spyOn(internals, 'ensureNativeDeps').mockResolvedValue(undefined);
	const monitor = vi.spyOn(internals, 'startHealthCheck').mockImplementation(() => {});
	const detach = vi.spyOn(internals, 'stopHealthCheck');

	return { server, internals, callbacks, spawn, native, monitor, detach };
}

beforeEach(() => {
	vi.resetAllMocks();
	const state = TestHelper.createRuntimeState(['reloaded-window'], 4783);
	state.api.pid = 1234;
	mocks.read.mockReturnValue(state);
	mocks.mutate.mockImplementation((mutator) => Promise.resolve(mutator(structuredClone(state))));
	mocks.alive.mockReturnValue(true);
	mocks.ungate.mockReturnValue(true);
	mocks.compatible.mockResolvedValue(undefined);
});

describe('shared API reconnect after window reload (#60)', () => {
	it('detaches the old window and reconnects a new instance without replacing the service', async () => {
		const old = createServer();
		vi.spyOn(old.internals, 'checkPortHealth').mockResolvedValue(true);
		await old.server.start();
		old.server.detach();
		expect(old.detach).toHaveBeenCalledOnce();
		expect(mocks.read().api).toMatchObject({ pid: 1234, port: 4783 });

		const reloaded = createServer();
		vi.spyOn(reloaded.internals, 'checkPortHealth').mockResolvedValue(true);
		await reloaded.server.start();

		expect(reloaded.server.getPort()).toBe(4783);
		expect(reloaded.callbacks.onPortDetected).toHaveBeenCalledExactlyOnceWith(4783);
		expect(reloaded.callbacks.onStatusChange).toHaveBeenCalledWith('running');
		expect(reloaded.monitor).toHaveBeenCalledOnce();
		expect(mocks.compatible).toHaveBeenCalledTimes(2);
		for (const instance of [old, reloaded]) {
			expect(instance.spawn).not.toHaveBeenCalled();
			expect(instance.native).not.toHaveBeenCalled();
		}
	});

	it('fails closed when the preserved process is alive but unhealthy on reconnect', async () => {
		const old = createServer();
		vi.spyOn(old.internals, 'checkPortHealth').mockResolvedValue(true);
		await old.server.start();
		old.server.detach();
		const reloaded = createServer();
		vi.spyOn(reloaded.internals, 'checkPortHealth').mockResolvedValue(false);

		await expect(reloaded.server.start()).rejects.toThrow('alive but unhealthy');
		expect(reloaded.spawn).not.toHaveBeenCalled();
		expect(reloaded.native).not.toHaveBeenCalled();
		expect(reloaded.monitor).not.toHaveBeenCalled();
		expect(reloaded.callbacks.onStatusChange).toHaveBeenCalledWith('error');
		expect(reloaded.callbacks.onStatusChange).not.toHaveBeenCalledWith('running');
	});

	it('starts a new API when the saved PID belongs to another process', async () => {
		const server = createServer();
		mocks.alive.mockReturnValue(true);
		mocks.ungate.mockReturnValue(false);
		vi.spyOn(server.internals, 'checkPortHealth').mockResolvedValue(false);

		await expect(server.server.start()).rejects.toThrow('unexpected process spawn');

		expect(server.spawn).toHaveBeenCalledOnce();
		expect(server.native).toHaveBeenCalledOnce();
		expect(server.callbacks.onLog).toHaveBeenCalledWith(
			'info',
			'[process] saved pid 1234 does not belong to the Ungate API; starting a new API'
		);
		expect(server.callbacks.onStatusChange).toHaveBeenCalledWith('starting');
	});
});
