import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchWithHeaderTimeout } from 'src/security/outbound-request';

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

		const response = await fetchWithHeaderTimeout('https://example.com', { method: 'POST', body: '{}' });

		expect(response.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(cancel).toHaveBeenCalledTimes(1);
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
