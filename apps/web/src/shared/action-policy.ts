import { dashboardActions, type DashboardAction } from '@ungate/shared/frontend';

const NON_BLOCKING_ACTIONS = new Set<DashboardAction>(['copy-api-key', 'copy-tunnel-url']);

/** Clipboard actions must not dim or disable the rest of the dashboard while the extension responds. */
export function blocksDashboardUi(action: DashboardAction): boolean {
	return !NON_BLOCKING_ACTIONS.has(action);
}

/** Only report success when the extension can verify an observable result. */
export function successNotice(action: DashboardAction): string | null {
	if (action === 'copy-tunnel-url') return 'Tunnel URL copied';
	if (action === 'copy-api-key') return 'API key copied';
	if (action === 'open-cursor-models' || action === 'reload-window') return null;

	return `${dashboardActions[action].title}: done`;
}
