import { normalizeLogEntryLimit } from '@ungate/shared/frontend';
import * as vscode from 'vscode';

/** Application scope: all local/SSH dashboard windows read the same user preference. */
export function dashboardLogEntryLimit(): number {
	return normalizeLogEntryLimit(vscode.workspace.getConfiguration('ungate').inspect<number>('logs.maxEntries')?.globalValue);
}
