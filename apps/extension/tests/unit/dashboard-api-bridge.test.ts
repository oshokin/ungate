import { API_PROTOCOL_VERSION, UNGATE_VERSION } from '@ungate/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DashboardApiBridge } from '../../src/dashboard-api-bridge';

vi.mock('@ungate/shared', async (original) => {
	const shared = await original<typeof import('@ungate/shared')>();

	return { ...shared, getAdminToken: () => 'private-admin-token' };
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe('dashboard HTTP bridge', () => {
	it('uses IPv4 loopback and adds capability only in the extension host', async () => {
		const fetcher = vi
			.fn()
			.mockImplementation((url: string) =>
				Promise.resolve(
					Response.json(
						url.endsWith('/health')
							? { service: 'ungate', pid: 123, version: UNGATE_VERSION, protocolVersion: API_PROTOCOL_VERSION }
							: { port: 47821 }
					)
				)
			);
		vi.stubGlobal('fetch', fetcher);
		const send = vi.fn();
		const bridge = new DashboardApiBridge(() => 47821, send);
		await bridge.handle({ type: 'api-request', id: 'one', method: 'GET', path: '/settings' });
		expect(fetcher).toHaveBeenCalledWith(
			'http://127.0.0.1:47821/settings',
			expect.objectContaining({ headers: { Authorization: 'Bearer private-admin-token' }, redirect: 'error' })
		);
		expect(send).toHaveBeenCalledWith({ type: 'api-response', id: 'one', status: 200, body: { port: 47821 } });
	});
	it('allows only POST for the fixed model discovery path', async () => {
		const fetcher = vi
			.fn()
			.mockImplementation((url: string) =>
				Promise.resolve(
					Response.json(
						url.endsWith('/health')
							? { service: 'ungate', pid: 123, version: UNGATE_VERSION, protocolVersion: API_PROTOCOL_VERSION }
							: { provider: 'claude', status: 'ok', models: [] }
					)
				)
			);
		vi.stubGlobal('fetch', fetcher);
		const send = vi.fn();
		const bridge = new DashboardApiBridge(() => 47821, send);
		await bridge.handle({
			type: 'api-request',
			id: 'sync',
			method: 'POST',
			path: '/models/discover',
			body: { provider: 'claude' }
		});
		expect(fetcher).toHaveBeenCalledWith(
			'http://127.0.0.1:47821/models/discover',
			expect.objectContaining({
				method: 'POST',
				headers: expect.objectContaining({ Authorization: 'Bearer private-admin-token' }),
				body: JSON.stringify({ provider: 'claude' })
			})
		);
		const calls = fetcher.mock.calls.length;
		await bridge.handle({ type: 'api-request', id: 'bad-sync', method: 'GET', path: '/models/discover' });
		expect(fetcher).toHaveBeenCalledTimes(calls);
	});
	it.each([
		'https://example.org/settings',
		'/admin/shutdown',
		'/v1/chat/completions',
		'/settings?redirect=https://example.org',
		'//example.org'
	])('refuses arbitrary or privileged path %s', async (path) => {
		const fetcher = vi.fn();
		vi.stubGlobal('fetch', fetcher);
		await new DashboardApiBridge(() => 1234, vi.fn()).handle({ type: 'api-request', id: 'bad', method: 'GET', path });
		expect(fetcher).not.toHaveBeenCalled();
	});
	it('returns useful HTTP failures and never switches to an unauthenticated request', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockImplementation((url: string) =>
					Promise.resolve(
						url.endsWith('/health')
							? Response.json({ service: 'ungate', pid: 123, version: UNGATE_VERSION, protocolVersion: API_PROTOCOL_VERSION })
							: Response.json({ error: 'Forbidden' }, { status: 403 })
					)
				)
		);
		const send = vi.fn();
		await new DashboardApiBridge(() => 1234, send).handle({
			type: 'api-request',
			id: 'one',
			method: 'POST',
			path: '/settings',
			body: {}
		});
		expect(send).toHaveBeenCalledWith({ type: 'api-response', id: 'one', status: 403, body: { error: 'Forbidden' } });
	});
	it('does not deliver an old response after the panel is disposed', async () => {
		let complete: (value: Response) => void = () => {};
		vi.stubGlobal(
			'fetch',
			vi.fn().mockReturnValue(
				new Promise<Response>((resolve) => {
					complete = resolve;
				})
			)
		);
		const send = vi.fn();
		const bridge = new DashboardApiBridge(() => 1234, send);
		const pending = bridge.handle({ type: 'api-request', id: 'one', method: 'GET', path: '/settings' });
		bridge.dispose();
		complete(Response.json({}));
		await pending;
		expect(send).not.toHaveBeenCalled();
	});
});
