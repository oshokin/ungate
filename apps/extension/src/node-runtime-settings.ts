import * as os from 'node:os';

import * as vscode from 'vscode';

import { NodeResolver } from './utils/node-resolver';

export function configuredNodePath(): string | undefined {
	// This is a local machine executable, never a workspace-controlled command.
	const setting = vscode.workspace.getConfiguration('ungate').inspect<string>('nodePath')?.globalValue;

	return typeof setting === 'string' && setting.trim() ? setting.trim() : process.env.UNGATE_NODE_BIN;
}

export async function chooseNodeRuntime(): Promise<boolean> {
	const selected = await vscode.window.showOpenDialog({
		title: 'Choose Node.js 24 LTS executable',
		openLabel: 'Use Node.js',
		// Keep the picker on the UI host even when the workspace uses Remote SSH.
		defaultUri: vscode.Uri.file(os.homedir()),
		canSelectFiles: true,
		canSelectFolders: false,
		canSelectMany: false,
		...(process.platform === 'win32' ? { filters: { Executables: ['exe'] } } : {})
	});
	if (!selected?.[0]) return false;
	if (selected[0].scheme !== 'file') throw new Error('Choose a Node.js executable on this computer, not on the SSH host.');
	const runtime = NodeResolver.resolve(selected[0].fsPath);
	await vscode.workspace.getConfiguration('ungate').update('nodePath', runtime, vscode.ConfigurationTarget.Global);

	return true;
}
