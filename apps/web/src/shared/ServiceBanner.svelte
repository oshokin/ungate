<script lang="ts">
import { getActionStore, performAction } from './actions.svelte';
import { getServiceStore } from './service-store.svelte';

const service = getServiceStore();
const actions = getActionStore();
</script>

{#if service.state.status !== 'ready' || service.state.logsConnected === false}
	<div
		class="ug-banner"
		role="status">
		<div>
			<strong
				>{service.state.logsConnected === false && service.state.status === 'ready'
					? 'API logging is disconnected'
					: service.state.restartRequired
						? 'Shared API restart required'
						: service.state.status === 'incompatible'
							? service.state.canUpdate
								? 'Shared API update required'
								: 'Ungate update required'
							: service.state.status === 'checking'
								? 'Connecting…'
								: 'API is not running'}</strong>
			{#if service.state.logsConnected === false && service.state.status === 'ready'}
				<p class="ug-muted">The API is running, but new diagnostic messages cannot be displayed.</p>
			{:else if service.state.message}<p class="ug-muted">{service.state.message}</p>{/if}
		</div>
		{#if service.state.status === 'incompatible' && !service.state.canUpdate}
			<button
				class="ug-button"
				disabled={!!actions.busy}
				onclick={() => performAction('reload-window')}>Reload this window</button>
		{:else if service.state.status !== 'checking' || service.state.logsConnected === false}
			<button
				class="ug-button ug-primary"
				disabled={!!actions.busy}
				onclick={() => performAction('restart-services')}>
				{actions.busy === 'restart-services'
					? 'Restarting…'
					: service.state.logsConnected === false
						? 'Restart shared API'
						: service.state.restartRequired
							? 'Restart shared API'
							: service.state.canUpdate
								? 'Update shared API'
								: 'Start API'}
			</button>
			{#if service.state.status === 'error'}<button
					class="ug-button"
					disabled={!!actions.busy}
					onclick={() => performAction('choose-node-runtime')}>Choose Node.js</button
				>{/if}
		{/if}
	</div>
{/if}
