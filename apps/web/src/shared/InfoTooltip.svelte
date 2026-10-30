<script lang="ts">
import { onDestroy, type Snippet } from 'svelte';

interface Props {
	text: string;
	children: Snippet<[string]>;
}

let { text, children }: Props = $props();
const id = $props.id();
let anchor: HTMLSpanElement;
let tooltip: HTMLSpanElement;
let closeTimer: ReturnType<typeof setTimeout> | undefined;
let dismissed = false;
const edgeGap = 8;
const closeDelayMs = 150;

function position(): void {
	if (!tooltip?.matches(':popover-open')) return;
	const target = anchor.getBoundingClientRect();
	const box = tooltip.getBoundingClientRect();
	const left = Math.max(edgeGap, Math.min(target.left + (target.width - box.width) / 2, innerWidth - box.width - edgeGap));
	const below = target.bottom + edgeGap;
	const top = below + box.height <= innerHeight - edgeGap ? below : Math.max(edgeGap, target.top - box.height - edgeGap);
	tooltip.style.left = `${left}px`;
	tooltip.style.top = `${top}px`;
}

function show(): void {
	clearTimeout(closeTimer);
	if (dismissed) return;
	tooltip.showPopover();
	position();
}

function hide(): void {
	clearTimeout(closeTimer);
	tooltip?.hidePopover();
}

function scheduleHide(): void {
	dismissed = false;
	clearTimeout(closeTimer);
	closeTimer = setTimeout(hide, closeDelayMs);
}

function keydown(event: KeyboardEvent): void {
	if (event.key !== 'Escape' || !tooltip?.matches(':popover-open')) return;
	hide();
	dismissed = true;
}

onDestroy(() => clearTimeout(closeTimer));
</script>

<svelte:window
	onresize={position}
	onscroll={position}
	onkeydown={keydown} />

<span
	class="ug-tooltip-anchor"
	role="group"
	bind:this={anchor}
	onpointerenter={show}
	onpointerleave={scheduleHide}
	onfocusin={show}
	onfocusout={scheduleHide}>
	{@render children(id)}
	<span
		id={id}
		bind:this={tooltip}
		popover="manual"
		role="tooltip"
		class="ug-tooltip"
		onpointerenter={show}
		onpointerleave={scheduleHide}>
		{text}
	</span>
</span>
