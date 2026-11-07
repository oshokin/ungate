import { describe, expect, it, vi } from 'vitest';

import { TestHelper } from './helpers/test-helper';

import type { TunnelState } from '@ungate/shared/frontend';

vi.mock('vscode', () => ({
	MarkdownString: TestHelper.createMarkdownStringClass()
}));

const { ExtensionStatusBar } = await import('../../src/extension-status-bar');

function tunnel(overrides: Partial<TunnelState> = {}): TunnelState {
	return {
		status: 'stopped',
		url: null,
		error: null,
		...overrides
	};
}

describe('ExtensionStatusBar', () => {
	it('reports ready only when both the API and public route are available', () => {
		expect(
			ExtensionStatusBar.connectionStatus(
				'running',
				tunnel({ status: 'running', url: 'https://example.trycloudflare.com', publicStatus: 'reachable' })
			)
		).toBe('ready');
		expect(
			ExtensionStatusBar.connectionStatus(
				'stopped',
				tunnel({ status: 'running', url: 'https://example.trycloudflare.com', publicStatus: 'reachable' })
			)
		).toBe('offline');
	});

	it('stops the spinner when the public route is unreachable', () => {
		expect(
			ExtensionStatusBar.connectionStatus(
				'running',
				tunnel({
					status: 'running',
					url: 'https://example.trycloudflare.com',
					publicStatus: 'unreachable',
					publicError: 'Tunnel address does not resolve. Restart the tunnel.'
				})
			)
		).toBe('offline');
	});

	it('uses connecting for active startup and public-route checks', () => {
		expect(ExtensionStatusBar.connectionStatus('starting', tunnel())).toBe('connecting');
		expect(
			ExtensionStatusBar.connectionStatus(
				'running',
				tunnel({ status: 'running', url: 'https://example.trycloudflare.com', publicStatus: 'checking' })
			)
		).toBe('connecting');
	});

	it('does not call a reachable stale build ready', () => {
		const reachable = tunnel({ status: 'running', url: 'https://example.trycloudflare.com', publicStatus: 'reachable' });
		expect(ExtensionStatusBar.connectionStatus('running', reachable, 'incompatible')).toBe('restart');
		expect(ExtensionStatusBar.connectionStatus('running', reachable, 'ready')).toBe('ready');
		expect(ExtensionStatusBar.statusText('restart')).toBe('$(warning) Ungate: Not ready');
		expect(ExtensionStatusBar.accessibilityLabel('restart')).toContain('restart required');
	});

	it('uses concise labels with non-color status cues', () => {
		expect(ExtensionStatusBar.statusText('ready')).toBe('$(check) Ungate: Ready');
		expect(ExtensionStatusBar.statusText('connecting')).toBe('$(sync~spin) Ungate: Connecting');
		expect(ExtensionStatusBar.statusText('offline')).toBe('$(warning) Ungate: Not ready');
	});

	it('shows local and public URLs plus the latest errors in its tooltip', () => {
		const result = ExtensionStatusBar.createTooltip(
			'offline',
			'error',
			'http://127.0.0.1:4783',
			'API health check timed out.',
			tunnel({
				status: 'running',
				url: 'https://example.trycloudflare.com',
				publicStatus: 'unreachable',
				publicError: 'Public health check timed out.'
			}),
			'https://example.trycloudflare.com/v1'
		);

		expect(result.value).toContain('Ungate: Not ready');
		expect(result.value).toContain('`http://127.0.0.1:4783`');
		expect(result.value).toContain('API health check timed out.');
		expect(result.value).toContain('`https://example.trycloudflare.com/v1`');
		expect(result.value).toContain('Public health check timed out.');
		expect(result.value).toContain('[$(debug-restart) Restart API](command:ungate.restartServices)');
		expect(result.value).toContain('[$(debug-restart) Restart tunnel](command:ungate.restartTunnel)');
	});

	it('replaces a raw DNS resolver error with a restart instruction', () => {
		const result = ExtensionStatusBar.createTooltip(
			'offline',
			'running',
			'http://127.0.0.1:47821',
			null,
			tunnel({
				status: 'running',
				url: 'https://example.trycloudflare.com',
				publicStatus: 'unreachable',
				publicError: 'queryA ENOTFOUND example.trycloudflare.com (ENOTFOUND)'
			}),
			'https://example.trycloudflare.com/v1'
		);

		expect(result.value).toContain('Tunnel address does not resolve. Restart the tunnel.');
		expect(result.value).not.toContain('queryA');
	});

	it.each([
		null,
		'A different Ungate API build is running. Restart the shared API to apply the installed build.',
		'[process] health check failed: A different Ungate API build is running. Restart the shared API to apply the installed build.'
	])('places a build mismatch once with the API section when the API error is %s', (apiError) => {
		const message = 'A different Ungate API build is running. Restart the shared API to apply the installed build.';
		const result = ExtensionStatusBar.createTooltip(
			'restart',
			'running',
			'http://127.0.0.1:47821',
			apiError,
			tunnel({ status: 'running', url: 'https://example.trycloudflare.com', publicStatus: 'reachable' }),
			'https://example.trycloudflare.com/v1',
			message
		);
		const text = result.value;

		expect(text.indexOf('API: running')).toBeLessThan(text.indexOf(message));
		expect(text.indexOf(message)).toBeLessThan(text.indexOf('Tunnel process: running'));
		expect(text.split(message)).toHaveLength(2);
		expect(text).not.toContain('Last error:');
	});

	it('preserves a distinct API error alongside the service message', () => {
		const result = ExtensionStatusBar.formatApiTip('error', null, 'Health check timed out.', 'Restart the shared API.');
		expect(result).toContain('Restart the shared API.');
		expect(result).toContain('Last error: Health check timed out.');
	});
});
