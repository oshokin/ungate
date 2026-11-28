<script lang="ts">
import { onMount } from 'svelte';
import IconList from 'virtual:icons/lucide/list';
import IconRotateCcw from 'virtual:icons/lucide/rotate-ccw';

import { getActionStore, performAction } from './actions.svelte';
import { postExtensionMessage } from './vscode';

const store = getActionStore();
let menu: HTMLDetailsElement | undefined = $state();
let placement = $state<'editor' | 'panel'>('editor');

onMount(() => {
	const receive = (event: MessageEvent): void => {
		if (event.data?.type === 'dashboard-placement' && (event.data.placement === 'editor' || event.data.placement === 'panel'))
			placement = event.data.placement;
	};
	window.addEventListener('message', receive);
	postExtensionMessage({ type: 'get-dashboard-preferences' });

	return () => window.removeEventListener('message', receive);
});

function closeMenu(event: MouseEvent | KeyboardEvent): void {
	if (!menu?.open) return;
	if (event instanceof KeyboardEvent) {
		if (event.key === 'Escape') {
			menu.open = false;
			menu.querySelector('summary')?.focus();
		}
	} else if (
		event.target instanceof Node &&
		(!menu.contains(event.target) || (event.target instanceof Element && event.target.closest('button')))
	) {
		menu.open = false;
	}
}
</script>

<svelte:window
	onclick={closeMenu}
	onkeydown={closeMenu} />

<div
	class="ug-toolbar"
	aria-label="Ungate actions">
	<button
		class="ug-button ug-quiet"
		disabled={!!store.busy}
		onclick={() => performAction('open-cursor-models')}
		title="Open Cursor Models">
		<IconList class="size-4" /><span>Models</span>
	</button>
	<button
		class="ug-button ug-quiet"
		disabled={!!store.busy}
		onclick={() => performAction('reload-window')}
		title="Reload this window; shared services keep running"
		aria-label="Reload window">
		<IconRotateCcw class="size-4" /><span>Reload</span>
	</button>
	<details
		class="ug-overflow"
		bind:this={menu}>
		<summary
			class="ug-button ug-quiet"
			aria-label="More actions"
			title="More actions">•••</summary>
		<div class="ug-menu">
			<button
				class="ug-menu-item"
				onclick={() =>
					postExtensionMessage({ type: 'set-dashboard-placement', placement: placement === 'editor' ? 'panel' : 'editor' })}
				>{placement === 'editor' ? 'Move to Bottom Panel' : 'Move to Editor Tab'}</button>
			<button
				class="ug-menu-item"
				disabled={!!store.busy}
				onclick={() => performAction('open-extension-settings')}>Extension settings</button>
			<button
				class="ug-menu-item"
				disabled={!!store.busy}
				onclick={() => performAction('choose-node-runtime')}>Choose Node.js executable</button>
			<button
				class="ug-menu-item"
				disabled={!!store.busy}
				onclick={() => performAction('restart-services')}>Restart shared API</button>
			<button
				class="ug-menu-item"
				disabled={!!store.busy}
				onclick={() => performAction('restart-tunnel')}>Restart tunnel</button>
			<button
				class="ug-menu-item"
				disabled={!!store.busy}
				onclick={() => performAction('stop-tunnel')}>Stop tunnel only</button>
			<hr />
			<button
				class="ug-menu-item ug-danger"
				disabled={!!store.busy}
				onclick={() => performAction('stop-services')}>Stop API and tunnel · all windows</button>
		</div>
	</details>
</div>
