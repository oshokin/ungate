<script lang="ts">
import IconList from 'virtual:icons/lucide/list';
import IconRotateCcw from 'virtual:icons/lucide/rotate-ccw';

import { getActionStore, performAction } from './actions.svelte';

const store = getActionStore();
let menu: HTMLDetailsElement | undefined = $state();

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
