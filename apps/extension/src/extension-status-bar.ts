import * as vscode from 'vscode';

import { extensionCommands } from './extension-commands';

import type { ApiStatus as ApiBarStatus, TunnelState } from '@ungate/shared/frontend';

export type UngateConnectionStatus = 'ready' | 'connecting' | 'offline';

export class ExtensionStatusBar {
	public static connectionStatus(apiState: ApiBarStatus, tunnel: TunnelState): UngateConnectionStatus {
		if (apiState === 'running' && tunnel.status === 'running' && tunnel.publicStatus === 'reachable') {
			return 'ready';
		}

		if (
			apiState === 'starting' ||
			tunnel.status === 'starting' ||
			tunnel.status === 'installing' ||
			(tunnel.status === 'running' &&
				(tunnel.publicStatus === 'checking' || tunnel.publicStatus === 'unchecked' || !tunnel.publicStatus))
		) {
			return 'connecting';
		}

		return 'offline';
	}

	public static statusText(status: UngateConnectionStatus): string {
		const labels: Record<UngateConnectionStatus, string> = {
			ready: '$(check) Ungate: Ready',
			connecting: '$(sync~spin) Ungate: Connecting',
			offline: '$(warning) Ungate: Offline'
		};

		return labels[status];
	}

	public static accessibilityLabel(status: UngateConnectionStatus): string {
		const labels: Record<UngateConnectionStatus, string> = {
			ready: 'Ungate ready. API and public tunnel are available.',
			connecting: 'Ungate connecting. API or public tunnel is being checked.',
			offline: 'Ungate offline. API or public tunnel is unavailable.'
		};

		return labels[status];
	}

	public static formatApiTip(apiState: ApiBarStatus, apiUrl: string | null, apiError: string | null): string {
		const statusLine: Record<ApiBarStatus, string> = {
			starting: '$(sync~spin) API: starting',
			running: '$(check) API: running',
			stopped: '$(circle-slash) API: stopped',
			error: '$(error) API: error'
		};
		const details = [statusLine[apiState]];

		if (apiUrl) details.push(`Local: \`${apiUrl}\``);
		if (apiError) details.push(`Last error: ${apiError}`);

		return details.join('\n\n');
	}

	public static formatTunnelTip(tunnel: TunnelState, tunnelApiUrl: string | null): string {
		if (tunnelApiUrl) {
			const publicRoute =
				tunnel.publicStatus === 'reachable'
					? '$(check) Public route: reachable'
					: tunnel.publicStatus === 'unreachable'
						? `$(error) Public route: unavailable (${tunnel.publicError ?? 'health check failed'})`
						: '$(sync~spin) Public route: checking';

			return `$(globe) Tunnel process: running\n\n${publicRoute}\n\n\`${tunnelApiUrl}\``;
		}

		if (tunnel.status === 'starting' || tunnel.status === 'installing') {
			return `$(sync~spin) Tunnel: starting (${tunnel.status}...)`;
		}

		if (tunnel.status === 'error' && tunnel.error) {
			return `$(error) Tunnel: failed (${tunnel.error})`;
		}

		return '$(circle-slash) Tunnel: not started';
	}

	public static tunnelRestartLabel(tunnel: TunnelState): string {
		if (tunnel.status === 'stopped') {
			return 'Start tunnel';
		}

		return 'Restart tunnel';
	}

	public static createTooltip(
		status: UngateConnectionStatus,
		apiState: ApiBarStatus,
		apiUrl: string | null,
		apiError: string | null,
		tunnel: TunnelState,
		tunnelApiUrl: string | null
	): vscode.MarkdownString {
		const tip = new vscode.MarkdownString('', true);
		tip.isTrusted = true;

		tip.appendMarkdown(`**${this.statusText(status).replace(/\$\([^)]+\)\s*/u, '')}**`);
		tip.appendMarkdown('\n\n');
		tip.appendMarkdown(this.formatApiTip(apiState, apiUrl, apiError));
		tip.appendMarkdown('\n\n');
		tip.appendMarkdown(this.formatTunnelTip(tunnel, tunnelApiUrl));

		tip.appendMarkdown('\n\n---\n\n');

		const restartLabel = this.tunnelRestartLabel(tunnel);
		const actions: string[] = [
			`[$(layout-panel) Open Dashboard](command:${extensionCommands.openDashboard})`,
			`[$(debug-restart) ${restartLabel}](command:${extensionCommands.restartTunnel})`
		];

		if (tunnelApiUrl) {
			actions.push(`[$(clippy) Copy URL](command:${extensionCommands.copyTunnelUrl})`);
		}

		actions.push(`[$(settings-gear) Cursor Models](command:${extensionCommands.openCursorModels})`);

		tip.appendMarkdown(actions.join(' · '));

		return tip;
	}
}
