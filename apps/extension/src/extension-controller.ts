import * as path from 'node:path';

import { getAdminToken } from '@ungate/shared';
import {
	dashboardActions,
	describeService,
	UNGATE_VERSION,
	type DashboardAction,
	type ServiceState,
	type ApiStatus as ApiLifecycleStatus,
	type RuntimeState,
	type LogEntry,
	type TunnelState
} from '@ungate/shared/frontend';
import * as vscode from 'vscode';

import { ApiServer } from './api-server';
import { openCursorModels } from './cursor-settings';
import { Dashboard, type Msg } from './dashboard';
import { extensionCommands } from './extension-commands';
import { ExtensionStatusBar, type UngateConnectionStatus } from './extension-status-bar';
import { readApiHealth } from './local-api';
import { RuntimeStateStore } from './runtime-state';
import { config } from './runtime-state/config';
import { SharedServiceController } from './shared-service-controller';
import { TunnelManager } from './tunnel-manager';

class ActionCancelledError extends Error {}

export class ExtensionController {
	private outputChannel!: vscode.OutputChannel;
	private statusBar!: vscode.StatusBarItem;
	private dashboard!: Dashboard;
	private tunnelManager!: TunnelManager;
	private apiServer!: ApiServer;
	private services!: SharedServiceController;
	private actionInProgress = false;
	private serviceState: ServiceState = {
		status: 'checking',
		version: null,
		expectedVersion: UNGATE_VERSION,
		canUpdate: false,
		message: null
	};

	private currentPort: number | null = null;
	private lastApiStatus: ApiLifecycleStatus | null = null;
	private lastApiError: string | null = null;
	private currentTunnelState: TunnelState = { status: 'stopped', url: null, error: null };
	private lastConnectionStatus: UngateConnectionStatus | null = null;
	private statusBarWarningTimer: NodeJS.Timeout | null = null;
	private readonly windowId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	private heartbeatTimer: NodeJS.Timeout | null = null;
	private syncTimer: NodeJS.Timeout | null = null;
	private runtimeStateWatcher: vscode.FileSystemWatcher | null = null;
	private runtimeStateSyncDebounce: NodeJS.Timeout | null = null;
	private syncing = false;
	private extensionHostActive = false;

	constructor(private readonly context: vscode.ExtensionContext) {}

	public activate(): void {
		this.extensionHostActive = true;
		this.outputChannel = vscode.window.createOutputChannel('Ungate');
		this.context.subscriptions.push(this.outputChannel);

		// A Remote SSH window replaces its bootstrap local extension host after
		// authority resolution. Keep a stable item identity so Cursor replaces
		// the disposed bootstrap item instead of losing the recreated one.
		this.statusBar = vscode.window.createStatusBarItem('ungate.connectionStatus', vscode.StatusBarAlignment.Right, 100);
		this.statusBar.command = extensionCommands.openDashboard;
		this.context.subscriptions.push(this.statusBar);
		// Render immediately in every local and Remote SSH window. Runtime-state
		// bootstrap is asynchronous and must not gate status-bar visibility.
		this.updateStatusBar();

		this.dashboard = new Dashboard(this.context, (message) => {
			this.handleDashboardMessage(message);
		});

		this.tunnelManager = new TunnelManager(
			this.windowId,
			() => this.extensionHostActive,
			(state) => {
				this.currentTunnelState = state;
				this.dashboard.sendTunnelState(state);
				this.updateStatusBar();
			},
			(entry) => {
				this.log(`[tunnel] ${entry.message}`);
				this.dashboard.pushLog('tunnel', entry);
			}
		);

		this.apiServer = new ApiServer(this.context, {
			onLog: (level: LogEntry['level'], message: string) => {
				this.log(message);
				this.dashboard.pushLog('api', { timestamp: Date.now(), level, message });
			},
			onPortDetected: (port: number) => {
				this.handleApiServerPortDetected(port);
			},
			onStatusChange: (status) => {
				this.handleApiServerStatusChange(status);
			},
			isLeaderWindow: () => {
				return this.isLeaderWindow();
			},
			isExtensionHostActive: () => {
				return this.extensionHostActive;
			},
			getWindowId: () => {
				return this.windowId;
			}
		});

		const openDashboard = vscode.commands.registerCommand(extensionCommands.openDashboard, () => {
			this.dashboard.show();
		});

		this.services = new SharedServiceController(
			this.apiServer,
			this.tunnelManager,
			this.windowId,
			() => this.extensionHostActive
		);
		this.context.subscriptions.push(openDashboard);
		for (const [action, definition] of Object.entries(dashboardActions)) {
			this.context.subscriptions.push(
				vscode.commands.registerCommand(definition.command, () =>
					this.runAction(action as DashboardAction).catch((error: unknown) => {
						if (error instanceof ActionCancelledError) return;
						void vscode.window.showErrorMessage(`Ungate: ${this.formatError(error)}`);
					})
				)
			);
		}

		this.startHeartbeat();
		this.startRuntimeSync();
		this.startRuntimeStateWatch();
		void this.bootstrapRuntime().catch((error: unknown) => this.log(`[startup] ${this.formatError(error)}`));

		this.context.subscriptions.push({
			dispose: () => {
				void this.stopBackendServices();
			}
		});
	}

	public async stopBackendServices(): Promise<void> {
		if (!this.extensionHostActive) return;
		this.extensionHostActive = false;

		// Detached services survive an extension-host reload and a window closing.
		// The next live window attaches to them instead of interrupting other chats.
		this.apiServer?.detach();
		this.tunnelManager?.syncMonitor(false);

		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}

		if (this.syncTimer) {
			clearInterval(this.syncTimer);
			this.syncTimer = null;
		}

		if (this.runtimeStateSyncDebounce) {
			clearTimeout(this.runtimeStateSyncDebounce);
			this.runtimeStateSyncDebounce = null;
		}

		if (this.statusBarWarningTimer) {
			clearTimeout(this.statusBarWarningTimer);
			this.statusBarWarningTimer = null;
		}

		if (this.runtimeStateWatcher) {
			this.runtimeStateWatcher.dispose();
			this.runtimeStateWatcher = null;
		}

		await RuntimeStateStore.removeClient(this.windowId).catch(() => {});
	}

	private log(msg: string): void {
		this.outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
	}

	private formatError(err: unknown): string {
		if (err instanceof Error) {
			return err.message;
		}

		return String(err);
	}

	private getTunnelBaseUrl(): string | null {
		return this.currentTunnelState.url;
	}

	private getTunnelApiUrl(): string | null {
		const baseUrl = this.getTunnelBaseUrl();

		if (!baseUrl) {
			return null;
		}

		return `${baseUrl}/v1`;
	}

	private getLocalApiUrl(): string | null {
		return this.currentPort ? `http://127.0.0.1:${this.currentPort}` : null;
	}

	private updateStatusBar(): void {
		const apiState = this.lastApiStatus ?? 'stopped';
		const tunnel = this.currentTunnelState;
		const tunnelApiUrl = this.getTunnelApiUrl();
		const status = ExtensionStatusBar.connectionStatus(apiState, tunnel);
		const becameOffline = this.lastConnectionStatus === 'ready' && status === 'offline' && !this.actionInProgress;

		if (becameOffline) this.scheduleWarningBackgroundReset();

		this.statusBar.text = ExtensionStatusBar.statusText(status);
		this.statusBar.accessibilityInformation = {
			label: ExtensionStatusBar.accessibilityLabel(status)
		};
		this.statusBar.tooltip = ExtensionStatusBar.createTooltip(
			status,
			apiState,
			this.getLocalApiUrl(),
			this.lastApiError,
			tunnel,
			tunnelApiUrl
		);
		this.statusBar.backgroundColor =
			status === 'offline' && this.statusBarWarningTimer ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
		this.statusBar.show();

		if (becameOffline) {
			void vscode.window.showWarningMessage('Ungate tunnel is unavailable. Custom Ungate models may fail.');
		}

		if (status !== 'connecting') this.lastConnectionStatus = status;
	}

	private applyApiServerStatus(state: ApiLifecycleStatus): void {
		this.lastApiStatus = state;
		if (state === 'running') this.lastApiError = null;
		this.updateStatusBar();
	}

	private scheduleWarningBackgroundReset(): void {
		if (this.statusBarWarningTimer) clearTimeout(this.statusBarWarningTimer);
		this.statusBarWarningTimer = setTimeout(() => {
			this.statusBarWarningTimer = null;
			this.statusBar.backgroundColor = undefined;
		}, 8000);
	}

	private handleApiServerPortDetected(port: number): void {
		const isNew = this.currentPort !== port;
		this.currentPort = port;

		if (isNew) {
			this.log(`[port] detected: ${port}`);
			this.dashboard.setPort(port);
		}
	}

	private handleApiServerStatusChange(status: ApiLifecycleStatus): void {
		if (status === 'stopped' && this.lastApiStatus === 'running') {
			this.log(`[health] port ${this.currentPort} unreachable`);
		}

		this.applyApiServerStatus(status);
	}

	private async runAction(action: DashboardAction): Promise<void> {
		if (this.actionInProgress) throw new Error('Another Ungate action is still running.');
		this.actionInProgress = true;
		try {
			if (action === 'open-cursor-models') return await openCursorModels();
			if (action === 'reload-window') {
				await vscode.commands.executeCommand('workbench.action.reloadWindow');

				return;
			}
			if (action === 'copy-tunnel-url') {
				const url = this.getTunnelApiUrl();
				if (!url) throw new Error('Start the tunnel before copying its URL.');
				await vscode.env.clipboard.writeText(url);

				return;
			}
			if (action === 'copy-api-key') {
				const port = RuntimeStateStore.read().api.port;
				if (!port) throw new Error('Start the API before copying its key.');
				const response = await fetch(`http://127.0.0.1:${port}/settings`, {
					headers: { Authorization: `Bearer ${getAdminToken()}` },
					redirect: 'error',
					signal: AbortSignal.timeout(3000)
				});
				if (!response.ok) throw new Error(`Cannot read the saved API key: HTTP ${response.status}`);
				const raw: unknown = await response.json();
				const settings = raw as { apiKey?: unknown };
				if (typeof settings.apiKey !== 'string' || !settings.apiKey.trim()) throw new Error('Save an API key first.');
				await vscode.env.clipboard.writeText(settings.apiKey);

				return;
			}
			if (
				action === 'stop-services' ||
				action === 'restart-services' ||
				action === 'restart-tunnel' ||
				action === 'stop-tunnel'
			) {
				const choice = await vscode.window.showWarningMessage(
					`${dashboardActions[action].title}? Active Ungate chats in every window may be interrupted.`,
					{ modal: true },
					'Continue'
				);
				if (choice !== 'Continue') throw new ActionCancelledError('Action cancelled.');
			}
			await this.services.run(action);
			await this.syncFromRuntimeState();
		} finally {
			this.actionInProgress = false;
		}
	}

	private handleDashboardMessage(message: Msg): void {
		if (message.type === 'dashboard-action') {
			void this.runAction(message.action).then(
				() => this.dashboard.sendActionResult(message.id),
				(error: unknown) =>
					this.dashboard.sendActionResult(
						message.id,
						error instanceof ActionCancelledError ? { cancelled: true } : { error: this.formatError(error) }
					)
			);

			return;
		}
		if (message.type === 'open-external-url') {
			const uri = vscode.Uri.parse(message.url);
			if (uri.scheme === 'https' || uri.scheme === 'http') void vscode.env.openExternal(uri);

			return;
		}
		if (message.type === 'webview-ready') {
			this.dashboard.sendInitialState(this.currentTunnelState);
			this.dashboard.sendServiceState(this.serviceState);

			return;
		}
		// Older dashboards can still finish their save/restart flow during transition.
		const legacyActions = {
			'restart-server': 'restart-services',
			'start-tunnel': 'start-tunnel',
			'stop-tunnel': 'stop-tunnel',
			'restart-tunnel': 'restart-tunnel'
		} as const;
		if (message.type in legacyActions) {
			void this.runAction(legacyActions[message.type as keyof typeof legacyActions]).catch((error: unknown) => {
				if (error instanceof ActionCancelledError) return;
				void vscode.window.showErrorMessage(`Ungate: ${this.formatError(error)}`);
			});

			return;
		}
		if (message.type === 'clear-logs') this.dashboard.clearLogs(message.source);
	}

	private async updateServiceState(state: RuntimeState): Promise<void> {
		let service: ServiceState;
		if (!state.api.port) {
			service = {
				status: state.api.status === 'starting' ? 'checking' : state.api.status === 'error' ? 'error' : 'stopped',
				version: null,
				expectedVersion: UNGATE_VERSION,
				canUpdate: false,
				message: state.api.lastError
			};
		} else {
			try {
				const health = await readApiHealth(state.api.port);
				service = describeService(health);
			} catch {
				service = {
					status: 'error',
					version: null,
					expectedVersion: UNGATE_VERSION,
					canUpdate: false,
					message: state.api.lastError ?? 'The shared API is not responding. Restart it or open Logs.'
				};
			}
		}
		this.serviceState = service;
		this.dashboard.sendServiceState(service);
	}

	private startHeartbeat(): void {
		void RuntimeStateStore.touchClient(this.windowId).catch(() => {});
		this.heartbeatTimer = setInterval(() => {
			void RuntimeStateStore.touchClient(this.windowId).catch(() => {});
		}, config.extensionController.heartbeatIntervalMs);
	}

	private startRuntimeSync(): void {
		this.syncTimer = setInterval(() => {
			void this.syncFromRuntimeState().catch(() => {});
		}, config.extensionController.runtimeSyncIntervalMs);
	}

	private startRuntimeStateWatch(): void {
		const stateFileName = path.basename(config.paths.stateFilePath);

		this.runtimeStateWatcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(vscode.Uri.file(config.baseDir), stateFileName)
		);

		const scheduleSync = (): void => {
			if (this.runtimeStateSyncDebounce) {
				clearTimeout(this.runtimeStateSyncDebounce);
			}

			this.runtimeStateSyncDebounce = setTimeout(() => {
				this.runtimeStateSyncDebounce = null;
				void this.syncFromRuntimeState().catch(() => {});
			}, 100);
		};

		this.runtimeStateWatcher.onDidChange(scheduleSync);
		this.runtimeStateWatcher.onDidCreate(scheduleSync);
	}

	private async bootstrapRuntime(): Promise<void> {
		await RuntimeStateStore.touchClient(this.windowId);
		await RuntimeStateStore.prepareApiForBootstrap();
		await this.syncFromRuntimeState();
	}

	private async syncFromRuntimeState(): Promise<void> {
		if (this.syncing || !this.extensionHostActive) return;
		this.syncing = true;
		try {
			let runtimeState = RuntimeStateStore.read();
			const liveClientIds = RuntimeStateStore.getLiveClientIds(runtimeState);

			if (!liveClientIds.includes(this.windowId)) {
				runtimeState = await RuntimeStateStore.touchClient(this.windowId);
			}

			await this.tunnelManager.reconcile();
			runtimeState = RuntimeStateStore.read();
			runtimeState = await RuntimeStateStore.reconcileOrphanedTunnel(runtimeState);

			this.applyRuntimeState(runtimeState);
			this.apiServer.syncLeaderHealthMonitor(this.isLeaderWindow(runtimeState));
			this.tunnelManager.syncMonitor(this.isLeaderWindow(runtimeState));
			this.startApiAsLeaderIfNeeded(runtimeState);
			await this.updateServiceState(runtimeState);
		} finally {
			this.syncing = false;
		}
	}

	private applyRuntimeState(runtimeState: RuntimeState): void {
		const resolvedPort =
			runtimeState.api.startSuppressed && runtimeState.api.status === 'stopped'
				? null
				: (runtimeState.api.port ?? this.apiServer.getPort() ?? this.currentPort);

		this.currentPort = resolvedPort;
		this.lastApiStatus = runtimeState.api.status;
		this.lastApiError = runtimeState.api.lastError;
		this.currentTunnelState = {
			status: runtimeState.tunnel.status,
			url: runtimeState.tunnel.url,
			error: runtimeState.tunnel.lastError,
			publicStatus: runtimeState.tunnel.publicStatus ?? 'unchecked',
			publicCheckedAt: runtimeState.tunnel.publicCheckedAt ?? null,
			publicError: runtimeState.tunnel.publicError ?? null,
			startedAt: runtimeState.tunnel.startedAt ?? null
		};
		this.dashboard.setPort(this.currentPort);
		this.dashboard.sendTunnelState(this.currentTunnelState);
		this.updateStatusBar();
	}

	private isLeaderWindow(runtimeState?: RuntimeState): boolean {
		const state = runtimeState ?? RuntimeStateStore.read();
		const leaderWindowId = RuntimeStateStore.getLeaderWindowId(state);

		return leaderWindowId === this.windowId;
	}

	private startApiAsLeaderIfNeeded(runtimeState: RuntimeState): void {
		if (this.actionInProgress || !this.isLeaderWindow(runtimeState)) {
			return;
		}

		if ((this.apiServer.getPort() && runtimeState.api.status === 'running') || this.apiServer.isStartupInProgress()) {
			return;
		}

		if (RuntimeStateStore.isApiStartSuppressed(runtimeState)) {
			return;
		}

		void this.apiServer.start().catch((err: unknown) => {
			const message = this.formatError(err);
			this.log(`[process] leader start failed: ${message}`);
			this.dashboard.pushLog('api', { timestamp: Date.now(), level: 'error', message });
			this.lastApiError = message;
			this.applyApiServerStatus('error');
		});
	}
}
