import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:https', () => ({ request: mocks.request }));

import { fetchMiniMax, validateMiniMaxBaseUrl } from 'src/security/minimax-url';

describe('MiniMax connection security', () => {
	function serve(status = 200, headers: Record<string, string> = {}) {
		const upstream = Object.assign(new PassThrough(), { statusCode: status, headers });
		mocks.request.mockImplementation((_url, _options, callback) => {
			const req = new EventEmitter() as EventEmitter & { end: () => void };
			req.end = () => callback(upstream);
			return req;
		});
		return upstream;
	}
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
	});

	it('reads successful non-streaming JSON and preserves response headers', async () => {
		const upstream = serve(200, { 'content-type': 'application/json', 'x-request-id': 'request-1' });
		const response = await fetchMiniMax('https://api.minimax.io/v1/models');
		upstream.end('{"data":[]}');
		expect(response.status).toBe(200);
		expect(response.headers.get('x-request-id')).toBe('request-1');
		expect(await response.json()).toEqual({ data: [] });
	});

	it('delivers streaming chunks before upstream completion and propagates cancellation', async () => {
		const upstream = serve(200, { 'content-type': 'text/event-stream' });
		const response = await fetchMiniMax('https://api.minimax.io/v1/messages');
		const reader = response.body!.getReader();
		upstream.write('data: first\n\n');
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toBe('data: first\n\n');
		expect(upstream.writableEnded).toBe(false);
		await reader.cancel();
		expect(upstream.destroyed).toBe(true);
	});

	it('rejects malformed response metadata rather than throwing from the callback', async () => {
		const upstream = serve(200, { 'invalid\nheader': 'value' });
		await expect(fetchMiniMax('https://api.minimax.io/v1/models')).rejects.toThrow();
		expect(upstream.destroyed).toBe(true);
	});

	it('rejects rebinding between validation and connection without opening a socket', async () => {
		mocks.lookup
			.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
			.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
		await expect(fetchMiniMax('https://api.minimax.io/v1/models')).rejects.toThrow('public');
		expect(mocks.request).not.toHaveBeenCalled();
	});

	it('pins the approved IP in the actual socket lookup and refuses redirects', async () => {
		const destroy = vi.fn();
		mocks.request.mockImplementation((_url, options, callback) => {
			const checked = vi.fn();
			options.lookup('api.minimax.io', {}, checked);
			expect(checked).toHaveBeenCalledWith(null, '8.8.8.8', 4);
			const checkedAll = vi.fn();
			options.lookup('api.minimax.io', { all: true }, checkedAll);
			expect(checkedAll).toHaveBeenCalledWith(null, [{ address: '8.8.8.8', family: 4 }]);
			expect(options.agent).toBe(false);
			const req = new EventEmitter() as EventEmitter & { end: () => void };
			req.end = () => callback({ statusCode: 302, headers: { location: 'http://127.0.0.1' }, destroy });
			return req;
		});
		await expect(fetchMiniMax('https://api.minimax.io/v1/models')).rejects.toThrow('redirects');
		expect(destroy).toHaveBeenCalledOnce();
		expect(mocks.request).toHaveBeenCalledOnce();
	});

	it('checks known origins too and rejects mixed public/private answers', async () => {
		mocks.lookup.mockResolvedValue([{ address: '8.8.8.8' }, { address: '::ffff:7f00:1' }]);
		await expect(validateMiniMaxBaseUrl('https://api.minimax.io')).rejects.toThrow('public');
	});

	it.each(['https://example.com/?token=secret', 'https://[::ffff:7f00:1]', 'http://example.com'])(
		'rejects unsafe URL %s', async (url) => {
			await expect(validateMiniMaxBaseUrl(url)).rejects.toThrow();
		}
	);
});
