import * as vscode from 'vscode';

/** Cursor's private navigation command is capability-checked, never used as a route setter. */
export async function openCursorModels(): Promise<void> {
	const commands = await vscode.commands.getCommands(true);
	if (commands.includes('aiSettings.action.open')) {
		await vscode.commands.executeCommand('aiSettings.action.open', 'models');

		return;
	}
	if (commands.includes('aiSettings.action.openhidden')) {
		await vscode.commands.executeCommand('aiSettings.action.openhidden');
		void vscode.window.showInformationMessage(
			'Select Models in Cursor Settings. This Cursor build does not expose direct Models navigation.'
		);

		return;
	}
	await vscode.commands.executeCommand('workbench.action.quickOpen', '>Cursor Settings');
	void vscode.window.showInformationMessage(
		'Open Cursor Settings, then Models. Direct settings navigation is unavailable in this editor.'
	);
}
