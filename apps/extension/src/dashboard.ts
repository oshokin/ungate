import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
	dashboardActionSchema,
	type DashboardActionRequest,
	type ServiceState,
	type LogEntry,
	type TunnelProvider,
	type TunnelState,
	type WebviewToExtension,
	type UsageState
} from '@ungate/shared/frontend';
import * as vscode from 'vscode';

import { apiArtifactDigest } from './api-artifact';
import { DashboardApiBridge } from './dashboard-api-bridge';
import { readDashboardPreferences, writeDashboardPreference } from './dashboard-preferences';
import { dashboardLogEntryLimit } from './dashboard-settings';
import { SharedLogStore } from './runtime-state/shared-log-store';

import type { UsageController } from './usage-controller';

/** How often the webview is sent newly appended log lines. */
const LOG_POLL_INTERVAL_MS = 500;

/** Webview messages that carry no payload. */
const MSGS_SIMPLE = ['webview-ready', 'restart-server', 'start-tunnel', 'stop-tunnel', 'restart-tunnel'] as const;

export type Msg =
	| { type: 'open-external-url'; url: string }
	| { type: 'set-tunnel-provider'; provider: TunnelProvider }
	| { type: 'set-ngrok-auth-token'; token: string }
	| DashboardActionRequest
	| { type: 'clear-logs'; source: 'api' | 'tunnel' }
	| Extract<WebviewToExtension, { type: (typeof MSGS_SIMPLE)[number] }>;

export class Dashboard implements vscode.WebviewViewProvider, vscode.Disposable {
	static readonly viewType = 'ungate.dashboard';
	private placement: 'editor' | 'panel';
	private view: vscode.WebviewView | null = null;
	private readonly sessions = new Map<vscode.Webview, { ready: boolean; dispose: () => void }>();
	private readonly actionOrigins = new Map<string, vscode.Webview>();
	private readonly registrations: vscode.Disposable[] = [];
	private panel: vscode.WebviewPanel | null = null;
	private currentPort: number | null = null;
	private logPollTimer: NodeJS.Timeout | null = null;
	private htmlSource: string | null = null;
	private usageNavigationPending = false;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly onMessage: (message: Msg) => void,
		private readonly expectedArtifactDigest?: string,
		private readonly usage?: UsageController,
		private readonly onServiceState?: (state: ServiceState) => void
	) {
		this.placement = context.globalState?.get('dashboard.placement') === 'panel' ? 'panel' : 'editor';
		this.registrations.push(
			vscode.window.registerWebviewViewProvider(Dashboard.viewType, this, {
				webviewOptions: { retainContextWhenHidden: true }
			})
		);
		void vscode.commands.executeCommand('setContext', 'ungate.dashboardPanel', this.placement === 'panel');
		this.prepare();
	}

	/** Reads dashboard HTML during activation so a status-bar click only opens the panel. */
	prepare(): void {
		try {
			this.readHtmlSource();
		} catch {
			this.htmlSource = null;
		}
	}

	show(): void {
		if (this.placement === 'panel') {
			void vscode.commands.executeCommand(`${Dashboard.viewType}.focus`);

			return;
		}
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.Active);

			return;
		}

		const panel = vscode.window.createWebviewPanel('ungate', 'Ungate', vscode.ViewColumn.Active, this.getWebviewOptions());
		this.panel = panel;
		panel.iconPath = vscode.Uri.file(path.join(this.context.extensionPath, 'resources', 'icon.png'));
		this.attach(panel.webview, panel);
		panel.onDidChangeViewState(() => {
			if (panel.visible) {
				this.sendBufferedLogs('api');
				this.sendBufferedLogs('tunnel');
			}
		});
		panel.onDidDispose(() => {
			if (this.panel === panel) this.panel = null;
		});
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = this.getWebviewOptions();
		this.attach(view.webview, view);
		view.onDidDispose(() => {
			if (this.view === view) this.view = null;
		});
	}

	async setPlacement(placement: 'editor' | 'panel'): Promise<void> {
		await this.context.globalState.update('dashboard.placement', placement);
		this.placement = placement;
		this.broadcast({ type: 'dashboard-placement', placement });
		await vscode.commands.executeCommand('setContext', 'ungate.dashboardPanel', placement === 'panel');
		if (placement === 'panel') this.panel?.dispose();
		this.show();
	}

	dispose(): void {
		this.panel?.dispose();
		for (const session of this.sessions.values()) session.dispose();
		for (const registration of this.registrations) registration.dispose();
		this.stopLogPoll();
	}

	private attach(webview: vscode.Webview, owner: { onDidDispose: vscode.Event<void> }): void {
		const session = { ready: false, dispose: () => {} };
		this.sessions.set(webview, session);
		const publishPreferences = (): void => {
			if (!session.ready) return;
			void webview.postMessage({ type: 'dashboard-preferences', values: readDashboardPreferences() });
			void webview.postMessage({ type: 'dashboard-placement', placement: this.placement });
		};
		const preferenceSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('ungate')) publishPreferences();
		});
		webview.html = this.buildHtml(webview);
		const bridge = new DashboardApiBridge(
			() => this.currentPort,
			(response) => {
				if (this.sessions.has(webview)) void webview.postMessage(response);
			},
			this.expectedArtifactDigest,
			this.usage,
			this.onServiceState,
			() => apiArtifactDigest(this.context)
		);

		const messages = webview.onDidReceiveMessage((message: unknown) => {
			if (typeof message === 'object' && message !== null && 'type' in message) {
				if (message.type === 'webview-ready') {
					session.ready = true;
					publishPreferences();
				}
				if (message.type === 'set-dashboard-placement') {
					if ('placement' in message && (message.placement === 'editor' || message.placement === 'panel'))
						void this.setPlacement(message.placement).catch(() =>
							vscode.window.showErrorMessage('Unable to save dashboard placement.')
						);

					return;
				}
				if (message.type === 'get-dashboard-preferences') {
					publishPreferences();

					return;
				}
				if (message.type === 'set-dashboard-preference') {
					void writeDashboardPreference(message).then(
						() => {
							publishPreferences();
							void webview.postMessage({
								type: 'dashboard-preference-result',
								...('key' in message ? { key: message.key } : {}),
								error: null
							});
						},
						(error: unknown) => {
							void webview.postMessage({
								type: 'dashboard-preference-result',
								...('key' in message ? { key: message.key } : {}),
								error: error instanceof Error ? error.message : 'Unable to save.'
							});
						}
					);

					return;
				}
			}
			if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'api-request') {
				void bridge.handle(message);

				return;
			}
			const parsed = Dashboard.parseIncomingMessage(message);

			if (!parsed) {
				return;
			}

			if (parsed.type === 'dashboard-action') this.actionOrigins.set(parsed.id, webview);
			this.onMessage(parsed);
		});
		session.dispose = () => {
			this.sessions.delete(webview);
			messages?.dispose();
			preferenceSubscription.dispose();
			bridge.dispose();
			for (const [id, origin] of this.actionOrigins) if (origin === webview) this.actionOrigins.delete(id);
			if (!this.sessions.size) this.stopLogPoll();
		};
		owner.onDidDispose(session.dispose);
		this.startLogPoll();
	}

	private broadcast(message: unknown): void {
		for (const [webview, session] of this.sessions) if (session.ready) void webview.postMessage(message);
	}

	setPort(port: number | null): void {
		if (this.currentPort === port) {
			return;
		}

		this.currentPort = port;

		this.sendPort();
	}

	pushLog(source: 'api' | 'tunnel', entry: LogEntry): void {
		const entryId = SharedLogStore.append(source, entry);

		this.broadcast({ type: 'log', source, entry, entryId, maxEntries: dashboardLogEntryLimit() });
	}

	clearLogs(source: 'api' | 'tunnel'): void {
		SharedLogStore.clear(source);
		this.broadcast({ type: 'logs-cleared', source });
	}

	sendInitialState(tunnelState: TunnelState): void {
		if (this.usageNavigationPending) {
			this.broadcast({ type: 'open-usage' });
			this.usageNavigationPending = false;
		}
		if (this.usage) this.sendUsageState(this.usage.state);
		this.sendPort();
		this.sendBufferedLogs('api');
		this.sendBufferedLogs('tunnel');
		this.broadcast({ type: 'tunnel-status', state: tunnelState });
	}

	sendServiceState(state: ServiceState): void {
		this.broadcast({ type: 'service-state', state });
	}

	sendUsageState(state: UsageState): void {
		this.broadcast({ type: 'usage-state', state });
	}

	openUsage(): void {
		this.usageNavigationPending = true;
		this.broadcast({ type: 'open-usage' });
	}

	sendActionResult(id: string, result?: { error?: string; cancelled?: boolean }): void {
		const origin = this.actionOrigins.get(id);
		this.actionOrigins.delete(id);
		if (origin && this.sessions.has(origin)) void origin.postMessage({ type: 'action-result', id, ...result });
	}

	sendTunnelState(state: TunnelState): void {
		this.broadcast({ type: 'tunnel-status', state });
	}

	sendTunnelConfig(provider: TunnelProvider, token: string | null): void {
		this.broadcast({ type: 'tunnel-config', provider, token });
	}

	private static parseIncomingMessage(raw: unknown): Msg | null {
		if (typeof raw !== 'object' || raw === null || !('type' in raw)) {
			return null;
		}

		const record = raw as Record<string, unknown>;
		const type = record.type;

		if (typeof type !== 'string') {
			return null;
		}

		if (type === 'open-external-url') {
			const url = record.url;

			if (typeof url !== 'string') {
				return null;
			}

			return { type: 'open-external-url', url };
		}

		if (type === 'set-tunnel-provider') {
			const provider = record.provider;
			if (provider !== 'quick' && provider !== 'ngrok') return null;

			return { type: 'set-tunnel-provider', provider };
		}

		if (type === 'set-ngrok-auth-token') {
			const token = record.token;
			if (typeof token !== 'string' || token.trim().length === 0 || token.trim().length > 512) return null;

			return { type: 'set-ngrok-auth-token', token: token.trim() };
		}

		if (type === 'dashboard-action') {
			const parsed = dashboardActionSchema.safeParse(raw);

			return parsed.success ? parsed.data : null;
		}

		if (type === 'clear-logs') {
			const source = record.source;

			if (source !== 'api' && source !== 'tunnel') {
				return null;
			}

			return { type: 'clear-logs', source };
		}

		for (const allowed of MSGS_SIMPLE) {
			if (allowed === type) {
				return { type: allowed };
			}
		}

		return null;
	}

	private getWebviewOptions(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
		return {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.file(this.getWebDistPath())]
		};
	}

	private getWebDistPath(): string {
		if (this.context.extensionMode === vscode.ExtensionMode.Development) {
			return path.join(this.context.extensionPath, '..', 'web', 'dist');
		}

		return path.join(this.context.extensionPath, 'bundled', 'web', 'dist');
	}

	private sendPort(): void {
		this.broadcast({ type: 'port', port: this.currentPort });
	}

	private sendBufferedLogs(source: 'api' | 'tunnel'): void {
		const maxEntries = dashboardLogEntryLimit();
		const { entries, entryIds } = SharedLogStore.readSnapshot(source, maxEntries);

		this.broadcast({ type: 'log-bulk', source, entries, entryIds, maxEntries });
	}

	private startLogPoll(): void {
		this.stopLogPoll();
		this.logPollTimer = setInterval(() => {
			this.pollSharedLogs('api');
			this.pollSharedLogs('tunnel');
		}, LOG_POLL_INTERVAL_MS);
	}

	private stopLogPoll(): void {
		if (this.logPollTimer) {
			clearInterval(this.logPollTimer);
			this.logPollTimer = null;
		}
	}

	private pollSharedLogs(source: 'api' | 'tunnel'): void {
		// Replace the bounded view so cross-window writes and clear tombstones converge.
		this.sendBufferedLogs(source);
	}

	private readHtmlSource(): string {
		this.htmlSource ??= fs.readFileSync(path.join(this.getWebDistPath(), 'index.html'), 'utf-8');

		return this.htmlSource;
	}

	private buildHtml(webview: vscode.Webview): string {
		const distPath = this.getWebDistPath();
		const assetsUri = webview.asWebviewUri(vscode.Uri.file(path.join(distPath, 'assets')));
		const faviconUri = webview.asWebviewUri(vscode.Uri.file(path.join(distPath, 'favicon.png')));

		let html = this.readHtmlSource();
		const nonce = randomUUID().replaceAll('-', '');
		const csp = `default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}'; connect-src 'none';`;
		html = html.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`);

		html = html.replace(/src="\/assets\//g, `src="${assetsUri.toString()}/`);
		html = html.replace(/href="\/assets\//g, `href="${assetsUri.toString()}/`);
		html = html.replace('href="/favicon.png"', `href="${faviconUri.toString()}"`);
		html = html.replace('</head>', `<script nonce="${nonce}">window.__TS__ = ${Date.now()};</script>\n\t</head>`);

		return html;
	}
}
