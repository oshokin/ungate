import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { createRequestAbortSignal, fetchWithHeaderTimeout } from 'src/security/outbound-request';

function connection() {
	return {
		request: { raw: Object.assign(new EventEmitter(), { aborted: false }) },
		reply: { raw: Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false }) }
	};
}

function expectClean({ request, reply }: ReturnType<typeof connection>) {
	expect(request.raw.listenerCount('aborted')).toBe(0);
	expect(reply.raw.listenerCount('close')).toBe(0);
	expect(reply.raw.listenerCount('finish')).toBe(0);
}

describe('request cancellation ownership', () => {
	it.each(['request', 'reply'] as const)('aborts an already disconnected %s before fetching', async (side) => {
		const peer = connection();
		if (side === 'request') peer.request.raw.aborted = true;
		else peer.reply.raw.destroyed = true;
		const { signal } = createRequestAbortSignal(peer.request, peer.reply);
		expect(signal.aborted).toBe(true);
		expectClean(peer);
		await expect(
			fetchWithHeaderTimeout('https://example.com', {}, signal, undefined, async (_input, init) => {
				await Promise.resolve();
				init?.signal?.throwIfAborted();
				throw new Error('unexpected fetch');
			})
		).rejects.toThrow('Client disconnected');
	});

	it.each(['aborted', 'close'] as const)('aborts on %s and removes all listeners without waiting for finish', (event) => {
		const peer = connection();
		const { signal, cleanup } = createRequestAbortSignal(peer.request, peer.reply);
		(event === 'aborted' ? peer.request.raw : peer.reply.raw).emit(event);
		expect(signal.aborted).toBe(true);
		expectClean(peer);
		cleanup();
		expectClean(peer);
	});

	it('does not treat a fully received request body as user Stop', () => {
		const peer = connection();
		const { signal, cleanup } = createRequestAbortSignal(peer.request, peer.reply);
		peer.request.raw.emit('close');
		expect(signal.aborted).toBe(false);
		cleanup();
		expectClean(peer);
	});

	it.each([false, true])('does not abort normal response completion (already destroyed: %s)', (destroyed) => {
		const peer = connection();
		peer.reply.raw.writableEnded = true;
		peer.reply.raw.destroyed = destroyed;
		const { signal } = createRequestAbortSignal(peer.request, peer.reply);
		peer.reply.raw.emit('finish');
		peer.reply.raw.emit('close');
		expect(signal.aborted).toBe(false);
		expectClean(peer);
	});
});
