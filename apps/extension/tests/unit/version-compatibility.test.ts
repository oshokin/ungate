import { createServer, type Server } from 'node:http';

import { API_PROTOCOL_VERSION, describeService, UNGATE_VERSION } from '@ungate/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DashboardApiBridge } from '../../src/dashboard-api-bridge';
import { readApiHealth } from '../../src/local-api';

vi.mock('@ungate/shared', async (original) => {
	const actual = await original<typeof import('@ungate/shared')>();

	return { ...actual, getAdminToken: () => 'test-admin' };
});
let server: Server | undefined;
afterEach(async () => {
	if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
	server = undefined;
});

async function start(health: unknown) {
	const requests: string[] = [];
	server = createServer((request, response) => {
		requests.push(request.url!);
		response.setHeader('Content-Type', 'application/json');
		response.end(JSON.stringify(request.url === '/health' ? health : { ok: true }));
	});
	await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Missing port');

	return { port: address.port, requests };
}

describe('shared API compatibility over real HTTP', () => {
	it.each([undefined, '1.7.12', '1.7.13'])('does not send /usage or settings writes to an old API (%s)', async (version) => {
		const { port, requests } = await start({ service: 'ungate', pid: 123, version });
		const send = vi.fn<(value: { status: number; error?: string }) => void>();
		const bridge = new DashboardApiBridge(() => port, send);
		await bridge.handle({ type: 'api-request', id: 'usage', method: 'GET', path: '/usage' });
		await bridge.handle({ type: 'api-request', id: 'save', method: 'POST', path: '/settings', body: { port: 47821 } });
		expect(requests).toEqual(['/health', '/health']);
		expect(send).toHaveBeenCalledTimes(2);
		for (const [response] of send.mock.calls) {
			expect(response.status).toBe(503);
			expect(response.error).toContain('Update the API');
		}
	});
	it('allows management only after release and protocol match', async () => {
		const { port, requests } = await start({
			service: 'ungate',
			pid: 123,
			version: UNGATE_VERSION,
			protocolVersion: API_PROTOCOL_VERSION
		});
		const send = vi.fn<(value: { status: number; error?: string }) => void>();
		await new DashboardApiBridge(() => port, send).handle({ type: 'api-request', id: 'ok', method: 'GET', path: '/settings' });
		expect(requests).toEqual(['/health', '/settings']);
		expect(send).toHaveBeenCalledWith({ type: 'api-response', id: 'ok', status: 200, body: { ok: true } });
	});
	it('offers to replace an older protocol from the same release', () => {
		expect(
			describeService({
				service: 'ungate',
				pid: 123,
				version: UNGATE_VERSION,
				protocolVersion: API_PROTOCOL_VERSION - 1
			})
		).toMatchObject({ status: 'incompatible', canUpdate: true });
	});
	it('does not offer downgrading a newer API from an old window', async () => {
		const { port } = await start({ service: 'ungate', pid: 123, version: '1.8.0', protocolVersion: 1 });
		const health = await readApiHealth(port);
		expect(describeService(health)).toMatchObject({ status: 'incompatible', canUpdate: false });
	});
	it.each([{ service: 'different', pid: 123 }, { service: 'ungate', pid: -1 }, null])(
		'rejects an unrelated listener',
		async (health) => {
			const { port } = await start(health);
			await expect(readApiHealth(port)).rejects.toThrow('Unknown service');
		}
	);
	it('does not treat a future protocol as compatible', async () => {
		const { port } = await start({
			service: 'ungate',
			pid: 123,
			version: UNGATE_VERSION,
			protocolVersion: API_PROTOCOL_VERSION + 1
		});
		const health = await readApiHealth(port);
		expect(describeService(health)).toMatchObject({ status: 'incompatible', canUpdate: false });
	});
});
