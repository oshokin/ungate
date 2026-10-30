<script lang="ts">
import { tick, untrack } from 'svelte';

import { Formatter } from '$shared/formatter';
import { type LogSource, saveLogPanelHeight } from '$shared/vscode';

import { LOG_PANEL } from './log-tail';

import type { LogEntry } from '@ungate/shared/frontend';

interface Props {
	source: LogSource;
	entries: LogEntry[];
	revision: number;
	initialHeight: number;
	oncopy: () => Promise<void>;
	onclear: () => void;
	copied: boolean;
}

let { source, entries, revision, initialHeight, oncopy, onclear, copied }: Props = $props();
let height = $state(untrack(() => clampHeight(initialHeight)));
let following = $state(true);
let unseen = $state(0);
let panel: HTMLDivElement | null = null;
let previousRevision = 0;
let initialized = false;
let drag: { pointerId: number; startY: number; startHeight: number } | null = null;
const label = $derived(source === 'api' ? 'API' : 'Tunnel');

$effect(() => {
	const currentRevision = revision;
	const currentLength = entries.length;
	untrack(() => updateTail(currentRevision, currentLength));
});

function clampHeight(value: number): number {
	return Math.round(Math.max(LOG_PANEL.minHeight, Math.min(LOG_PANEL.maxHeight, value)));
}

function setHeight(value: number, persist = true): void {
	height = clampHeight(value);
	if (persist) saveLogPanelHeight(source, height);
	if (following) void scrollToTail();
}

function beginResize(event: PointerEvent): void {
	if (!(event.currentTarget instanceof HTMLElement)) return;
	event.preventDefault();
	event.currentTarget.setPointerCapture(event.pointerId);
	drag = { pointerId: event.pointerId, startY: event.clientY, startHeight: height };
}

function continueResize(event: PointerEvent): void {
	if (drag?.pointerId !== event.pointerId) return;
	setHeight(drag.startHeight + event.clientY - drag.startY, false);
}

function endResize(event: PointerEvent): void {
	if (drag?.pointerId !== event.pointerId) return;
	drag = null;
	saveLogPanelHeight(source, height);
}

function handleResizeKey(event: KeyboardEvent): void {
	const step = event.shiftKey ? LOG_PANEL.largeResizeStep : LOG_PANEL.resizeStep;
	const next =
		event.key === 'ArrowUp'
			? height - step
			: event.key === 'ArrowDown'
				? height + step
				: event.key === 'Home'
					? LOG_PANEL.minHeight
					: event.key === 'End'
						? LOG_PANEL.maxHeight
						: null;
	if (next === null) return;
	event.preventDefault();
	setHeight(next);
}

function updateTail(currentRevision: number, currentLength: number): void {
	if (!initialized) {
		initialized = true;
		previousRevision = currentRevision;
		void scrollToTail();

		return;
	}
	if (currentLength === 0) {
		// A cleared panel starts a fresh live tail, not an empty paused reading session.
		following = true;
		previousRevision = currentRevision;
		unseen = 0;

		return;
	}
	const added = Math.max(0, currentRevision - previousRevision);
	previousRevision = currentRevision;
	if (added === 0) {
		if (following) void scrollToTail();

		return;
	}
	if (following) void scrollToTail();
	else unseen += added;
}

async function scrollToTail(): Promise<void> {
	await tick();
	if (!panel) return;
	panel.scrollTop = panel.scrollHeight;
	following = true;
	unseen = 0;
}

function handleLogScroll(event: Event): void {
	if (!(event.currentTarget instanceof HTMLElement)) return;
	const distance = event.currentTarget.scrollHeight - event.currentTarget.scrollTop - event.currentTarget.clientHeight;
	following = distance <= LOG_PANEL.tailThreshold;
	if (following) unseen = 0;
}

function handleVisibilityChange(): void {
	if (document.visibilityState === 'visible') void scrollToTail();
}
</script>

<svelte:document onvisibilitychange={handleVisibilityChange} />

<section
	class="ug-stack"
	aria-label={`${label} logs`}>
	<div class="ug-row">
		<h2 class="ug-section-title">{label} logs</h2>
		<div class="ug-toolbar">
			{#if height !== LOG_PANEL.defaultHeight}
				<button
					class="ug-button"
					onclick={() => setHeight(LOG_PANEL.defaultHeight)}
					title="Reset to default height">Reset height</button>
			{/if}
			<button
				class="ug-button"
				onclick={() => void oncopy()}>{copied ? 'Copied' : 'Copy logs'}</button>
			<button
				class="ug-button"
				onclick={onclear}>Clear</button>
		</div>
	</div>
	<div class="ug-log-panel-wrap">
		<!-- svelte-ignore a11y_no_noninteractive_tabindex (Scrollable logs need keyboard focus.) -->
		<div
			id={`${source}-log-panel`}
			class="ug-log-panel"
			bind:this={panel}
			tabindex="0"
			role="region"
			style:height={`${height}px`}
			onscroll={handleLogScroll}
			aria-label={`${label} log entries`}
			aria-describedby={`${source}-log-resize-help`}>
			{#if entries.length === 0}
				<p class="ug-muted">No log entries</p>
			{:else}
				{#each entries as entry}
					<div class="ug-log-row">
						<time
							class="ug-log-time"
							datetime={new Date(entry.timestamp).toISOString()}>{Formatter.date(entry.timestamp)}</time>
						<span
							class="ug-log-level"
							class:ug-log-error={entry.level === 'error'}
							class:ug-log-warning={entry.level === 'warn'}>{entry.level}</span>
						<span class="ug-log-message">{entry.message}</span>
					</div>
				{/each}
			{/if}
		</div>
		{#if !following && unseen > 0}
			<button
				class="ug-new-logs"
				onclick={() => void scrollToTail()}
				aria-label={`${unseen} new ${label} log ${unseen === 1 ? 'entry' : 'entries'}. Jump to latest.`}>
				↓ {unseen} new
			</button>
		{/if}
	</div>
	<!-- svelte-ignore a11y_no_noninteractive_tabindex (A focusable ARIA separator is the window-splitter keyboard pattern.) -->
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions (The separator implements pointer and keyboard resizing.) -->
	<div
		class="ug-log-resize-handle"
		role="separator"
		tabindex="0"
		aria-label={`Resize ${label} logs vertically`}
		aria-controls={`${source}-log-panel`}
		aria-orientation="horizontal"
		aria-valuemin={LOG_PANEL.minHeight}
		aria-valuemax={LOG_PANEL.maxHeight}
		aria-valuenow={height}
		onpointerdown={beginResize}
		onpointermove={continueResize}
		onpointerup={endResize}
		onpointercancel={endResize}
		onlostpointercapture={endResize}
		onkeydown={handleResizeKey}></div>
	<p
		id={`${source}-log-resize-help`}
		class="ug-sr-only">Vertically resizable. Focus the resize handle and use Up or Down to resize.</p>
</section>
