import * as vscode from 'vscode';

import { extensionCommands } from './extension-commands';

import type { ApiStatus as ApiBarStatus, ServiceState, TunnelState } from '@ungate/shared/frontend';

export type UngateConnectionStatus = 'ready' | 'connecting' | 'restart' | 'offline';

/** Node's resolver names an IPv4 lookup "queryA". The tooltip shows what to do instead. */
function readablePublicError(error: string | null | undefined): string {
	if (!error) return 'health check failed';
	if (error.includes('queryA') || error.includes('ENOTFOUND') || error.includes('EAI_AGAIN'))
		return 'Tunnel address does not resolve. Restart the tunnel.';

	return error;
}

export class ExtensionStatusBar {
	public static connectionStatus(
		apiState: ApiBarStatus,
		tunnel: TunnelState,
		serviceStatus?: ServiceState['status']
	): UngateConnectionStatus {
		const transport =
			apiState === 'running' && tunnel.status === 'running' && tunnel.publicStatus === 'reachable'
				? 'ready'
				: apiState === 'starting' ||
					  tunnel.status === 'starting' ||
					  tunnel.status === 'installing' ||
					  (tunnel.status === 'running' &&
							(tunnel.publicStatus === 'checking' || tunnel.publicStatus === 'unchecked' || !tunnel.publicStatus))
					? 'connecting'
					: 'offline';
		// A reachable old build is not ready. The dashboard already asks for a restart.
		if (transport === 'ready' && serviceStatus === 'incompatible') return 'restart';

		return transport;
	}

	public static statusText(status: UngateConnectionStatus): string {
		const labels: Record<UngateConnectionStatus, string> = {
			ready: '$(check) Ungate: Ready',
			connecting: '$(sync~spin) Ungate: Connecting',
			restart: '$(warning) Ungate: Not ready',
			offline: '$(warning) Ungate: Not ready'
		};

		return labels[status];
	}

	public static accessibilityLabel(status: UngateConnectionStatus): string {
		const labels: Record<UngateConnectionStatus, string> = {
			ready: 'Ungate ready. API and public tunnel are available.',
			connecting: 'Ungate connecting. API or public tunnel is being checked.',
			restart: 'Ungate shared API restart required. The running build does not match this window.',
			offline: 'Ungate offline. API or public tunnel is unavailable.'
		};

		return labels[status];
	}

	public static formatApiTip(
		apiState: ApiBarStatus,
		apiUrl: string | null,
		apiError: string | null,
		serviceMessage?: string | null
	): string {
		const statusLine: Record<ApiBarStatus, string> = {
			starting: '$(sync~spin) API: starting',
			running: '$(check) API: running',
			stopped: '$(circle-slash) API: stopped',
			error: '$(error) API: error'
		};
		const details = [statusLine[apiState]];

		// The build note explains the API line. It stays with that line, not under the tunnel.
		if (serviceMessage) details.push(serviceMessage);
		if (apiUrl) details.push(`Local: \`${apiUrl}\``);
		// Health-check failures can wrap the same service diagnosis with a process prefix.
		if (apiError && !(serviceMessage && apiError.includes(serviceMessage))) {
			details.push(`Last error: ${apiError}`);
		}

		return details.join('\n\n');
	}

	public static formatTunnelTip(tunnel: TunnelState, tunnelApiUrl: string | null): string {
		if (tunnelApiUrl) {
			const publicRoute =
				tunnel.publicStatus === 'reachable'
					? '$(check) Public route: reachable'
					: tunnel.publicStatus === 'unreachable'
						? `$(error) Public route: unavailable (${readablePublicError(tunnel.publicError)})`
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
		tunnelApiUrl: string | null,
		serviceMessage?: string | null
	): vscode.MarkdownString {
		const tip = new vscode.MarkdownString('', true);
		tip.isTrusted = true;

		tip.appendMarkdown(`**${this.statusText(status).replace(/\$\([^)]+\)\s*/u, '')}**`);
		tip.appendMarkdown('\n\n');
		tip.appendMarkdown(this.formatApiTip(apiState, apiUrl, apiError, serviceMessage));
		tip.appendMarkdown('\n\n');
		tip.appendMarkdown(this.formatTunnelTip(tunnel, tunnelApiUrl));

		tip.appendMarkdown('\n\n---\n\n');

		const restartLabel = this.tunnelRestartLabel(tunnel);
		const actions: string[] = [
			`[$(layout-panel) Open Dashboard](command:${extensionCommands.openDashboard})`,
			`[$(debug-restart) Restart API](command:${extensionCommands.restartApi})`,
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
