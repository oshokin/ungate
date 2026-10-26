import { Api } from '$shared/api';

import type { SubscriptionUsage } from '@ungate/shared/frontend';

let data = $state<SubscriptionUsage | null>(null);
let loading = $state(false);
let error = $state<string | null>(null);
let activeRequest: Promise<void> | null = null;

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
}

export function getUsageStore() {
	return {
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
