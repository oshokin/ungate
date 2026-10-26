import { dashboardActions, type DashboardAction, type DashboardActionResult } from '@ungate/shared/frontend';

import { blocksDashboardUi } from './action-policy';
import { showToast } from './toast.svelte';
import { postExtensionMessage } from './vscode';

let busy = $state<DashboardAction | null>(null);
let inFlight: DashboardAction | null = null;
let pending: { id: string; resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | null = null;

window.addEventListener('message', (event: MessageEvent<DashboardActionResult>) => {
	const result = event.data;
	if (result?.type !== 'action-result' || result.id !== pending?.id) return;
	if (result.error) pending.reject(new Error(result.error));
	else pending.resolve();
});

export async function runDashboardAction(action: DashboardAction): Promise<void> {
	if (inFlight) throw new Error('Another Ungate action is still running.');
	const blocking = blocksDashboardUi(action);
	inFlight = action;
	if (blocking) busy = action;
	try {
		await new Promise<void>((resolve, reject) => {
			const id = crypto.randomUUID();
			const timer = setTimeout(() => reject(new Error('The action timed out. Check Logs before retrying.')), 180000);
			pending = { id, resolve, reject, timer };
			if (!postExtensionMessage({ type: 'dashboard-action', id, action })) reject(new Error('Open Ungate inside Cursor.'));
		});
		const notice =
			action === 'copy-tunnel-url'
				? 'Tunnel URL copied'
				: action === 'copy-api-key'
					? 'API key copied'
					: action === 'open-cursor-models'
						? null
						: `${dashboardActions[action].title}: done`;
		if (notice) showToast(notice, 'status');
	} catch (cause) {
		showToast(cause instanceof Error ? cause.message : String(cause), 'error');
		throw cause;
	} finally {
		if (pending) clearTimeout(pending.timer);
		pending = null;
		inFlight = null;
		if (blocking) busy = null;
	}
}

/** UI entry point; the store displays errors and never substitutes a success toast. */
export function performAction(action: DashboardAction): void {
	void runDashboardAction(action).catch(() => {});
}

export function getActionStore() {
	return {
		get busy() {
			return busy;
		}
	};
}
