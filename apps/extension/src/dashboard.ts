import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
	dashboardActionSchema,
	type DashboardActionRequest,
	type ServiceState,
	type LogEntry,
	type TunnelState,
	type WebviewToExtension
} from '@ungate/shared/frontend';
import * as vscode from 'vscode';

import { DashboardApiBridge } from './dashboard-api-bridge';
import { SharedLogStore } from './runtime-state/shared-log-store';

const LOG_POLL_INTERVAL_MS = 500;

const MSGS_SIMPLE = ['webview-ready', 'restart-server', 'start-tunnel', 'stop-tunnel', 'restart-tunnel'] as const;

export type Msg =
	| { type: 'open-external-url'; url: string }
	| DashboardActionRequest
	| { type: 'clear-logs'; source: 'api' | 'tunnel' }
	| Extract<WebviewToExtension, { type: (typeof MSGS_SIMPLE)[number] }>;

export class Dashboard {
	private panel: vscode.WebviewPanel | null = null;
	private currentPort: number | null = null;
	private logPollTimer: NodeJS.Timeout | null = null;
	private htmlSource: string | null = null;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly onMessage: (message: Msg) => void
	) {
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
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.Active);

			return;
		}

		const panel = vscode.window.createWebviewPanel('ungate', 'Ungate', vscode.ViewColumn.Active, this.getWebviewOptions());
		this.panel = panel;
		panel.webview.html = this.buildHtml();
		panel.iconPath = vscode.Uri.file(path.join(this.context.extensionPath, 'resources', 'icon.png'));
		const bridge = new DashboardApiBridge(
			() => this.currentPort,
			(response) => {
				void panel.webview.postMessage(response);
			}
		);

		this.panel.webview.onDidReceiveMessage((message: unknown) => {
			if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'api-request') {
				void bridge.handle(message);

				return;
			}
			const parsed = Dashboard.parseIncomingMessage(message);

			if (!parsed) {
				return;
			}

			this.onMessage(parsed);
		});

		panel.onDidChangeViewState(() => {
			if (this.panel?.visible) {
				this.sendBufferedLogs('api');
				this.sendBufferedLogs('tunnel');
			}
		});

		panel.onDidDispose(() => {
			bridge.dispose();
			this.stopLogPoll();
			if (this.panel === panel) this.panel = null;
		});

		setTimeout(() => {
			if (this.panel === panel) this.startLogPoll();
		}, 0);
	}

	setPort(port: number | null): void {
		if (this.currentPort === port) {
			return;
		}

		this.currentPort = port;

		this.sendPort();
	}

	pushLog(source: 'api' | 'tunnel', entry: LogEntry): void {
		SharedLogStore.append(source, entry);

		this.panel?.webview.postMessage({ type: 'log', source, entry });
	}

	clearLogs(source: 'api' | 'tunnel'): void {
		SharedLogStore.clear(source);
		this.panel?.webview.postMessage({ type: 'logs-cleared', source });
	}

	sendInitialState(tunnelState: TunnelState): void {
		this.sendPort();
		this.sendBufferedLogs('api');
		this.sendBufferedLogs('tunnel');
		this.panel?.webview.postMessage({ type: 'tunnel-status', state: tunnelState });
	}

	sendServiceState(state: ServiceState): void {
		this.panel?.webview.postMessage({ type: 'service-state', state });
	}

	sendActionResult(id: string, result?: { error?: string; cancelled?: boolean }): void {
		this.panel?.webview.postMessage({ type: 'action-result', id, ...result });
	}

	sendTunnelState(state: TunnelState): void {
		this.panel?.webview.postMessage({ type: 'tunnel-status', state });
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
		this.panel?.webview.postMessage({ type: 'port', port: this.currentPort });
	}

	private sendBufferedLogs(source: 'api' | 'tunnel'): void {
		const entries = SharedLogStore.readAll(source);

		this.panel?.webview.postMessage({ type: 'log-bulk', source, entries });
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

	private buildHtml(): string {
		const distPath = this.getWebDistPath();
		const assetsUri = this.panel!.webview.asWebviewUri(vscode.Uri.file(path.join(distPath, 'assets')));
		const faviconUri = this.panel!.webview.asWebviewUri(vscode.Uri.file(path.join(distPath, 'favicon.png')));

		let html = this.readHtmlSource();
		const nonce = randomUUID().replaceAll('-', '');
		const csp = `default-src 'none'; img-src ${this.panel!.webview.cspSource} data:; style-src ${this.panel!.webview.cspSource} 'unsafe-inline'; script-src ${this.panel!.webview.cspSource} 'nonce-${nonce}'; connect-src 'none';`;
		html = html.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`);

		html = html.replace(/src="\/assets\//g, `src="${assetsUri.toString()}/`);
		html = html.replace(/href="\/assets\//g, `href="${assetsUri.toString()}/`);
		html = html.replace('href="/favicon.png"', `href="${faviconUri.toString()}"`);
		html = html.replace('</head>', `<script nonce="${nonce}">window.__TS__ = ${Date.now()};</script>\n\t</head>`);

		return html;
	}
}
