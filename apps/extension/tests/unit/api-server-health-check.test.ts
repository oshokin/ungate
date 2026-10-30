import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiServer } from '../../src/api-server';
import { readApiHealth } from '../../src/local-api';

import { TestHelper } from './helpers/test-helper';

import type { RuntimeState } from '@ungate/shared/frontend';

const {
	runtimeReadMock,
	runtimeHasLiveClientsMock,
	runtimeMutateMock,
	sleepMock,
	ensureInstalledMock,
	spawnSyncMock,
	spawnMock
} = vi.hoisted(() => {
	const runtimeReadMock = vi.fn<() => RuntimeState>();
	const runtimeHasLiveClientsMock = vi.fn<(state: RuntimeState) => boolean>();
	const runtimeMutateMock = vi.fn<(mutator: (current: RuntimeState) => RuntimeState) => Promise<RuntimeState>>();
	const sleepMock = vi.fn<(ms: number) => Promise<void>>();
	const ensureInstalledMock = vi.fn<() => Promise<void>>();
	const spawnSyncMock = vi.fn();
	const spawnMock = vi.fn(() => {
		const handlers = new Map<string, ((value?: unknown) => void)[]>();
		const child = {
			stderr: { on: vi.fn() },
			stdout: { on: vi.fn() },
			on(event: string, handler: (value?: unknown) => void) {
				const queue = handlers.get(event) ?? [];
				queue.push(handler);
				handlers.set(event, queue);

				return child;
			},
			unref: vi.fn(),
			kill: vi.fn()
		};

		return child;
	});

	return {
		runtimeReadMock,
		runtimeHasLiveClientsMock,
		runtimeMutateMock,
		sleepMock,
		ensureInstalledMock,
		spawnSyncMock,
		spawnMock
	};
});

vi.mock('node:child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:child_process')>();

	return {
		...actual,
		spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
		spawn: (...args: unknown[]) => spawnMock(...args)
	};
});

vi.mock('../../src/utils/better-sqlite3-installer', () => {
	return {
		BetterSqlite3Installer: {
			ensureInstalled: (...args: unknown[]) => ensureInstalledMock(...args),
			resolveBindingPath: vi.fn(() => '/tmp/ungate-extension/bundled/api/node_modules/better-sqlite3/prebuilds/linux-x64.node')
		}
	};
});

vi.mock('@ungate/shared', () => {
	return {
		sleep: sleepMock,
		getAdminToken: () => 'test-admin'
	};
});

vi.mock('../../src/local-api', () => ({
	assertCompatibleApi: vi.fn().mockResolvedValue(undefined),
	readApiHealth: vi.fn().mockResolvedValue({ service: 'ungate', pid: 1234, version: '1.7.14', protocolVersion: 3 })
}));

vi.mock('../../src/utils/cross-process-lock', () => ({ CrossProcessLock: { acquire: () => Promise.resolve(() => {}) } }));

vi.mock('vscode', () => {
	return {
		workspace: { getConfiguration: () => ({ inspect: () => undefined }) },
		ExtensionMode: {
			Development: 1,
			Production: 2
		}
	};
});

const isApiStartSuppressedMock = vi.fn<() => boolean>(() => false);
const suppressApiAutoStartMock = vi.fn<() => Promise<void>>(() => Promise.resolve());
const resetApiForRestartMock = vi.fn<() => Promise<void>>(() => Promise.resolve());

vi.mock('../../src/runtime-state', () => {
	return {
		RuntimeStateStore: {
			read: runtimeReadMock,
			getLiveClientIds: (state: RuntimeState) => Object.keys(state.clients),
			hasLiveClients: runtimeHasLiveClientsMock,
			mutate: runtimeMutateMock,
			isApiStartSuppressed: (...args: unknown[]) => isApiStartSuppressedMock(...args),
			suppressApiAutoStart: (...args: unknown[]) => suppressApiAutoStartMock(...args),
			resetApiForRestart: (...args: unknown[]) => resetApiForRestartMock(...args)
		}
	};
});

interface ApiServerInternals {
	port: number | null;
	process: null;
	lastStatus: 'starting' | 'running' | 'stopped' | 'error' | null;
	restartInProgress: boolean;
	shutDownDeliberately: boolean;
	startPromise: Promise<void> | null;
	runHealthCheckCycle(): Promise<void>;
	onExit(code: number | null, signal: NodeJS.Signals | null): void;
	spawn(): void;
	ensureNativeDeps(): Promise<void>;
	checkPortHealth(port: number): Promise<boolean>;
	isPortListening(port: number): Promise<boolean>;
	stopAuthenticatedApiProcess(port: number): Promise<void>;
	startHealthCheck(): void;
	shouldRespawn(): boolean;
	stopLocked(): Promise<void>;
	startLocked(): Promise<void>;
}

function createRuntimeState(windowIds: string[] = [], port: number | null = 4783): RuntimeState {
	const runtimeState = TestHelper.createRuntimeState(windowIds, port);

	return runtimeState;
}

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function getInternals(server: InstanceType<typeof ApiServer>): ApiServerInternals {
	return server as unknown as ApiServerInternals;
}

function createServer(options?: { isLeaderWindow?: boolean; isExtensionHostActive?: boolean }): {
	server: InstanceType<typeof ApiServer>;
	onStatusChange: ReturnType<typeof vi.fn>;
	onPortDetected: ReturnType<typeof vi.fn>;
	onLog: ReturnType<typeof vi.fn>;
} {
	const onStatusChange = vi.fn();
	const onPortDetected = vi.fn();
	const onLog = vi.fn();
	const server = new ApiServer(
		{
			extensionMode: 1,
			extensionPath: '/tmp/ungate-extension'
		} as never,
		{
			onLog,
			onPortDetected,
			onStatusChange,
			isLeaderWindow() {
				return options?.isLeaderWindow ?? true;
			},
			isExtensionHostActive() {
				return options?.isExtensionHostActive ?? true;
			},
			getWindowId() {
				return 'test-window';
			}
		}
	);

	return { server, onStatusChange, onPortDetected, onLog };
}

describe('ApiServer.runHealthCheckCycle', () => {
	beforeEach(() => {
		runtimeReadMock.mockReset();
		runtimeHasLiveClientsMock.mockReset();
		runtimeMutateMock.mockReset();
		isApiStartSuppressedMock.mockReset();
		isApiStartSuppressedMock.mockReturnValue(false);
		suppressApiAutoStartMock.mockReset();
		resetApiForRestartMock.mockReset();
		sleepMock.mockReset();
		sleepMock.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 1)));
		ensureInstalledMock.mockReset();
		spawnSyncMock.mockReset();
		spawnSyncMock.mockReturnValue({
			error: undefined,
			status: 0,
			stdout: JSON.stringify({
				version: '24.22.1',
				napi: 10,
				abi: '137',
				platform: process.platform,
				arch: process.arch,
				execPath: process.execPath
			}),
			stderr: ''
		});
		ensureInstalledMock.mockResolvedValue(undefined);
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it('does not mark attached running api as stopped after a transient health-check failure', async () => {
		const runtimeState = createRuntimeState();
		const { server, onStatusChange } = createServer();
		const internals = getInternals(server);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeHasLiveClientsMock.mockReturnValue(false);
		runtimeMutateMock.mockImplementation((mutator) => {
			const nextState = mutator(structuredClone(runtimeState));

			return Promise.resolve(nextState);
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(() => {
				return Promise.reject(new Error('temporary network failure'));
			})
		);

		Object.assign(internals, {
			port: 4783,
			lastStatus: 'running',
			process: null
		});

		await internals.runHealthCheckCycle();

		expect(onStatusChange).not.toHaveBeenCalledWith('stopped');
	});

	it('attaches to an existing healthy api without spawning a new process', async () => {
		const runtimeState = createRuntimeState();
		const { server, onPortDetected, onStatusChange } = createServer();
		const internals = getInternals(server);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeMutateMock.mockImplementation((mutator) => {
			const nextState = mutator(structuredClone(runtimeState));

			return Promise.resolve(nextState);
		});
		const spawnSpy = vi.spyOn(internals, 'spawn').mockImplementation(() => {
			Object.assign(internals, { port: 4783, process: {} });
		});
		vi.spyOn(internals, 'checkPortHealth').mockResolvedValue(true);
		vi.spyOn(internals, 'checkPortHealth').mockResolvedValue(true);
		vi.spyOn(internals, 'startHealthCheck').mockImplementation(() => {});

		await server.start();

		expect(spawnSpy).not.toHaveBeenCalled();
		expect(onPortDetected).toHaveBeenCalledWith(4783);
		expect(onStatusChange).toHaveBeenCalledWith('running');
	});

	it('does not spawn a second process when start is called again during local startup', async () => {
		const runtimeState = createRuntimeState();
		const { server } = createServer();
		const internals = getInternals(server);
		runtimeReadMock.mockReturnValue(runtimeState);
		const spawnSpy = vi.spyOn(internals, 'spawn').mockImplementation(() => {
			Object.assign(internals, { port: 4783, process: {} });
		});
		vi.spyOn(internals, 'checkPortHealth').mockResolvedValue(true);

		Object.assign(internals, {
			process: {}
		});

		await server.start();

		expect(spawnSpy).not.toHaveBeenCalled();
	});

	it('passes the installed better-sqlite3 binary path to the api process', async () => {
		const runtimeState = createRuntimeState([], null);
		const { server } = createServer();
		const internals = getInternals(server);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeMutateMock.mockImplementation((mutator) => {
			const nextState = mutator(structuredClone(runtimeState));

			return Promise.resolve(nextState);
		});

		vi.spyOn(internals, 'startHealthCheck').mockImplementation(() => {});

		ensureInstalledMock.mockImplementation(() => {
			Object.assign(internals, { port: 4783 });

			return Promise.resolve();
		});
		vi.spyOn(internals, 'checkPortHealth').mockResolvedValue(true);
		await server.start();

		expect(spawnMock).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(Array),
			expect.objectContaining({
				env: expect.objectContaining({
					UNGATE_BETTER_SQLITE3_NATIVE_BINDING: expect.stringContaining('prebuilds/linux-x64.node')
				})
			})
		);
	});

	it('retries startup when shared starting state is stale', async () => {
		const runtimeState = createRuntimeState([], null);
		const { server } = createServer();
		const internals = getInternals(server);
		runtimeState.api.status = 'starting';
		runtimeState.api.ownerWindowId = 'other-window';
		runtimeState.api.lastSeenAt = Date.now() - 15000;
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeMutateMock.mockImplementation((mutator) => {
			const nextState = mutator(structuredClone(runtimeState));

			return Promise.resolve(nextState);
		});
		const spawnSpy = vi.spyOn(internals, 'spawn').mockImplementation(() => {
			Object.assign(internals, { port: 4783, process: {} });
		});
		vi.spyOn(internals, 'checkPortHealth').mockResolvedValue(true);

		await server.start();

		expect(ensureInstalledMock).toHaveBeenCalledTimes(1);
		expect(spawnSpy).toHaveBeenCalledTimes(1);
	});

	it('deduplicates parallel start calls while native deps are pending', async () => {
		const runtimeState = createRuntimeState([], null);
		const { server } = createServer();
		const internals = getInternals(server);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeMutateMock.mockImplementation((mutator) => {
			const nextState = mutator(structuredClone(runtimeState));

			return Promise.resolve(nextState);
		});

		let releaseNative: (() => void) | undefined;
		ensureInstalledMock.mockImplementation(() => {
			return new Promise<void>((resolve) => {
				releaseNative = resolve;
			});
		});

		const spawnSpy = vi.spyOn(internals, 'spawn').mockImplementation(() => {
			Object.assign(internals, { port: 4783, process: {} });
		});
		vi.spyOn(internals, 'checkPortHealth').mockResolvedValue(true);

		const first = server.start();
		const second = server.start();

		expect(server.isStartupInProgress()).toBe(true);

		await vi.waitFor(() => {
			expect(ensureInstalledMock).toHaveBeenCalledTimes(1);
		});
		expect(spawnSpy).not.toHaveBeenCalled();

		releaseNative?.();
		await Promise.all([first, second]);

		expect(spawnSpy).toHaveBeenCalledTimes(1);
	});

	it('does not retry start automatically after native dependency installation fails', async () => {
		const runtimeState = createRuntimeState([], null);
		const { server } = createServer();
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeMutateMock.mockImplementation((mutator) => {
			const nextState = mutator(structuredClone(runtimeState));

			return Promise.resolve(nextState);
		});
		ensureInstalledMock.mockRejectedValue(new Error('[native] better-sqlite3 prebuilt installation failed'));

		await expect(server.start()).rejects.toThrow('[native] better-sqlite3 prebuilt installation failed');
		expect(suppressApiAutoStartMock).toHaveBeenCalled();
		ensureInstalledMock.mockClear();
		isApiStartSuppressedMock.mockReturnValue(true);

		await server.start();

		expect(ensureInstalledMock).not.toHaveBeenCalled();
	});

	it('does not stop api before the no-clients grace period elapses', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);

		const runtimeState = createRuntimeState();
		const { server } = createServer({ isExtensionHostActive: false });
		const internals = getInternals(server);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeHasLiveClientsMock.mockReturnValue(false);
		runtimeMutateMock.mockImplementation((mutator) => {
			const nextState = mutator(structuredClone(runtimeState));

			return Promise.resolve(nextState);
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(() => {
				return Promise.resolve({ ok: true });
			})
		);
		const stopSpy = vi.spyOn(server, 'stop').mockResolvedValue(undefined);

		Object.assign(internals, {
			port: 4783,
			lastStatus: 'running',
			process: null
		});

		await internals.runHealthCheckCycle();
		vi.setSystemTime(2500);
		await internals.runHealthCheckCycle();

		expect(stopSpy).not.toHaveBeenCalled();
	});

	it('stops api after the no-clients grace period elapses', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);

		const runtimeState = createRuntimeState();
		const { server } = createServer({ isExtensionHostActive: false });
		const internals = getInternals(server);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeHasLiveClientsMock.mockReturnValue(false);
		runtimeMutateMock.mockImplementation((mutator) => {
			const nextState = mutator(structuredClone(runtimeState));

			return Promise.resolve(nextState);
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(() => {
				return Promise.resolve({ ok: true });
			})
		);
		const stopSpy = vi.spyOn(server, 'stop').mockResolvedValue(undefined);

		Object.assign(internals, {
			port: 4783,
			lastStatus: 'running',
			process: null
		});

		await internals.runHealthCheckCycle();
		vi.setSystemTime(3001);
		await internals.runHealthCheckCycle();

		expect(stopSpy).toHaveBeenCalledTimes(1);
	});

	it('does not stop api when extension host is still active', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);

		const runtimeState = createRuntimeState();
		const { server } = createServer({ isExtensionHostActive: true });
		const internals = getInternals(server);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeHasLiveClientsMock.mockReturnValue(false);
		runtimeMutateMock.mockImplementation((mutator) => {
			const nextState = mutator(structuredClone(runtimeState));

			return Promise.resolve(nextState);
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(() => {
				return Promise.resolve({ ok: true });
			})
		);
		const stopSpy = vi.spyOn(server, 'stop').mockResolvedValue(undefined);

		Object.assign(internals, {
			port: 4783,
			lastStatus: 'running',
			process: null
		});

		vi.setSystemTime(5000);
		await internals.runHealthCheckCycle();

		expect(stopSpy).not.toHaveBeenCalled();
	});
});

describe('ApiServer.onExit', () => {
	beforeEach(() => {
		sleepMock.mockReset();
		sleepMock.mockResolvedValue(undefined);
		ensureInstalledMock.mockReset();
		ensureInstalledMock.mockResolvedValue(undefined);
		runtimeMutateMock.mockImplementation((mutator) => {
			const nextState = mutator(createRuntimeState());

			return Promise.resolve(nextState);
		});
	});

	it('performs an explicit stop, reset, and start during restart', async () => {
		const { server } = createServer();
		const internals = getInternals(server);
		const stopSpy = vi.spyOn(internals, 'stopLocked').mockResolvedValue(undefined);
		const startSpy = vi.spyOn(internals, 'startLocked').mockResolvedValue(undefined);
		runtimeReadMock.mockReturnValue(createRuntimeState([], null));

		await server.restart();

		expect(stopSpy).toHaveBeenCalledTimes(1);
		expect(resetApiForRestartMock).toHaveBeenCalledTimes(1);
		expect(startSpy).toHaveBeenCalledTimes(1);
		expect(internals.restartInProgress).toBe(false);
	});

	it('waits for the old listener to release its port before restarting', async () => {
		const runtimeState = createRuntimeState([], 4783);
		runtimeState.api.pid = 1234;
		const { server } = createServer();
		const internals = getInternals(server);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeMutateMock.mockImplementation((mutator) => Promise.resolve(mutator(structuredClone(runtimeState))));
		vi.spyOn(internals, 'checkPortHealth').mockResolvedValue(true);
		const listenerSpy = vi.spyOn(internals, 'isPortListening').mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

		await internals.stopLocked();

		expect(listenerSpy).toHaveBeenCalledTimes(2);
		expect(resetApiForRestartMock).not.toHaveBeenCalled();
	});

	it('terminates the same authenticated api when graceful shutdown does not release the port', async () => {
		const runtimeState = createRuntimeState([], 4783);
		const { server, onLog } = createServer();
		const internals = getInternals(server);
		runtimeReadMock.mockReturnValue(runtimeState);
		vi.mocked(readApiHealth).mockResolvedValue({ service: 'ungate', pid: 1234, version: '1.7.14', protocolVersion: 3 });
		const listenerSpy = vi.spyOn(internals, 'isPortListening').mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);

		await internals.stopAuthenticatedApiProcess(4783);

		expect(killSpy).toHaveBeenCalledWith(expect.any(Number), 'SIGTERM');
		expect(listenerSpy).toHaveBeenCalledTimes(2);
		expect(onLog).toHaveBeenCalledWith('warn', expect.stringContaining('terminating authenticated api'));
	});

	it('does not respawn after a deliberate shutdown', () => {
		const { server } = createServer();
		const internals = getInternals(server);
		const spawnSpy = vi.spyOn(internals, 'spawn').mockImplementation(() => {
			Object.assign(internals, { port: 4783, process: {} });
		});
		vi.spyOn(internals, 'checkPortHealth').mockResolvedValue(true);

		Object.assign(internals, {
			shutDownDeliberately: true,
			process: null
		});

		internals.onExit(0, null);

		expect(spawnSpy).not.toHaveBeenCalled();
	});

	it('uses the locked startup path after a clean exit', async () => {
		const { server } = createServer();
		const internals = getInternals(server);
		const startSpy = vi.spyOn(server, 'start').mockResolvedValue(undefined);
		vi.spyOn(internals, 'checkPortHealth').mockResolvedValue(true);

		Object.assign(internals, {
			shutDownDeliberately: false,
			process: null
		});

		internals.onExit(0, null);
		await flushPromises();

		expect(startSpy).toHaveBeenCalledTimes(1);
		expect(sleepMock).toHaveBeenCalledTimes(1);
	});

	it('marks status as error after a non-zero exit', async () => {
		const runtimeState = createRuntimeState();
		const { server, onStatusChange } = createServer();
		const internals = getInternals(server);
		runtimeMutateMock.mockImplementation((mutator) => {
			const nextState = mutator(structuredClone(runtimeState));

			return Promise.resolve(nextState);
		});

		Object.assign(internals, {
			shutDownDeliberately: false,
			process: null
		});

		internals.onExit(1, null);
		await flushPromises();

		expect(onStatusChange).toHaveBeenCalledWith('error');
	});

	it('does not respawn after a clean exit when extension host is inactive', async () => {
		const { server } = createServer({ isExtensionHostActive: false });
		const internals = getInternals(server);
		const spawnSpy = vi.spyOn(internals, 'spawn').mockImplementation(() => {
			Object.assign(internals, { port: 4783, process: {} });
		});
		vi.spyOn(internals, 'checkPortHealth').mockResolvedValue(true);

		Object.assign(internals, {
			shutDownDeliberately: false,
			process: null
		});

		internals.onExit(0, null);
		await flushPromises();

		expect(spawnSpy).not.toHaveBeenCalled();
	});

	it('attaches to an already running api after EADDRINUSE instead of staying in error', async () => {
		const runtimeState = createRuntimeState();
		const { server, onPortDetected, onStatusChange } = createServer();
		const internals = getInternals(server);
		runtimeMutateMock.mockImplementation((mutator) => {
			const nextState = mutator(structuredClone(runtimeState));

			return Promise.resolve(nextState);
		});
		vi.spyOn(internals, 'checkPortHealth').mockResolvedValue(true);
		vi.spyOn(internals, 'startHealthCheck').mockImplementation(() => {});

		Object.assign(internals, {
			addressInUsePort: 47821,
			process: null,
			shutDownDeliberately: false
		});

		internals.onExit(1, null);
		await vi.waitFor(() => expect(onStatusChange).toHaveBeenCalledWith('running'));

		expect(onPortDetected).toHaveBeenCalledWith(47821);
		expect(onStatusChange).toHaveBeenCalledWith('running');
		expect(onStatusChange).not.toHaveBeenCalledWith('error');
	});
});
