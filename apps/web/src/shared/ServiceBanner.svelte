<script lang="ts">
import { getActionStore, performAction } from './actions.svelte';
import { getServiceStore } from './service-store.svelte';

const service = getServiceStore();
const actions = getActionStore();
</script>

{#if service.known && (service.state.status !== 'ready' || service.state.logsConnected === false)}
	{@const loggingOnly = service.state.logsConnected === false && service.state.status === 'ready'}
	{@const reloadOnly = service.state.status === 'incompatible' && !service.state.canUpdate}
	<div class="ug-banner">
		<div class="ug-banner-copy">
			<strong
				>{loggingOnly
					? 'API logging is disconnected'
					: service.state.restartRequired
						? 'Shared API restart required'
						: service.state.status === 'incompatible'
							? service.state.canUpdate
								? 'Shared API update required'
								: 'Ungate update required'
							: 'API is not running'}</strong>
			<p class="ug-muted">
				{loggingOnly
					? 'The API is running, but new diagnostic messages cannot be displayed.'
					: service.state.status === 'checking' && !service.state.message
						? 'Starting the shared API.'
						: service.state.message || 'The shared API is not ready.'}
			</p>
		</div>
		<div class="ug-toolbar">
			{#if reloadOnly}
				<button
					class="ug-button"
					disabled={!!actions.busy}
					onclick={() => performAction('reload-window')}>Reload this window</button>
			{:else}
				<button
					class="ug-button ug-primary"
					disabled={!!actions.busy || service.state.status === 'checking'}
					onclick={() => performAction('restart-services')}>
					{actions.busy === 'restart-services'
						? 'Restarting…'
						: loggingOnly
							? 'Restart shared API'
							: service.state.restartRequired
								? 'Restart shared API'
								: service.state.canUpdate
									? 'Update shared API'
									: 'Start API'}
				</button>
				<button
					class="ug-button"
					disabled={!!actions.busy}
					onclick={() => performAction('choose-node-runtime')}>Choose Node.js</button>
			{/if}
		</div>
	</div>
{/if}
