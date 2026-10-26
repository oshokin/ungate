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

	it('uses connecting for active startup and public-route checks', () => {
		expect(ExtensionStatusBar.connectionStatus('starting', tunnel())).toBe('connecting');
		expect(
			ExtensionStatusBar.connectionStatus(
				'running',
				tunnel({ status: 'running', url: 'https://example.trycloudflare.com', publicStatus: 'checking' })
			)
		).toBe('connecting');
	});

	it('uses concise labels with non-color status cues', () => {
		expect(ExtensionStatusBar.statusText('ready')).toBe('$(check) Ungate: Ready');
		expect(ExtensionStatusBar.statusText('connecting')).toBe('$(sync~spin) Ungate: Connecting');
		expect(ExtensionStatusBar.statusText('offline')).toBe('$(warning) Ungate: Offline');
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

		expect(result.value).toContain('Ungate: Offline');
		expect(result.value).toContain('`http://127.0.0.1:4783`');
		expect(result.value).toContain('API health check timed out.');
		expect(result.value).toContain('`https://example.trycloudflare.com/v1`');
		expect(result.value).toContain('Public health check timed out.');
	});
});
