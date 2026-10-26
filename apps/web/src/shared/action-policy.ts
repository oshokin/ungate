import type { DashboardAction } from '@ungate/shared/frontend';

const NON_BLOCKING_ACTIONS = new Set<DashboardAction>(['copy-api-key', 'copy-tunnel-url']);

/** Clipboard actions must not dim or disable the rest of the dashboard while the extension responds. */
export function blocksDashboardUi(action: DashboardAction): boolean {
	return !NON_BLOCKING_ACTIONS.has(action);
}
