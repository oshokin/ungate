import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpenAIStreamHandler } from 'src/streaming/openai-stream-handler';
import { reliableOpenAiStream } from 'src/streaming/stream-reliability';

afterEach(() => {
	vi.useRealTimers();
});

describe('stream queue bounds', () => {
	it('finishes readiness timeout even when upstream cancellation never settles', async () => {
		vi.useFakeTimers();
		const cancel = vi.fn(() => new Promise<void>(() => {}));
		const stream = reliableOpenAiStream(new ReadableStream<Uint8Array>({ cancel }));
		const output = (async () => {
			let text = '';
			for await (const chunk of stream) text += new TextDecoder().decode(chunk);
			return text;
		})();
		await vi.advanceTimersByTimeAsync(180_000);
		expect(await output).toContain('"code":"readiness_timeout"');
		expect(await output).toContain('data: [DONE]');
		expect(cancel).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('rejects an oversized Claude batch even when it contains newlines', async () => {
		const cancel = vi.fn();
		const response = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('data: {}\n'.repeat(150_000)));
				},
				cancel
			})
		);
		const { stream } = OpenAIStreamHandler.createStreamResponse(response, 'id', 'claude', {
			model: 'claude',
			source: 'claude',
			startTime: Date.now(),
			reverseToolMapping: {}
		});
		await expect(stream.getReader().read()).rejects.toThrow('exceeded');
		expect(cancel).toHaveBeenCalledOnce();
	});

	it('does not read an entire provider stream ahead of a slow client', async () => {
		let pulls = 0;
		const stream = reliableOpenAiStream(
			new ReadableStream<Uint8Array>({
				pull(controller) {
					pulls++;
					controller.enqueue(new Uint8Array([1]));
				}
			})
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(pulls).toBeLessThanOrEqual(3);
		const reader = stream.getReader();
		await reader.read();
		await reader.cancel();
	});

	it('does not enqueue heartbeat indefinitely into a stalled output', async () => {
		vi.useFakeTimers();
		const stream = reliableOpenAiStream(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array([1]));
				}
			})
		);
		await vi.advanceTimersByTimeAsync(600_000);
		const reader = stream.getReader();
		const first = await reader.read();
		expect(first.value).toEqual(new Uint8Array([1]));
		await reader.cancel();
		await vi.advanceTimersByTimeAsync(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('pauses between SSE events inside one network chunk and resumes without losing text', async () => {
		const encoder = new TextEncoder();
		const input = Array.from(
			{ length: 500 },
			() => 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}\n\n'
		).join('');
		let cancelled = false;
		const response = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(encoder.encode(input + 'data: {"type":"message_stop"}\n\n'));
				},
				cancel() {
					cancelled = true;
				}
			})
		);
		const { stream } = OpenAIStreamHandler.createStreamResponse(response, 'id', 'claude', {
			model: 'claude',
			source: 'claude',
			startTime: Date.now(),
			reverseToolMapping: {}
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(cancelled).toBe(false);
		let output = '';
		for await (const chunk of stream) output += new TextDecoder().decode(chunk);
		expect(output.match(/"content":"x"/g)).toHaveLength(500);
		expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
		expect(cancelled).toBe(true);
	});
});
