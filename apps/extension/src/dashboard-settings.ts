import { normalizeLogEntryLimit } from '@ungate/shared/frontend';
import * as vscode from 'vscode';

import { normalizeTunnelConnectTimeoutMs } from './tunnel-connect';

/** Application scope: all local/SSH dashboard windows read the same user preference. */
export function dashboardLogEntryLimit(): number {
	return normalizeLogEntryLimit(vscode.workspace.getConfiguration('ungate').inspect<number>('logs.maxEntries')?.globalValue);
}

/** Machine scope: a workspace cannot change how long this computer waits for cloudflared. */
export function tunnelConnectTimeoutMs(): number {
	return normalizeTunnelConnectTimeoutMs(
		vscode.workspace.getConfiguration('ungate').inspect<number>('tunnel.connectTimeoutSeconds')?.globalValue
	);
}
