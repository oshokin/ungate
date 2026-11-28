import type { ExtensionToWebview, TunnelProvider, TunnelState } from '@ungate/shared/frontend';

let tunnel = $state<TunnelState>({ status: 'stopped', url: null, error: null });
let provider = $state<TunnelProvider>('quick');
let token = $state('');
let configRevision = $state(0);
window.addEventListener('message', (event: MessageEvent<ExtensionToWebview>) => {
	if (event.data?.type === 'tunnel-status') {
		tunnel = event.data.state;
	}
	if (event.data?.type === 'tunnel-config') {
		provider = event.data.provider;
		token = event.data.token ?? '';
		configRevision++;
	}
});

export function getTunnelStore() {
	return {
		get tunnel() {
			return tunnel;
		},
		get provider() {
			return provider;
		},
		get token() {
			return token;
		},
		get configRevision() {
			return configRevision;
		}
	};
}
