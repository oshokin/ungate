import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchWithHeaderTimeout, isPublicIpAddress } from 'src/security/outbound-request';

describe('fetchWithHeaderTimeout retries', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it('retries one replayable request after a retryable status and cancels the discarded body', async () => {
		const cancel = vi.fn();
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 503, headers: { 'retry-after': '0' } }))
			.mockResolvedValueOnce(new Response('ok', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		const response = await fetchWithHeaderTimeout('https://example.com', { method: 'GET' });

		expect(response.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it.each([408, 429, 500, 502, 503, 504])('does not replay a generation POST on %s', async (status) => {
		const fetchMock = vi.fn().mockResolvedValue(new Response('error', { status }));
		vi.stubGlobal('fetch', fetchMock);
		expect((await fetchWithHeaderTimeout('https://example.com', { method: 'POST', body: '{}' })).status).toBe(status);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('does not replay a generation POST after an ambiguous socket failure', async () => {
		const error = Object.assign(new Error('socket closed'), { code: 'ECONNRESET' });
		const fetchMock = vi.fn().mockRejectedValue(error);
		vi.stubGlobal('fetch', fetchMock);
		await expect(fetchWithHeaderTimeout('https://example.com', { method: 'POST', body: '{}' })).rejects.toThrow();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('does not retry a non-replayable stream body', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 }));
		vi.stubGlobal('fetch', fetchMock);

		const response = await fetchWithHeaderTimeout('https://example.com', {
			method: 'POST',
			body: new ReadableStream(),
			duplex: 'half'
		} as RequestInit);

		expect(response.status).toBe(503);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('does not retry a non-network programming error', async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error('invalid request construction'));
		vi.stubGlobal('fetch', fetchMock);

		await expect(fetchWithHeaderTimeout('https://example.com', { method: 'POST', body: '{}' })).rejects.toThrow(
			'invalid request construction'
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe('global address classification', () => {
	it.each(['192.2.1.1', '192.0.3.1', '198.51.101.1', '2001:4860:4860::8888', '2001:200::1', '3fff:1000::1'])(
		'does not overblock global allocation %s', (address) => expect(isPublicIpAddress(address)).toBe(true)
	);
	it.each([
		'::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:a00:1',
		'::1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::',
		'192.0.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1',
		'203.0.113.1', '100.64.0.1', '255.255.255.255'
	])('rejects non-global %s', (address) => expect(isPublicIpAddress(address)).toBe(false));
	it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:808:808'])(
		'accepts global %s', (address) => expect(isPublicIpAddress(address)).toBe(true)
	);
});
