import { Api } from '$shared/api';
import { DashboardClient } from '$shared/dashboard-client';

import type { SubscriptionUsage, UsagePreferences, UsageState } from '@ungate/shared/frontend';

let data = $state<SubscriptionUsage | null>(null);
let loading = $state(false);
let error = $state<string | null>(null);
let activeRequest: Promise<void> | null = null;
let preferences = $state<UsagePreferences>({
	autoRefresh: false,
	intervalSeconds: 60,
	widgets: { claude: false, openai: false, minimax: false }
});
window.addEventListener('message', (event: MessageEvent<{ type: string; state: UsageState }>) => {
	if (event.data?.type !== 'usage-state') return;
	const state = event.data.state;
	// Structured-cloned snapshots can repeat unchanged data. Keep reactive identities
	// stable so background messages do not invalidate the provider cards or drafts.
	if (JSON.stringify(data) !== JSON.stringify(state.data)) data = state.data;
	if (JSON.stringify(preferences) !== JSON.stringify(state.preferences)) preferences = state.preferences;
	loading = state.loading;
	error = state.error;
});

function load(refresh = false): Promise<void> {
	if (activeRequest) return activeRequest;
	loading = true;
	error = null;
	activeRequest = Api.fetchUsage(refresh)
		.then((result) => {
			data = result;
		})
		.catch((cause: unknown) => {
			error = cause instanceof Error ? cause.message : String(cause);
		})
		.finally(() => {
			loading = false;
			activeRequest = null;
		});

	return activeRequest;
}

function ensureLoaded(): void {
	void load();
	void DashboardClient.request<UsagePreferences>('GET', '/usage/preferences')
		.then((value) => {
			preferences = value;
		})
		.catch(() => {});
}

export function getUsageStore() {
	return {
		get preferences() {
			return preferences;
		},
		async savePreferences(patch: Record<string, boolean | number>): Promise<void> {
			preferences = await DashboardClient.request<UsagePreferences>('POST', '/usage/preferences', patch);
		},
		get data() {
			return data;
		},
		get loading() {
			return loading;
		},
		get error() {
			return error;
		},
		ensureLoaded,
		refresh(): Promise<void> {
			return load(true);
		}
	};
}
