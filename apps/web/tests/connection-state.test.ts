import { describe, expect, it } from 'vitest';

import { connectionState } from '../src/features/tunnel/connection-state';

import type { TunnelState } from '@ungate/shared/frontend';

describe('connection presentation', () => {
	for (const selected of ['quick', 'ngrok'] as const)
		for (const provider of ['quick', 'ngrok', null, undefined] as const)
			for (const publicStatus of ['reachable', 'unreachable', 'checking', 'unchecked', undefined] as const)
				for (const status of ['running', 'stopped', 'starting', 'installing', 'error'] as const)
					it(`${selected}/${provider}/${publicStatus}/${status}`, () => {
						const state: TunnelState = { status, provider, publicStatus, url: 'https://example.test/', error: null };
						const result = connectionState(state, selected);
						expect(result.status === 'Connected').toBe(status === 'running' && !!provider && publicStatus === 'reachable');
						expect(result.endpoint).toBe(status === 'running' && provider ? 'https://example.test/v1' : '');
						expect(result.mismatch).toBe(status === 'running' && provider !== selected);
						if (status !== 'running') expect(result.providerLabel).toBe(selected === 'quick' ? 'Cloudflare' : 'ngrok');
						if (status === 'running' && !provider) expect(result.status).toBe('Unverified');
					});
	it('does not claim connected or expose an endpoint without a URL', () => {
		const result = connectionState(
			{ status: 'running', provider: 'ngrok', publicStatus: 'reachable', url: null, error: null },
			'ngrok'
		);
		expect(result.status).toBe('Checking…');
		expect(result.endpoint).toBe('');
	});
});
