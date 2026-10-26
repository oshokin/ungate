import type { ExtensionToWebview, TunnelState } from '@ungate/shared/frontend';

let tunnel = $state<TunnelState>({ status: 'stopped', url: null, error: null });
window.addEventListener('message', (event: MessageEvent<ExtensionToWebview>) => {
	if (event.data?.type === 'tunnel-status') {
		tunnel = event.data.state;
	}
});

export function getTunnelStore() {
	return {
		get tunnel() {
			return tunnel;
		}
	};
}
