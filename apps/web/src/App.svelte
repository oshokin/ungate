<script lang="ts">
import { onMount, tick } from 'svelte';
import IconGauge from 'virtual:icons/lucide/gauge';
import IconSettings from 'virtual:icons/lucide/settings';
import IconTerminal from 'virtual:icons/lucide/terminal';

import LogsPage from '$features/logs/LogsPage.svelte';
import SettingsPage from '$features/settings/SettingsPage.svelte';
import UsagePage from '$features/usage/UsagePage.svelte';
import DashboardActions from '$shared/DashboardActions.svelte';
import { getServiceStore } from '$shared/service-store.svelte';
import ServiceBanner from '$shared/ServiceBanner.svelte';
import Toast from '$shared/Toast.svelte';
import { type DashboardPage, getSavedPage, getSavedScrollPosition, savePage, saveScrollPosition } from '$shared/vscode';

const service = getServiceStore();
let currentPage = $state<DashboardPage>(getSavedPage());
let restoreFrame: number | null = null;
let restoreTimers: number[] = [];

const tabs: { id: DashboardPage; label: string; icon: typeof IconGauge }[] = [
	{ id: 'settings', label: 'Connection', icon: IconSettings },
	{ id: 'usage', label: 'Usage', icon: IconGauge },
	{ id: 'logs', label: 'Logs', icon: IconTerminal }
];

function persistCurrentScrollPosition(): void {
	saveScrollPosition(currentPage, window.scrollY);
}

function cancelPendingScrollRestore(): void {
	if (restoreFrame !== null) {
		cancelAnimationFrame(restoreFrame);
		restoreFrame = null;
	}

	for (const timer of restoreTimers) {
		clearTimeout(timer);
	}

	restoreTimers = [];
}

async function restoreScrollPosition(page: DashboardPage): Promise<void> {
	await tick();
	cancelPendingScrollRestore();
	const scrollPosition = getSavedScrollPosition(page);
	const restore = () => {
		if (currentPage !== page) {
			return;
		}

		restoreFrame = requestAnimationFrame(() => {
			window.scrollTo({ top: scrollPosition, behavior: 'auto' });
			restoreFrame = null;
		});
	};

	restore();
	restoreTimers = [100, 300, 750].map((delay) => window.setTimeout(restore, delay));
}

async function selectPage(page: DashboardPage): Promise<void> {
	persistCurrentScrollPosition();
	currentPage = page;
	savePage(page);
	await restoreScrollPosition(page);
}

onMount(() => {
	let saveFrame: number | null = null;

	const onScroll = () => {
		if (saveFrame !== null) {
			return;
		}

		saveFrame = requestAnimationFrame(() => {
			persistCurrentScrollPosition();
			saveFrame = null;
		});
	};

	const onUserScroll = () => {
		cancelPendingScrollRestore();
	};

	window.addEventListener('scroll', onScroll, { passive: true });
	window.addEventListener('wheel', onUserScroll, { passive: true });
	window.addEventListener('touchstart', onUserScroll, { passive: true });
	window.addEventListener('keydown', onUserScroll);
	void restoreScrollPosition(currentPage);

	return () => {
		window.removeEventListener('scroll', onScroll);
		window.removeEventListener('wheel', onUserScroll);
		window.removeEventListener('touchstart', onUserScroll);
		window.removeEventListener('keydown', onUserScroll);
		persistCurrentScrollPosition();

		if (saveFrame !== null) {
			cancelAnimationFrame(saveFrame);
		}

		cancelPendingScrollRestore();
	};
});
</script>

<div class="ug-app">
	<header class="ug-header">
		<nav
			class="ug-tabs"
			aria-label="Ungate pages">
			{#each tabs as tab}
				<button
					class="ug-tab"
					class:ug-selected={currentPage === tab.id}
					aria-current={currentPage === tab.id ? 'page' : undefined}
					onclick={() => void selectPage(tab.id)}>
					<tab.icon class="size-4" />{tab.label}
				</button>
			{/each}
		</nav>
		<DashboardActions />
	</header>
	<main class="ug-main">
		<ServiceBanner />
		{#if currentPage === 'settings'}
			<SettingsPage />
		{:else if currentPage === 'logs'}
			<LogsPage />
		{:else if service.state.status === 'ready'}
			<UsagePage />
		{/if}
	</main>
	<Toast />
</div>
