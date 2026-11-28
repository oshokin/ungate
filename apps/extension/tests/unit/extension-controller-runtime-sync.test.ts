import { API_PROTOCOL_VERSION, UNGATE_VERSION, type RuntimeState, type TunnelState } from '@ungate/shared/frontend';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { TestHelper } from './helpers/test-helper';

import type { ExtensionController as ExtensionControllerType } from '../../src/extension-controller';

const installedDigest = vi.hoisted(() => vi.fn<() => string | undefined>(() => undefined));
vi.mock('../../src/api-artifact', () => ({ apiArtifactDigest: installedDigest }));

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
	selectProvider: ReturnType<typeof vi.fn>;
	getState: ReturnType<typeof vi.fn>;
	syncMonitor: ReturnType<typeof vi.fn>;
	reconcile: ReturnType<typeof vi.fn>;
	start: ReturnType<typeof vi.fn>;
	stop: ReturnType<typeof vi.fn>;
	restart: ReturnType<typeof vi.fn<(port: number, protocol: 'http2' | 'quic' | 'auto') => Promise<void>>>;
}

interface MockDashboard {
	sendUsageState: ReturnType<typeof vi.fn>;
	setPort: ReturnType<typeof vi.fn>;
	sendTunnelState: ReturnType<typeof vi.fn>;
	pushLog: ReturnType<typeof vi.fn>;
	sendServiceState: ReturnType<typeof vi.fn>;
	sendTunnelConfig: ReturnType<typeof vi.fn>;
	show: ReturnType<typeof vi.fn>;
}

interface ExtensionControllerInternals {
	runAction(action: import('@ungate/shared/frontend').DashboardAction): Promise<void>;
	setTunnelProvider(provider: 'quick' | 'ngrok'): Promise<void>;
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
		hide: vi.fn(),
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
const showErrorMessageMock = vi.fn();
const runtimeMutateMock = vi.fn<(mutator: (state: RuntimeState) => RuntimeState) => Promise<RuntimeState>>();
const executeCommandMock = vi.fn().mockResolvedValue(undefined);

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
			showWarningMessage: showWarningMessageMock,
			showErrorMessage: showErrorMessageMock
		},
		workspace: {
			getConfiguration: vi.fn(() => ({ inspect: vi.fn(() => undefined) })),
			onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
			createFileSystemWatcher: vi.fn(() => ({
				onDidChange: vi.fn(),
				onDidCreate: vi.fn(),
				dispose: vi.fn()
			}))
		},
		commands: {
			executeCommand: executeCommandMock,
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
		version: '1.7.15',
		protocolVersion: 3
	}),
	readAppSettings: vi.fn().mockResolvedValue({ models: [] }),
	readTunnelProtocol: vi.fn().mockResolvedValue('http2')
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
			prepareApiForBootstrap: prepareApiForBootstrapMock,
			mutate: runtimeMutateMock
		}
	};
});

vi.mock('../../src/dashboard', () => {
	return {
		Dashboard: class {
			sendUsageState = vi.fn();
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
			getState = vi.fn(() => ({ provider: null }));
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
		secrets: {
			get: vi.fn().mockResolvedValue(undefined),
			store: vi.fn().mockResolvedValue(undefined),
			onDidChange: vi.fn((_listener: (event: { key: string }) => void) => ({ dispose: vi.fn() }))
		},
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
		getState: vi.fn().mockReturnValue({ provider: null }),
		selectProvider: vi.fn(
			async (
				provider: 'quick' | 'ngrok',
				confirm: () => Promise<boolean>,
				protocol: (port: number) => Promise<'http2' | 'quic' | 'auto'>
			) => {
				const state = runtimeReadMock();
				if (state.tunnelProvider === provider) return;
				const live = ['running', 'starting', 'installing'].includes(state.tunnel.status);
				if (live) {
					const confirmed = await confirm();
					if (!confirmed) return;
				}
				if (live && provider === 'ngrok') {
					const token = await (controller as unknown as { ngrokToken: { read(): Promise<string | null> } }).ngrokToken.read();
					if (!token) throw new Error('Add an ngrok authtoken before starting the stable tunnel.');
				}
				state.tunnelProvider = provider;
				if (live && state.tunnel.port) await tunnelManager.restart(state.tunnel.port, await protocol(state.tunnel.port));
			}
		),
		reconcile: vi.fn().mockResolvedValue(undefined),
		syncMonitor: vi.fn(),
		start: vi.fn().mockResolvedValue(undefined),
		stop: vi.fn(),
		restart: vi.fn().mockResolvedValue(undefined)
	};
	const dashboard: MockDashboard = {
		sendUsageState: vi.fn(),
		setPort: vi.fn(),
		sendTunnelState: vi.fn(),
		pushLog: vi.fn(),
		sendServiceState: vi.fn(),
		sendTunnelConfig: vi.fn(),
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
	it('publishes the latest provider after an asynchronous secret read', async () => {
		const state = createRuntimeState(['window-a']);
		runtimeReadMock.mockReturnValue(state);
		const { controller, dashboard } = createController('window-a');
		let resolve!: (token: string) => void;
		Object.assign(controller, {
			ngrokToken: {
				read: () =>
					new Promise<string>((done) => {
						resolve = done;
					})
			}
		});
		const pending = (controller as unknown as { sendTunnelConfig(): Promise<void> }).sendTunnelConfig();
		state.tunnelProvider = 'ngrok';
		resolve('test-token');
		await pending;
		expect(dashboard.sendTunnelConfig).toHaveBeenLastCalledWith('ngrok', 'test-token');
	});

	it('invalidates cached dashboard secrets only for ngrok secret events', async () => {
		const context = createContext();
		const controller = new ExtensionController(context as never);
		const state = createRuntimeState(['window-a']);
		runtimeReadMock.mockReturnValue(state);
		Object.assign(controller, {
			startHeartbeat: vi.fn(),
			startRuntimeSync: vi.fn(),
			bootstrapRuntime: vi.fn().mockResolvedValue(undefined)
		});
		controller.activate();
		const callback = context.secrets.onDidChange.mock.calls[0][0];
		const dashboard = { sendTunnelConfig: vi.fn() };
		Object.assign(controller, { dashboard });
		const send = () => (controller as unknown as { sendTunnelConfig(): Promise<void> }).sendTunnelConfig();
		await send();
		await send();
		expect(context.secrets.get).toHaveBeenCalledTimes(1);
		callback({ key: 'unrelated' });
		await send();
		expect(context.secrets.get).toHaveBeenCalledTimes(1);
		context.secrets.get.mockResolvedValue('updated-token');
		callback({ key: 'ungate.ngrokAuthToken' });
		await send();
		expect(context.secrets.get).toHaveBeenCalledTimes(2);
		expect(dashboard.sendTunnelConfig).toHaveBeenLastCalledWith('quick', 'updated-token');
	});

	it('synchronizes another window provider selection without rereading unchanged secrets', async () => {
		const state = createRuntimeState(['follower']);
		runtimeReadMock.mockReturnValue(state);
		runtimeGetLiveClientIdsMock.mockReturnValue(['follower']);
		const { controller, dashboard } = createController('follower');
		const read = vi.fn().mockResolvedValue('masked-test-token');
		Object.assign(controller, { ngrokToken: { read } });

		await getInternals(controller).syncFromRuntimeState();
		await Promise.resolve();
		expect(dashboard.sendTunnelConfig).toHaveBeenLastCalledWith('quick', 'masked-test-token');
		state.tunnelProvider = 'ngrok';
		await getInternals(controller).syncFromRuntimeState();
		await Promise.resolve();
		expect(dashboard.sendTunnelConfig).toHaveBeenLastCalledWith('ngrok', 'masked-test-token');
		await getInternals(controller).syncFromRuntimeState();
		expect(read).toHaveBeenCalledTimes(1);
		expect(dashboard.sendTunnelConfig).toHaveBeenCalledTimes(2);
	});

	it.each([
		['open-extension-settings', '@ext:orchidfiles.ungate'],
		['open-provider-timeout-settings', '@id:ungate.network.providerHeaderTimeoutSeconds'],
		['open-tunnel-timeout-settings', '@id:ungate.tunnel.connectTimeoutSeconds'],
		['open-log-settings', '@id:ungate.logs.maxEntries']
	] as const)('opens fixed native settings for %s without restarting services', async (action, query) => {
		const { controller, apiServer, tunnelManager } = createController('settings-window');
		await getInternals(controller).runAction(action);
		expect(executeCommandMock).toHaveBeenLastCalledWith('workbench.action.openSettings', query);
		expect(apiServer.restart).not.toHaveBeenCalled();
		expect(tunnelManager.restart).not.toHaveBeenCalled();
	});

	it('keeps a stopped tunnel on the selected provider without starting the other one', async () => {
		const state = createRuntimeState(['tunnel-window']);
		state.tunnelProvider = 'quick';
		state.tunnel.status = 'stopped';
		runtimeReadMock.mockReturnValue(state);
		const { controller, tunnelManager } = createController('tunnel-window');
		Object.assign(controller, { ngrokToken: { read: vi.fn().mockResolvedValue(null) } });

		await getInternals(controller).setTunnelProvider('ngrok');

		expect(showWarningMessageMock).not.toHaveBeenCalled();
		expect(state.tunnelProvider).toBe('ngrok');
		expect(tunnelManager.restart).not.toHaveBeenCalled();
		expect(tunnelManager.start).not.toHaveBeenCalled();
	});

	it('leaves the running tunnel in place when replacement is cancelled', async () => {
		const state = createRuntimeState(['tunnel-window']);
		state.tunnelProvider = 'quick';
		state.tunnel.status = 'running';
		state.tunnel.port = 47821;
		state.tunnel.url = 'https://one.trycloudflare.com';
		runtimeReadMock.mockReturnValue(state);
		showWarningMessageMock.mockResolvedValue(undefined);
		const { controller, tunnelManager } = createController('tunnel-window');
		Object.assign(controller, { ngrokToken: { read: vi.fn().mockResolvedValue('secret') } });

		await getInternals(controller).setTunnelProvider('ngrok');

		expect(showWarningMessageMock).toHaveBeenCalledOnce();
		expect(state.tunnelProvider).toBe('quick');
		expect(tunnelManager.restart).not.toHaveBeenCalled();
	});

	it('replaces the running tunnel with the one provider that was chosen', async () => {
		const state = createRuntimeState(['tunnel-window']);
		state.tunnelProvider = 'quick';
		state.tunnel.status = 'running';
		state.tunnel.port = 47821;
		state.tunnel.url = 'https://one.trycloudflare.com';
		runtimeReadMock.mockReturnValue(state);
		showWarningMessageMock.mockResolvedValue('Replace');
		const { controller, tunnelManager } = createController('tunnel-window');
		Object.assign(controller, { ngrokToken: { read: vi.fn().mockResolvedValue('secret') } });

		await getInternals(controller).setTunnelProvider('ngrok');

		expect(state.tunnelProvider).toBe('ngrok');
		expect(tunnelManager.restart).toHaveBeenCalledTimes(1);
		expect(tunnelManager.restart).toHaveBeenCalledWith(47821, 'http2');
		expect(tunnelManager.start).not.toHaveBeenCalled();
	});

	it.each(['running', 'starting', 'installing'] as const)(
		'keeps the %s tunnel when the selected provider is chosen again',
		async (status) => {
			const state = createRuntimeState(['tunnel-window']);
			state.tunnelProvider = 'ngrok';
			state.tunnel.status = status;
			state.tunnel.port = 47821;
			runtimeReadMock.mockReturnValue(state);
			const { controller, tunnelManager, dashboard } = createController('tunnel-window');
			Object.assign(controller, { ngrokToken: { read: vi.fn().mockResolvedValue('secret') } });

			await getInternals(controller).setTunnelProvider('ngrok');

			expect(showWarningMessageMock).not.toHaveBeenCalled();
			expect(state.tunnelProvider).toBe('ngrok');
			expect(dashboard.sendTunnelConfig).toHaveBeenCalledWith('ngrok', 'secret');
			expect(tunnelManager.restart).not.toHaveBeenCalled();
			expect(tunnelManager.start).not.toHaveBeenCalled();
		}
	);

	it.each(['running', 'starting', 'installing'] as const)(
		'leaves a %s ngrok tunnel in place when switching back is cancelled',
		async (status) => {
			const state = createRuntimeState(['tunnel-window']);
			state.tunnelProvider = 'ngrok';
			state.tunnel.status = status;
			state.tunnel.url = 'https://stable.ngrok-free.app';
			runtimeReadMock.mockReturnValue(state);
			showWarningMessageMock.mockResolvedValue(undefined);
			const { controller, tunnelManager } = createController('tunnel-window');
			Object.assign(controller, { ngrokToken: { read: vi.fn().mockResolvedValue('secret') } });

			await getInternals(controller).setTunnelProvider('quick');

			expect(state.tunnelProvider).toBe('ngrok');
			expect(tunnelManager.restart).not.toHaveBeenCalled();
		}
	);

	it('replaces a running ngrok tunnel with Cloudflare when the switch is confirmed', async () => {
		const state = createRuntimeState(['tunnel-window']);
		state.tunnelProvider = 'ngrok';
		state.tunnel.status = 'running';
		state.tunnel.port = 47821;
		state.tunnel.url = 'https://stable.ngrok-free.app';
		runtimeReadMock.mockReturnValue(state);
		showWarningMessageMock.mockResolvedValue('Replace');
		const { controller, tunnelManager } = createController('tunnel-window');
		Object.assign(controller, { ngrokToken: { read: vi.fn().mockResolvedValue('secret') } });

		await getInternals(controller).setTunnelProvider('quick');

		expect(state.tunnelProvider).toBe('quick');
		expect(tunnelManager.restart).toHaveBeenCalledTimes(1);
		expect(tunnelManager.restart).toHaveBeenCalledWith(47821, 'http2');
		expect(tunnelManager.start).not.toHaveBeenCalled();
	});

	it('does not replace a running tunnel with ngrok when the authtoken is missing', async () => {
		const state = createRuntimeState(['tunnel-window']);
		state.tunnelProvider = 'quick';
		state.tunnel.status = 'running';
		state.tunnel.port = 47821;
		state.tunnel.url = 'https://one.trycloudflare.com';
		runtimeReadMock.mockReturnValue(state);
		showWarningMessageMock.mockResolvedValue('Replace');
		const { controller, tunnelManager } = createController('tunnel-window');
		Object.assign(controller, { ngrokToken: { read: vi.fn().mockResolvedValue(null) } });

		await getInternals(controller).setTunnelProvider('ngrok');

		expect(state.tunnelProvider).toBe('quick');
		expect(state.tunnel.url).toBe('https://one.trycloudflare.com');
		expect(tunnelManager.restart).not.toHaveBeenCalled();
		expect(showErrorMessageMock).toHaveBeenCalledWith('Ungate: Add an ngrok authtoken before starting the stable tunnel.');
	});

	it('reports a replacement failure after the selected provider is saved', async () => {
		const state = createRuntimeState(['tunnel-window']);
		state.tunnelProvider = 'quick';
		state.tunnel.status = 'running';
		state.tunnel.port = 47821;
		runtimeReadMock.mockReturnValue(state);
		showWarningMessageMock.mockResolvedValue('Replace');
		const { controller, tunnelManager } = createController('tunnel-window');
		Object.assign(controller, { ngrokToken: { read: vi.fn().mockResolvedValue('secret') } });
		tunnelManager.restart.mockRejectedValue(new Error('ngrok did not connect within 30 seconds.'));

		await getInternals(controller).setTunnelProvider('ngrok');

		expect(state.tunnelProvider).toBe('ngrok');
		expect(showErrorMessageMock).toHaveBeenCalledWith('Ungate: ngrok did not connect within 30 seconds.');
	});

	it('saves the provider without restarting when a live tunnel has no port', async () => {
		const state = createRuntimeState(['tunnel-window'], null);
		state.tunnelProvider = 'quick';
		state.tunnel.status = 'running';
		runtimeReadMock.mockReturnValue(state);
		showWarningMessageMock.mockResolvedValue('Replace');
		const { controller, tunnelManager } = createController('tunnel-window');
		Object.assign(controller, { ngrokToken: { read: vi.fn().mockResolvedValue('secret') } });

		await getInternals(controller).setTunnelProvider('ngrok');

		expect(state.tunnelProvider).toBe('ngrok');
		expect(tunnelManager.restart).not.toHaveBeenCalled();
	});

	it('changes the provider of a stopped or failed tunnel without starting one', async () => {
		const state = createRuntimeState(['tunnel-window']);
		state.tunnelProvider = 'ngrok';
		state.tunnel.status = 'error';
		runtimeReadMock.mockReturnValue(state);
		const { controller, tunnelManager } = createController('tunnel-window');
		Object.assign(controller, { ngrokToken: { read: vi.fn().mockResolvedValue('secret') } });

		await getInternals(controller).setTunnelProvider('quick');

		expect(showWarningMessageMock).not.toHaveBeenCalled();
		expect(state.tunnelProvider).toBe('quick');
		expect(tunnelManager.restart).not.toHaveBeenCalled();
		expect(tunnelManager.start).not.toHaveBeenCalled();
	});

	beforeAll(async () => {
		const module = await import('../../src/extension-controller');
		ExtensionController = module.ExtensionController;
	});

	beforeEach(async () => {
		const { readTunnelProtocol } = await import('../../src/local-api');
		vi.mocked(readTunnelProtocol).mockResolvedValue('http2');
		installedDigest.mockReturnValue(undefined);
		createOutputChannelMock.mockClear();
		createStatusBarItemMock.mockClear();
		registerCommandMock.mockClear();
		showWarningMessageMock.mockReset();
		showErrorMessageMock.mockReset();
		runtimeMutateMock.mockReset();
		runtimeMutateMock.mockImplementation((mutator) => Promise.resolve(mutator(runtimeReadMock())));
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

	it('opens on the saved API failure without a connecting placeholder', () => {
		const state = createRuntimeState(['window-a'], null);
		state.api.status = 'error';
		state.api.lastError = 'Ungate API did not become ready within 30 seconds.';
		runtimeReadMock.mockReturnValue(state);
		const { controller, dashboard } = createController('window-a');

		(controller as unknown as { publishStoredServiceState(): void }).publishStoredServiceState();

		expect(dashboard.sendServiceState).toHaveBeenCalledWith(
			expect.objectContaining({
				status: 'error',
				message: 'Ungate API did not become ready within 30 seconds.'
			})
		);
		expect(dashboard.sendServiceState).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'checking' }));
	});

	it('leaves a running API unpublished until its health check', () => {
		const state = createRuntimeState(['window-a']);
		state.api.status = 'running';
		state.api.port = 4783;
		runtimeReadMock.mockReturnValue(state);
		const { controller, dashboard } = createController('window-a');

		(controller as unknown as { publishStoredServiceState(): void }).publishStoredServiceState();

		expect(dashboard.sendServiceState).not.toHaveBeenCalled();
	});

	it('keeps a starting API on one status while its port is not healthy yet', async () => {
		const { readApiHealth } = await import('../../src/local-api');
		vi.mocked(readApiHealth).mockClear();
		const { controller, dashboard } = createController('window-a');
		const runtime = createRuntimeState(['window-a']);
		runtime.api.status = 'starting';
		runtime.api.port = 4783;
		runtime.api.lastError = 'Ungate API did not become ready within 30 seconds.';

		await (controller as unknown as { updateServiceState(state: RuntimeState): Promise<void> }).updateServiceState(runtime);

		expect(readApiHealth).not.toHaveBeenCalled();
		expect(dashboard.sendServiceState).toHaveBeenCalledWith(expect.objectContaining({ status: 'checking', message: null }));
	});

	it('uses the current installed bundle for dashboard and status-bar compatibility', async () => {
		const { readApiHealth } = await import('../../src/local-api');
		vi.mocked(readApiHealth).mockResolvedValueOnce({
			service: 'ungate',
			pid: 1234,
			version: UNGATE_VERSION,
			protocolVersion: API_PROTOCOL_VERSION,
			artifactDigest: 'a'.repeat(64)
		});
		installedDigest.mockReturnValue('b'.repeat(64));
		const { controller, dashboard, statusBar } = createController('window-a');
		const runtime = createRuntimeState([], null);
		runtime.api.port = 4783;
		await (controller as unknown as { updateServiceState(state: RuntimeState): Promise<void> }).updateServiceState(runtime);
		expect(dashboard.sendServiceState).toHaveBeenLastCalledWith(
			expect.objectContaining({ status: 'incompatible', restartRequired: true })
		);
		expect(statusBar.text).not.toContain('Ready');
	});

	it('requires reload when the installed bundle changes beneath a live host', async () => {
		installedDigest.mockReturnValue('a'.repeat(64));
		const { controller, dashboard, statusBar } = createController('window-a');
		installedDigest.mockReturnValue('b'.repeat(64));
		await (controller as unknown as { updateServiceState(state: RuntimeState): Promise<void> }).updateServiceState(
			createRuntimeState([], null)
		);
		expect(dashboard.sendServiceState).toHaveBeenLastCalledWith(
			expect.objectContaining({
				status: 'incompatible',
				canUpdate: false,
				restartRequired: false,
				message: expect.stringContaining('Reload this window')
			})
		);
		expect(statusBar.text).not.toContain('Ready');
	});

	it('does not restart usage polling on repeated healthy one-second heartbeats', () => {
		const { controller } = createController('window-a');
		const refresh = vi.fn();
		Object.assign(controller, { lastApiStatus: 'running', refreshSubscriptionLimits: refresh });
		const internals = controller as unknown as { handleApiServerStatusChange(status: string): void };
		for (let tick = 0; tick < 5; tick++) internals.handleApiServerStatusChange('running');
		expect(refresh).not.toHaveBeenCalled();
		Object.assign(controller, { lastApiStatus: 'stopped' });
		internals.handleApiServerStatusChange('running');
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it('uses a recoverable live status instead of persistent outage notifications', () => {
		vi.useFakeTimers();
		try {
			const { controller, statusBar } = createController('window-a');
			const internals = getInternals(controller);
			const log = vi.fn();
			Object.assign(controller, { log });

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

			expect(showWarningMessageMock).not.toHaveBeenCalled();
			expect(log).toHaveBeenCalledTimes(1);
			expect(statusBar.text).toBe('$(warning) Ungate: Not ready');
			expect(statusBar.backgroundColor).toMatchObject({ id: 'statusBarItem.warningBackground' });

			vi.advanceTimersByTime(8000);
			expect(statusBar.backgroundColor).toBeUndefined();
			Object.assign(controller, {
				currentTunnelState: {
					status: 'running',
					url: 'https://example.trycloudflare.com',
					publicStatus: 'reachable',
					error: null
				}
			});
			internals.updateStatusBar();
			internals.updateStatusBar();
			expect(statusBar.text).toBe('$(check) Ungate: Ready');
			expect(log).toHaveBeenCalledTimes(1);
			expect(showWarningMessageMock).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it('shows a restart warning when the running build does not match this window', () => {
		const { controller, statusBar } = createController('window-a');
		const internals = getInternals(controller);
		Object.assign(controller as object, {
			lastApiStatus: 'running',
			serviceState: {
				status: 'incompatible',
				version: '1.7.15',
				expectedVersion: '1.7.15',
				canUpdate: true,
				restartRequired: true,
				message: 'A different Ungate API build is running. Restart the shared API to apply the installed build.',
				logsConnected: true
			},
			currentTunnelState: {
				status: 'running',
				url: 'https://example.trycloudflare.com',
				error: null,
				publicStatus: 'reachable'
			}
		});
		internals.updateStatusBar();
		expect(statusBar.text).toBe('$(warning) Ungate: Not ready');
		expect(statusBar.backgroundColor).toBeUndefined();
		expect(showWarningMessageMock).not.toHaveBeenCalled();
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
		expect(activatedStatusBar?.text).toBe('$(warning) Ungate: Not ready');

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
			provider: null,
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
