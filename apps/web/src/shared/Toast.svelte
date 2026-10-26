<script lang="ts">
import IconX from 'virtual:icons/lucide/x';

import { getToastStore } from './toast.svelte';

const toast = getToastStore();
</script>

{#if toast.current}
	<div
		class="ug-toast {toast.current.tone === 'error' ? 'ug-toast-error' : 'ug-toast-status'}"
		role={toast.current.tone === 'error' ? 'alert' : 'status'}
		onmouseenter={() => toast.pause('hover')}
		onmouseleave={() => toast.resume('hover')}
		onfocusin={() => toast.pause('focus')}
		onfocusout={(event) => {
			if (!event.currentTarget.contains(event.relatedTarget as Node | null)) toast.resume('focus');
		}}>
		<p>{toast.current.message}</p>
		{#if toast.current.action}
			<button
				class="ug-button ug-secondary"
				type="button"
				onclick={() => toast.runAction()}>
				{toast.current.action.label}
			</button>
		{/if}
		<button
			class="ug-button ug-quiet"
			type="button"
			aria-label="Dismiss notification"
			onclick={() => toast.dismiss()}>
			<IconX class="size-4" />
		</button>
	</div>
{/if}
