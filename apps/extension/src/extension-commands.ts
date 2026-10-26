import { dashboardActions } from '@ungate/shared/frontend';

export const extensionCommands = {
	openDashboard: 'ungate.openDashboard',
	copyTunnelUrl: dashboardActions['copy-tunnel-url'].command,
	restartTunnel: dashboardActions['restart-tunnel'].command,
	openCursorModels: dashboardActions['open-cursor-models'].command
} as const;
