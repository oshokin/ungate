import { sameServiceState, UNGATE_VERSION, type ExtensionToWebview, type ServiceState } from '@ungate/shared/frontend';

let known = $state(false);
let state = $state<ServiceState>({
	status: 'stopped',
	version: null,
	expectedVersion: UNGATE_VERSION,
	canUpdate: false,
	message: null
});
window.addEventListener('message', (event: MessageEvent<ExtensionToWebview>) => {
	if (event.data?.type !== 'service-state') return;
	known = true;
	if (!sameServiceState(state, event.data.state)) state = event.data.state;
});

export function getServiceStore() {
	return {
		get known() {
			return known;
		},
		get state() {
			return state;
		}
	};
}
