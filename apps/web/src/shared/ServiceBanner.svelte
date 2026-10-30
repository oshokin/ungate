<script lang="ts">
import { getActionStore, performAction } from './actions.svelte';
import { getServiceStore } from './service-store.svelte';

const service = getServiceStore();
const actions = getActionStore();
</script>

{#if service.state.status !== 'ready'}
	<div
		class="ug-banner"
		role="status">
		<div>
			<strong
				>{service.state.status === 'incompatible'
					? service.state.canUpdate
						? 'Shared API update required'
						: 'Ungate update required'
					: service.state.status === 'checking'
						? 'Connecting…'
						: 'API is not running'}</strong>
			{#if service.state.message}<p class="ug-muted">{service.state.message}</p>{/if}
		</div>
		{#if service.state.status === 'incompatible' && !service.state.canUpdate}
			<button
				class="ug-button"
				disabled={!!actions.busy}
				onclick={() => performAction('reload-window')}>Reload this window</button>
		{:else if service.state.status !== 'checking'}
			<button
				class="ug-button ug-primary"
				disabled={!!actions.busy}
				onclick={() => performAction('restart-services')}>
				{actions.busy === 'restart-services' ? 'Restarting…' : service.state.canUpdate ? 'Update shared API' : 'Start API'}
			</button>
			{#if service.state.status === 'error'}<button
					class="ug-button"
					disabled={!!actions.busy}
					onclick={() => performAction('choose-node-runtime')}>Choose Node.js</button
				>{/if}
		{/if}
	</div>
{/if}
