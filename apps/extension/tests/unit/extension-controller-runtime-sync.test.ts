import { type RuntimeState, type TunnelState } from '@ungate/shared/frontend';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { TestHelper } from './helpers/test-helper';

import type { ExtensionController as ExtensionControllerType } from '../../src/extension-controller';

interface MockApiServer {
	start: ReturnType<typeof vi.fn>;
	stop: ReturnType<typeof vi.fn>;
	detach: ReturnType<typeof vi.fn>;
	restart: ReturnType<typeof vi.fn>;
	getPort: ReturnType<typeof vi.fn>;
	isStartupInProgress: ReturnType<typeof vi.fn>;
	syncLeaderHealthMonitor: ReturnType<typeof vi.fn>;
}

interface MockTunnelManager {
	syncMonitor: ReturnType<typeof vi.fn>;
	reconcile: ReturnType<typeof vi.fn>;
	start: ReturnType<typeof vi.fn>;
	stop: ReturnType<typeof vi.fn>;
	restart: ReturnType<typeof vi.fn>;
}

interface MockDashboard {
	setPort: ReturnType<typeof vi.fn>;
	sendTunnelState: ReturnType<typeof vi.fn>;
	pushLog: ReturnType<typeof vi.fn>;
	sendServiceState: ReturnType<typeof vi.fn>;
	show: ReturnType<typeof vi.fn>;
}

interface ExtensionControllerInternals {
	currentPort: number | null;
	bootstrapRuntime(): Promise<void>;
	syncFromRuntimeState(): Promise<void>;
	startApiAsLeaderIfNeeded(runtimeState: RuntimeState): void;
	updateStatusBar(): void;
}

const createOutputChannelMock = vi.fn(() => {
	return {
		appendLine: vi.fn(),
		dispose: vi.fn()
	};
});
const createStatusBarItemMock = vi.fn(() => {
	return {
		command: '',
		text: '',
		tooltip: '',
		show: vi.fn(),
		dispose: vi.fn()
	};
});
type MockStatusBarItem = ReturnType<typeof createStatusBarItemMock>;
const registerCommandMock = vi.fn(() => {
	return {
		dispose: vi.fn()
	};
});
const showWarningMessageMock = vi.fn();

const runtimeReadMock = vi.fn<() => RuntimeState>();
const runtimeHasLiveClientsMock = vi.fn<(state: RuntimeState) => boolean>();
const runtimeGetLiveClientIdsMock = vi.fn<(state: RuntimeState) => string[]>();
const runtimeTouchClientMock = vi.fn<(windowId: string) => Promise<RuntimeState>>();
const runtimeRemoveClientMock = vi.fn<(windowId: string) => Promise<RuntimeState>>();
const runtimeGetLeaderWindowIdMock = vi.fn<(state: RuntimeState) => string | null>();
const runtimeReconcileOrphanedTunnelMock = vi.fn<(state?: RuntimeState) => Promise<RuntimeState>>();
const prepareApiForBootstrapMock = vi.fn(() => Promise.resolve(runtimeReadMock()));

const apiServerStartMock = vi.fn().mockResolvedValue(undefined);
const apiServerStopMock = vi.fn().mockResolvedValue(undefined);
const apiServerRestartMock = vi.fn().mockResolvedValue(undefined);
const apiServerGetPortMock = vi.fn().mockReturnValue(null);
const apiServerIsStartupInProgressMock = vi.fn().mockReturnValue(false);
const apiServerSyncLeaderHealthMonitorMock = vi.fn();

vi.mock('vscode', () => {
	return {
		window: {
			createOutputChannel: createOutputChannelMock,
			createStatusBarItem: createStatusBarItemMock,
			showWarningMessage: showWarningMessageMock
		},
		workspace: {
			createFileSystemWatcher: vi.fn(() => ({
				onDidChange: vi.fn(),
				onDidCreate: vi.fn(),
				dispose: vi.fn()
			}))
		},
		commands: {
			registerCommand: registerCommandMock
		},
		StatusBarAlignment: {
			Right: 1
		},
		ThemeColor: class {
			constructor(public readonly id: string) {}
		},
		Uri: {
			file: (value: string) => ({ fsPath: value })
		},
		RelativePattern: class {
			constructor(
				public readonly base: unknown,
				public readonly pattern: string
			) {}
		},
		MarkdownString: TestHelper.createMarkdownStringClass()
	};
});

vi.mock('../../src/local-api', () => ({
	readApiHealth: vi.fn().mockResolvedValue({
		service: 'ungate',
		pid: 1234,
		version: '1.7.14',
		protocolVersion: 3
	}),
	readAppSettings: vi.fn().mockResolvedValue({ models: [] })
}));

vi.mock('../../src/runtime-state', () => {
	return {
		RuntimeStateStore: {
			read: runtimeReadMock,
			hasLiveClients: runtimeHasLiveClientsMock,
			getLiveClientIds: runtimeGetLiveClientIdsMock,
			touchClient: runtimeTouchClientMock,
			removeClient: runtimeRemoveClientMock,
			getLeaderWindowId: runtimeGetLeaderWindowIdMock,
			reconcileOrphanedTunnel: runtimeReconcileOrphanedTunnelMock,
			isApiStartSuppressed: (state?: RuntimeState) => {
				const runtimeState = state ?? runtimeReadMock();

				return runtimeState.api.startSuppressed === true;
			},
			prepareApiForBootstrap: (...args: unknown[]) => prepareApiForBootstrapMock(...args)
		}
	};
});

vi.mock('../../src/dashboard', () => {
	return {
		Dashboard: class {
			sendServiceState = vi.fn();
			pushLog = vi.fn();
			setPort = vi.fn();
			sendTunnelState = vi.fn();
			show = vi.fn();
		}
	};
});

vi.mock('../../src/tunnel-manager', () => {
	return {
		TunnelManager: class {
			syncMonitor = vi.fn();
			reconcile = vi.fn(() => Promise.resolve());
			start = vi.fn();
			stop = vi.fn();
			restart = vi.fn();
		}
	};
});

vi.mock('../../src/utils/cross-process-lock', () => ({ CrossProcessLock: { acquire: () => Promise.resolve(() => {}) } }));

vi.mock('../../src/api-server', () => {
	return {
		ApiServer: class {
			detach = vi.fn();
			start = apiServerStartMock;
			stop = apiServerStopMock;
			restart = apiServerRestartMock;
			getPort = apiServerGetPortMock;
			isStartupInProgress = apiServerIsStartupInProgressMock;
			syncLeaderHealthMonitor = apiServerSyncLeaderHealthMonitorMock;
		}
	};
});

let ExtensionController: typeof import('../../src/extension-controller').ExtensionController;

function createRuntimeState(windowIds: string[], apiPort: number | null = 4783): RuntimeState {
	const runtimeState = TestHelper.createRuntimeState(windowIds, apiPort);

	return runtimeState;
}

function createContext() {
	return {
		subscriptions: [],
		extensionPath: '/tmp/ungate-extension'
	};
}

function createController(windowId: string): {
	controller: ExtensionControllerType;
	apiServer: MockApiServer;
	tunnelManager: MockTunnelManager;
	dashboard: MockDashboard;
	statusBar: {
		text: string;
		tooltip: string;
		backgroundColor?: unknown;
		accessibilityInformation?: { label: string };
		show: ReturnType<typeof vi.fn>;
	};
} {
	const controller = new ExtensionController(createContext() as never);
	const apiServer: MockApiServer = {
		detach: vi.fn(),
		start: vi.fn().mockResolvedValue(undefined),
		stop: vi.fn().mockResolvedValue(undefined),
		restart: vi.fn().mockResolvedValue(undefined),
		getPort: vi.fn().mockReturnValue(null),
		isStartupInProgress: vi.fn().mockReturnValue(false),
		syncLeaderHealthMonitor: vi.fn()
	};
	const tunnelManager: MockTunnelManager = {
		reconcile: vi.fn().mockResolvedValue(undefined),
		syncMonitor: vi.fn(),
		start: vi.fn().mockResolvedValue(undefined),
		stop: vi.fn(),
		restart: vi.fn().mockResolvedValue(undefined)
	};
	const dashboard: MockDashboard = {
		setPort: vi.fn(),
		sendTunnelState: vi.fn(),
		pushLog: vi.fn(),
		sendServiceState: vi.fn(),
		show: vi.fn()
	};
	const statusBar = {
		text: '',
		tooltip: '',
		backgroundColor: undefined,
		accessibilityInformation: undefined,
		show: vi.fn()
	};
	const currentTunnelState: TunnelState = {
		status: 'stopped',
		url: null,
		error: null
	};

	Object.assign(controller as object, {
		windowId,
		apiServer,
		tunnelManager,
		dashboard,
		statusBar,
		currentTunnelState,
		currentPort: null,
		lastApiStatus: null,
		lastApiError: null,
		lastConnectionStatus: null,
		statusBarWarningTimer: null,
		extensionHostActive: true,
		heartbeatTimer: null,
		syncTimer: null
	});

	return { controller, apiServer, tunnelManager, dashboard, statusBar };
}

function getInternals(controller: ExtensionControllerType): ExtensionControllerInternals {
	return controller as unknown as ExtensionControllerInternals;
}

describe('ExtensionController', () => {
	beforeAll(async () => {
		const module = await import('../../src/extension-controller');
		ExtensionController = module.ExtensionController;
	});

	beforeEach(() => {
		createOutputChannelMock.mockClear();
		createStatusBarItemMock.mockClear();
		registerCommandMock.mockClear();
		showWarningMessageMock.mockReset();
		runtimeReadMock.mockReset();
		runtimeHasLiveClientsMock.mockReset();
		runtimeGetLiveClientIdsMock.mockReset();
		runtimeTouchClientMock.mockReset();
		runtimeRemoveClientMock.mockReset();
		runtimeRemoveClientMock.mockResolvedValue(createRuntimeState([], null));
		runtimeGetLeaderWindowIdMock.mockReset();
		runtimeReconcileOrphanedTunnelMock.mockReset();
		runtimeReconcileOrphanedTunnelMock.mockImplementation((state) => {
			return Promise.resolve(state ?? runtimeReadMock());
		});
		prepareApiForBootstrapMock.mockReset();
		prepareApiForBootstrapMock.mockImplementation(() => {
			const runtimeState = runtimeReadMock();
			runtimeState.api.startSuppressed = false;
			runtimeState.api.status = 'stopped';
			runtimeState.api.lastError = null;
			runtimeReadMock.mockReturnValue(runtimeState);

			return Promise.resolve(runtimeState);
		});
		apiServerStartMock.mockClear();
		apiServerStopMock.mockClear();
		apiServerRestartMock.mockClear();
		apiServerGetPortMock.mockClear();
		apiServerIsStartupInProgressMock.mockClear();
		apiServerIsStartupInProgressMock.mockReturnValue(false);
		apiServerSyncLeaderHealthMonitorMock.mockClear();
		apiServerGetPortMock.mockReturnValue(null);
		apiServerStartMock.mockResolvedValue(undefined);
	});

	it('warns once only when a confirmed ready connection becomes offline', () => {
		vi.useFakeTimers();
		try {
			const { controller, statusBar } = createController('window-a');
			const internals = getInternals(controller);

			Object.assign(controller as object, {
				currentPort: 4783,
				lastApiStatus: 'running',
				currentTunnelState: {
					status: 'running',
					url: 'https://example.trycloudflare.com',
					error: null,
					publicStatus: 'reachable'
				}
			});
			internals.updateStatusBar();

			Object.assign(controller as object, {
				currentTunnelState: {
					status: 'running',
					url: 'https://example.trycloudflare.com',
					error: null,
					publicStatus: 'unreachable',
					publicError: 'Public health check timed out.'
				}
			});
			internals.updateStatusBar();
			internals.updateStatusBar();

			expect(showWarningMessageMock).toHaveBeenCalledTimes(1);
			expect(showWarningMessageMock).toHaveBeenCalledWith('Ungate tunnel is unavailable. Custom Ungate models may fail.');
			expect(statusBar.text).toBe('$(warning) Ungate: Offline');
			expect(statusBar.backgroundColor).toMatchObject({ id: 'statusBarItem.warningBackground' });

			vi.advanceTimersByTime(8000);
			expect(statusBar.backgroundColor).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not warn during startup, initial offline state, or a reconnect check', () => {
		const { controller, statusBar } = createController('window-a');
		const internals = getInternals(controller);

		internals.updateStatusBar();
		Object.assign(controller as object, {
			lastApiStatus: 'starting',
			currentTunnelState: { status: 'starting', url: null, error: null }
		});
		internals.updateStatusBar();
		Object.assign(controller as object, {
			lastApiStatus: 'running',
			currentTunnelState: {
				status: 'running',
				url: 'https://example.trycloudflare.com',
				error: null,
				publicStatus: 'checking'
			}
		});
		internals.updateStatusBar();

		expect(showWarningMessageMock).not.toHaveBeenCalled();
		expect(statusBar.text).toBe('$(sync~spin) Ungate: Connecting');
	});

	it('starts the api on activate bootstrap when leader has no port', async () => {
		const { controller } = createController('window-a');
		const runtimeState = createRuntimeState(['window-a', 'window-b'], null);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeHasLiveClientsMock.mockReturnValue(true);
		runtimeGetLiveClientIdsMock.mockReturnValue(['window-a']);
		runtimeTouchClientMock.mockResolvedValue(runtimeState);
		runtimeGetLeaderWindowIdMock.mockReturnValue('window-a');

		Object.assign(controller as object, {
			startHeartbeat: vi.fn(),
			startRuntimeSync: vi.fn()
		});

		controller.activate();
		const activatedStatusBar = createStatusBarItemMock.mock.results[0]?.value as MockStatusBarItem | undefined;

		expect(createStatusBarItemMock).toHaveBeenCalledWith('ungate.connectionStatus', 1, 100);
		expect(activatedStatusBar?.show).toHaveBeenCalledTimes(1);
		expect(activatedStatusBar?.text).toBe('$(warning) Ungate: Offline');

		await vi.waitFor(() => {
			expect(apiServerStartMock).toHaveBeenCalledTimes(1);
		});
	});

	it('starts or attaches the API from periodic sync after leader handover', async () => {
		const { controller, apiServer } = createController('window-a');
		const runtimeState = createRuntimeState(['window-a'], null);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeGetLiveClientIdsMock.mockReturnValue(['window-a']);
		runtimeTouchClientMock.mockResolvedValue(runtimeState);
		runtimeGetLeaderWindowIdMock.mockReturnValue('window-a');

		await getInternals(controller).syncFromRuntimeState();

		expect(apiServer.start).toHaveBeenCalledTimes(1);
	});

	it('does not start api from sync while start is suppressed', async () => {
		const { controller } = createController('window-a');
		const runtimeState = createRuntimeState(['window-a'], null);
		runtimeState.api.startSuppressed = true;
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeGetLiveClientIdsMock.mockReturnValue(['window-a']);
		runtimeTouchClientMock.mockResolvedValue(runtimeState);
		runtimeGetLeaderWindowIdMock.mockReturnValue('window-a');

		await getInternals(controller).syncFromRuntimeState();

		expect(apiServerStartMock).not.toHaveBeenCalled();
	});

	it('bootstraps runtime sync immediately on activate', async () => {
		const { controller } = createController('window-a');
		const runtimeState = createRuntimeState(['window-a'], null);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeGetLiveClientIdsMock.mockReturnValue(['window-a']);
		runtimeTouchClientMock.mockResolvedValue(runtimeState);
		runtimeGetLeaderWindowIdMock.mockReturnValue('window-a');

		Object.assign(controller as object, {
			startHeartbeat: vi.fn(),
			startRuntimeSync: vi.fn()
		});

		controller.activate();

		await vi.waitFor(() => {
			expect(apiServerStartMock).toHaveBeenCalledTimes(1);
			expect(runtimeTouchClientMock).toHaveBeenCalled();
		});
	});

	it('does not stop api when current window is not leader', async () => {
		const { controller, apiServer, tunnelManager } = createController('window-b');
		const runtimeState = createRuntimeState(['window-a', 'window-b'], null);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeHasLiveClientsMock.mockReturnValue(true);
		runtimeGetLeaderWindowIdMock.mockReturnValue('window-a');

		await controller.stopBackendServices();

		expect(apiServer.stop).not.toHaveBeenCalled();
		expect(tunnelManager.stop).not.toHaveBeenCalled();
	});

	it('keeps shared API alive when the owner window closes', async () => {
		const { controller, apiServer } = createController('window-a');
		const runtimeState = createRuntimeState(['window-a', 'window-b'], null);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeHasLiveClientsMock.mockReturnValue(true);
		runtimeGetLeaderWindowIdMock.mockReturnValue('window-a');

		await controller.stopBackendServices();

		expect(apiServer.stop).not.toHaveBeenCalled();
		expect(apiServer.detach).toHaveBeenCalledTimes(1);
	});

	it('detaches tunnel monitoring while preserving a tunnel for extension reload', async () => {
		const { controller, tunnelManager } = createController('window-a');
		const runtimeState = createRuntimeState(['window-a'], null);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeHasLiveClientsMock.mockReturnValue(false);
		runtimeGetLeaderWindowIdMock.mockReturnValue('window-a');

		await controller.stopBackendServices();

		expect(tunnelManager.stop).not.toHaveBeenCalled();
		expect(tunnelManager.syncMonitor).toHaveBeenCalledWith(false);
	});

	it('removes the current client from runtime state during shutdown', async () => {
		const { controller } = createController('window-a');
		const runtimeState = createRuntimeState(['window-a'], null);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeHasLiveClientsMock.mockReturnValue(false);
		runtimeGetLeaderWindowIdMock.mockReturnValue('window-a');
		runtimeRemoveClientMock.mockResolvedValue(createRuntimeState([], null));

		await controller.stopBackendServices();

		expect(runtimeRemoveClientMock).toHaveBeenCalledWith('window-a');
	});

	it('touches the current client when it is missing from live clients', async () => {
		const { controller, apiServer } = createController('window-b');
		const internals = getInternals(controller);
		const runtimeState = createRuntimeState(['window-a']);
		const touchedState = createRuntimeState(['window-a', 'window-b']);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeGetLiveClientIdsMock.mockImplementation((state) => {
			return Object.keys(state.clients);
		});
		runtimeTouchClientMock.mockResolvedValue(touchedState);
		runtimeGetLeaderWindowIdMock.mockReturnValue('window-a');

		await internals.syncFromRuntimeState();

		expect(runtimeTouchClientMock).toHaveBeenCalledWith('window-b');
		expect(apiServer.syncLeaderHealthMonitor).toHaveBeenCalledWith(false);
	});

	it('starts the api on bootstrap when the current window is the leader', async () => {
		const { controller, apiServer } = createController('window-a');
		const internals = getInternals(controller);
		const runtimeState = createRuntimeState(['window-a'], null);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeGetLiveClientIdsMock.mockReturnValue(['window-a']);
		runtimeTouchClientMock.mockResolvedValue(runtimeState);
		runtimeGetLeaderWindowIdMock.mockReturnValue('window-a');
		apiServer.getPort.mockReturnValue(null);

		await internals.bootstrapRuntime();

		expect(apiServer.start).toHaveBeenCalledTimes(1);
	});

	it('does not start the api when the current window is not the leader', async () => {
		const { controller, apiServer } = createController('window-b');
		const internals = getInternals(controller);
		const runtimeState = createRuntimeState(['window-a', 'window-b'], null);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeGetLiveClientIdsMock.mockReturnValue(['window-a', 'window-b']);
		runtimeGetLeaderWindowIdMock.mockReturnValue('window-a');
		apiServer.getPort.mockReturnValue(null);

		await internals.syncFromRuntimeState();

		expect(apiServer.start).not.toHaveBeenCalled();
		expect(apiServer.syncLeaderHealthMonitor).toHaveBeenCalledWith(false);
	});

	it('does not start the api when the leader already has a local port', async () => {
		const { controller, apiServer } = createController('window-a');
		const internals = getInternals(controller);
		const runtimeState = createRuntimeState(['window-a'], 4783);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeGetLiveClientIdsMock.mockReturnValue(['window-a']);
		runtimeGetLeaderWindowIdMock.mockReturnValue('window-a');
		apiServer.getPort.mockReturnValue(4783);

		await internals.syncFromRuntimeState();

		expect(apiServer.start).not.toHaveBeenCalled();
		expect(apiServer.syncLeaderHealthMonitor).toHaveBeenCalledWith(true);
	});

	it('does not start the api on bootstrap when startup is already in progress locally', async () => {
		const { controller, apiServer } = createController('window-a');
		const internals = getInternals(controller);
		const runtimeState = createRuntimeState(['window-a'], null);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeGetLiveClientIdsMock.mockReturnValue(['window-a']);
		runtimeTouchClientMock.mockResolvedValue(runtimeState);
		runtimeGetLeaderWindowIdMock.mockReturnValue('window-a');
		apiServer.getPort.mockReturnValue(null);
		apiServer.isStartupInProgress.mockReturnValue(true);

		await internals.bootstrapRuntime();

		expect(apiServer.start).not.toHaveBeenCalled();
	});

	it('keeps the known local port when runtime state regresses to null', async () => {
		const { controller, apiServer, dashboard } = createController('window-a');
		const internals = getInternals(controller);
		const runtimeState = createRuntimeState(['window-a'], null);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeGetLiveClientIdsMock.mockReturnValue(['window-a']);
		runtimeGetLeaderWindowIdMock.mockReturnValue('window-a');
		apiServer.getPort.mockReturnValue(4783);

		internals.currentPort = 4783;

		await internals.syncFromRuntimeState();

		expect(dashboard.setPort).toHaveBeenCalledWith(4783);
		expect(internals.currentPort).toBe(4783);
	});

	it('uses reconciled stopped tunnel state without starting the tunnel', async () => {
		const { controller, tunnelManager, dashboard } = createController('window-a');
		const internals = getInternals(controller);
		const runtimeState = createRuntimeState(['window-a']);
		runtimeState.tunnel.status = 'running';
		runtimeState.tunnel.url = 'https://stale.trycloudflare.com';
		runtimeState.tunnel.ownerWindowId = 'dead-window';
		const reconciled = createRuntimeState(['window-a']);
		reconciled.tunnel.status = 'stopped';
		reconciled.tunnel.url = null;
		reconciled.tunnel.ownerWindowId = null;
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeGetLiveClientIdsMock.mockReturnValue(['window-a']);
		runtimeGetLeaderWindowIdMock.mockReturnValue('window-a');
		runtimeReconcileOrphanedTunnelMock.mockResolvedValue(reconciled);

		await internals.syncFromRuntimeState();

		expect(runtimeReconcileOrphanedTunnelMock).toHaveBeenCalledWith(runtimeState);
		expect(dashboard.sendTunnelState).toHaveBeenCalledWith({
			status: 'stopped',
			url: null,
			error: null,
			publicStatus: 'unchecked',
			publicCheckedAt: null,
			publicError: null,
			startedAt: null
		});
		expect(tunnelManager.start).not.toHaveBeenCalled();
		expect(tunnelManager.restart).not.toHaveBeenCalled();
	});
});
