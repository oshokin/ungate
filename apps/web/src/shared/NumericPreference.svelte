<script lang="ts">
import { onMount } from 'svelte';

import { postExtensionMessage } from './vscode';

import type { DashboardPreferenceKey } from '@ungate/shared/frontend';

let {
	preference,
	label,
	min,
	max,
	help
}: {
	preference: DashboardPreferenceKey;
	label: string;
	min: number;
	max: number;
	help: string;
} = $props();
let value = $state('');
let actual = $state<number | null>(null);
let feedback = $state('');
let pending = $state(false);
let invalid = $state(false);

onMount(() => {
	const receive = (event: MessageEvent): void => {
		const message = event.data;
		if (message?.type === 'dashboard-preferences' && typeof message.values?.[preference] === 'number') {
			actual = message.values[preference];
			value = String(actual);
		}
		if (message?.type === 'dashboard-preference-result' && message.key === preference) {
			pending = false;
			invalid = !!message.error;
			feedback = message.error ?? 'Saved';
		}
	};
	window.addEventListener('message', receive);
	postExtensionMessage({ type: 'get-dashboard-preferences' });

	return () => window.removeEventListener('message', receive);
});

function save(): void {
	const number = Number(value);
	invalid = !value.trim() || !Number.isInteger(number) || number < min || number > max;
	if (invalid) {
		feedback = `Enter ${min}–${max}.`;

		return;
	}
	if (number === actual || pending) return;
	pending = true;
	feedback = 'Saving…';
	if (!postExtensionMessage({ type: 'set-dashboard-preference', key: preference, value: number })) {
		pending = false;
		invalid = true;
		feedback = 'Open in Cursor to save.';
	}
}
</script>

<div>
	<label class="ug-label"
		>{label}<input
			class="ug-input"
			type="number"
			min={min}
			max={max}
			step="1"
			value={value}
			disabled={actual === null || pending}
			aria-invalid={invalid}
			oninput={(event) => {
				value = event.currentTarget.value;
				feedback = '';
				invalid = false;
			}}
			onblur={save}
			onkeydown={(event) => {
				if (event.key === 'Enter') {
					event.preventDefault();
					save();
				}
			}} /></label>
	<p class="ug-muted">{help} <span role={invalid ? 'alert' : 'status'}>{feedback}</span></p>
</div>
