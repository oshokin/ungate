import { z } from 'zod';

/** Labels, command IDs and the webview allowlist share one definition. */
export const dashboardActions = {
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
}
