import { UNGATE_VERSION, type ExtensionToWebview, type ServiceState } from '@ungate/shared/frontend';

let state = $state<ServiceState>({
	status: 'checking',
	version: null,
	expectedVersion: UNGATE_VERSION,
	canUpdate: false,
	message: null
});
window.addEventListener('message', (event: MessageEvent<ExtensionToWebview>) => {
	if (event.data?.type === 'service-state') state = event.data.state;
});

export function getServiceStore() {
	return {
		get state() {
			return state;
		}
	};
}
