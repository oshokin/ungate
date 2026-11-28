import type { TunnelState } from '@ungate/shared/frontend';

export function connectionState(tunnel: TunnelState, selected: 'quick' | 'ngrok') {
	const running = tunnel.status === 'running';
	const transitioning = tunnel.status === 'installing' || tunnel.status === 'starting';
	const provider = running ? tunnel.provider : selected;
	const providerLabel = provider === 'ngrok' ? 'ngrok' : provider === 'quick' ? 'Cloudflare' : 'Unverified provider';
	const status = running
		? !provider
			? 'Unverified'
			: tunnel.publicStatus === 'reachable' && tunnel.url
				? 'Connected'
				: tunnel.publicStatus === 'unreachable'
					? 'Unavailable'
					: 'Checking…'
		: { stopped: 'Stopped', installing: 'Installing…', starting: 'Starting…', error: 'Error' }[
				tunnel.status as Exclude<TunnelState['status'], 'running'>
			];

	return {
		providerLabel,
		status,
		transitioning,
		endpoint: running && provider && tunnel.url ? `${tunnel.url.replace(/\/$/, '')}/v1` : '',
		mismatch: running && provider !== selected
	};
}
