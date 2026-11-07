import { z } from 'zod';

/** Labels, command IDs and the webview allowlist share one definition. */
export const dashboardActions = {
	'open-extension-settings': { command: 'ungate.openExtensionSettings', title: 'Extension Settings' },
	'open-provider-timeout-settings': { command: 'ungate.openProviderTimeoutSettings', title: 'Provider Response Timeout' },
	'open-tunnel-timeout-settings': { command: 'ungate.openTunnelTimeoutSettings', title: 'Tunnel Connection Timeout' },
	'open-log-settings': { command: 'ungate.openLogSettings', title: 'Log Viewer Settings' },
	'choose-node-runtime': { command: 'ungate.chooseNodeRuntime', title: 'Choose Node.js Executable' },
	'open-cursor-models': { command: 'ungate.openCursorModels', title: 'Open Cursor Models' },
	'copy-tunnel-url': { command: 'ungate.copyTunnelUrl', title: 'Copy Tunnel URL' },
	'copy-api-key': { command: 'ungate.copyApiKey', title: 'Copy API Key' },
	'reload-window': { command: 'ungate.reloadWindow', title: 'Reload Window' },
	'start-tunnel': { command: 'ungate.startTunnel', title: 'Start Tunnel' },
	'restart-tunnel': { command: 'ungate.restartTunnel', title: 'Restart Tunnel' },
	'stop-tunnel': { command: 'ungate.stopTunnel', title: 'Stop Tunnel Only' },
	'restart-services': { command: 'ungate.restartServices', title: 'Restart Shared API' },
	'stop-services': { command: 'ungate.stopServices', title: 'Stop Shared API and Tunnel' }
} as const;

export type DashboardAction = keyof typeof dashboardActions;
export const dashboardActionSchema = z
	.object({
		type: z.literal('dashboard-action'),
		id: z.string().min(1).max(128),
		action: z.enum(Object.keys(dashboardActions) as [DashboardAction, ...DashboardAction[]])
	})
	.strict();

export type DashboardActionRequest = z.infer<typeof dashboardActionSchema>;
export interface DashboardActionResult {
	type: 'action-result';
	id: string;
	error?: string;
	cancelled?: boolean;
}
