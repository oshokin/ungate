<script lang="ts">
import { sleep } from '@ungate/shared/frontend';
import IconCheck from 'virtual:icons/lucide/check';
import IconLoader from 'virtual:icons/lucide/loader-circle';
import IconLogOut from 'virtual:icons/lucide/log-out';
import IconRotateCcw from 'virtual:icons/lucide/rotate-ccw';

import { Api } from '$shared/api';
import { createToastWatcher } from '$shared/toast-store.svelte';
import { postExtensionMessage } from '$shared/vscode';

interface Props {
	onAuthStatusChange?: () => void;
	onConnected?: () => void | Promise<void>;
}

let { onAuthStatusChange, onConnected }: Props = $props();

let authenticated = $state(false);
let email = $state<string | undefined>(undefined);
let loading = $state(true);
let checking = $state(false);
let error = $state<string | null>(null);
const watchError = createToastWatcher();

$effect(() => watchError(error, 'error'));
let pollingTimer = $state<ReturnType<typeof setInterval> | null>(null);
let timeoutAbort: AbortController | null = null;
let lastAction = $state('');
let cancelled = $state(false);

function stopPolling() {
	if (pollingTimer) {
		clearInterval(pollingTimer);
		pollingTimer = null;
	}

	if (timeoutAbort) {
		timeoutAbort.abort();
		timeoutAbort = null;
	}
}

$effect(() => {
	void loadStatus();
});

async function loadStatus() {
	loading = true;
	error = null;

	try {
		const status = await Api.authChatGPTStatus();
		authenticated = status.authenticated;
		email = status.email;
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	}

	loading = false;
}

async function handleLogin() {
	error = null;
	checking = true;
	cancelled = false;
	lastAction = 'Authorization started';
	stopPolling();

	try {
		const result = await Api.authChatGPTStart();
		postExtensionMessage({ type: 'open-external-url', url: result.authUrl });
		lastAction = 'Waiting for OpenAI callback';
		pollingTimer = setInterval(() => {
			void (async () => {
				try {
					const status = await Api.authChatGPTStatus();
					if (status.authenticated) {
						stopPolling();
						authenticated = true;
						email = status.email;
						checking = false;
						lastAction = 'Authorization completed';
						onAuthStatusChange?.();
						await onConnected?.();
					}
				} catch (e) {
					error = e instanceof Error ? e.message : String(e);
					lastAction = 'Status check failed';
				}
			})();
		}, 1000);

		if (timeoutAbort) {
			timeoutAbort.abort();
		}

		timeoutAbort = new AbortController();
		const timeoutSignal = timeoutAbort.signal;
		void sleep(300_000, timeoutSignal)
			.then(() => {
				stopPolling();

				if (checking) {
					checking = false;
					error = 'Authorization timed out';
					lastAction = 'Authorization timed out';
				}
			})
			.catch(() => {});
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
		checking = false;
		lastAction = 'Failed to start authorization';
		stopPolling();
	}
}

function handleCancel() {
	stopPolling();
	checking = false;
	cancelled = true;
	error = null;
	lastAction = 'Authorization cancelled by user';
}

function handleRetry() {
	cancelled = false;
	error = null;
	void handleLogin();
}

async function handleLogout() {
	error = null;

	try {
		await Api.authChatGPTLogout();
		authenticated = false;
		email = undefined;
		cancelled = false;
		lastAction = 'Disconnected';
		stopPolling();
		onAuthStatusChange?.();
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
		lastAction = 'Failed to disconnect';
	}
}
</script>

<div class="ug-panel p-5 space-y-4">
	<p class="text-sm font-semibold">ChatGPT</p>

	{#if loading}
		<div class="flex items-center gap-2 text-sm ug-description">
			<IconLoader class="size-4 animate-spin" />
			Checking status...
		</div>
	{:else if authenticated}
		<div class="space-y-3">
			<div class="flex items-center gap-2 text-sm">
				<IconCheck class="size-4 ug-success" />
				<span>Connected{email ? ` as ${email}` : ''}</span>
			</div>
			<button
				class="ug-button w-fit"
				onclick={handleLogout}>
				<IconLogOut class="size-4" />
				Disconnect
			</button>
		</div>
	{:else if checking}
		<div class="space-y-3">
			<div class="flex items-center gap-2 text-sm ug-description">
				<IconLoader class="size-4 animate-spin" />
				Waiting for authorization...
			</div>
			<div class="flex gap-2">
				<button
					class="ug-button"
					type="button"
					onclick={handleCancel}>
					Cancel
				</button>
			</div>
		</div>
	{:else if cancelled}
		<div class="space-y-3">
			<p class="text-sm ug-description">Cancelled.</p>
			<button
				class="ug-button ug-primary w-fit"
				type="button"
				onclick={handleRetry}>
				<IconRotateCcw class="size-4" />
				Retry
			</button>
		</div>
	{:else}
		<p class="text-sm ug-description">Not connected.</p>
		<button
			class="ug-button ug-primary"
			onclick={handleLogin}>
			Connect ChatGPT
		</button>
	{/if}

	{#if lastAction}
		<p class="text-xs ug-description">{lastAction}</p>
	{/if}
</div>
