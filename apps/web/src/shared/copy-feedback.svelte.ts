import { UI_TIMING } from '@ungate/shared/frontend';
import { onDestroy } from 'svelte';

/** One component-owned feedback timer, reset on repeated copy and cancelled on teardown. */
export function createCopyFeedback<T>() {
	let value = $state<T | null>(null);
	let timer: ReturnType<typeof setTimeout> | undefined;
	onDestroy(() => clearTimeout(timer));

	return {
		get value() {
			return value;
		},
		mark(next: T): void {
			clearTimeout(timer);
			value = next;
			timer = setTimeout(() => {
				value = null;
			}, UI_TIMING.copyFeedbackMs);
		}
	};
}
