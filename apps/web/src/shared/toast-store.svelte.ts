import { UI_TIMING } from '@ungate/shared/frontend';
import { SvelteSet } from 'svelte/reactivity';

export type ToastTone = 'error' | 'status';

export interface ToastAction {
	label: string;
	run(): void;
}

interface ToastState {
	id: number;
	message: string;
	tone: ToastTone;
	action?: ToastAction;
	remaining: number | null;
}

let current = $state<ToastState | null>(null);
const queue: ToastState[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let timerStartedAt = 0;
let nextId = 0;
const pauseReasons = new SvelteSet<'focus' | 'hover'>();

function priority(toast: ToastState): number {
	if (toast.tone === 'error') return 2;

	return toast.action ? 1 : 0;
}

function isPersistent(toast: ToastState): boolean {
	return priority(toast) > 0;
}

function startTimer(): void {
	if (!current || isPersistent(current) || current.remaining === null || pauseReasons.size > 0) return;
	timerStartedAt = Date.now();
	const id = current.id;
	timer = setTimeout(() => {
		if (current?.id === id) dismissToast();
	}, current.remaining);
}

function activate(toast: ToastState | null): void {
	if (timer) clearTimeout(timer);
	timer = null;
	if (!toast) pauseReasons.clear();
	current = toast;
	startTimer();
}

function takeNext(): ToastState | null {
	const highestPriority = Math.max(...queue.map(priority));
	const index = queue.findIndex((toast) => priority(toast) === highestPriority);

	return queue.splice(index, 1)[0] ?? null;
}

export function dismissToast(): void {
	activate(takeNext());
}

/** Queues notices by priority. Errors and actionable notices stay until dismissed. */
export function showToast(message: string, tone: ToastTone, action?: ToastAction): void {
	const toast: ToastState = {
		id: ++nextId,
		message,
		tone,
		...(action ? { action } : {}),
		remaining: tone === 'status' && !action ? UI_TIMING.statusNoticeMs : null
	};
	if (!current) {
		activate(toast);

		return;
	}
	if (priority(toast) > priority(current)) {
		if (timer && current.remaining !== null) current.remaining = Math.max(0, current.remaining - (Date.now() - timerStartedAt));
		queue.unshift(current);
		activate(toast);

		return;
	}
	queue.push(toast);
}

export function pauseToast(reason: 'focus' | 'hover'): void {
	if (pauseReasons.has(reason)) return;
	pauseReasons.add(reason);
	if (!timer || current?.remaining === null || !current) return;
	current.remaining = Math.max(0, current.remaining - (Date.now() - timerStartedAt));
	clearTimeout(timer);
	timer = null;
}

export function resumeToast(reason: 'focus' | 'hover'): void {
	pauseReasons.delete(reason);
	startTimer();
}

export function runToastAction(): void {
	const action = current?.action;
	if (!action) return;
	try {
		action.run();
	} finally {
		dismissToast();
	}
}

/** Announce a changing message once, including the same text after it is cleared. */
export function createToastWatcher(): (message: string | null, tone: ToastTone) => void {
	let previous = '';

	return (message, tone) => {
		if (!message) {
			previous = '';

			return;
		}
		if (message === previous) return;
		previous = message;
		showToast(message, tone);
	};
}

export function getToastStore() {
	return {
		get current() {
			return current;
		},
		dismiss: dismissToast,
		pause: pauseToast,
		resume: resumeToast,
		runAction: runToastAction
	};
}
