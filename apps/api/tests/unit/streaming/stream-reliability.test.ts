import { afterEach, describe, expect, it, vi } from 'vitest';

import { reliableOpenAiStream } from 'src/streaming/stream-reliability';

describe('reliableOpenAiStream', () => {
	afterEach(() => vi.useRealTimers());

	it('passes through bytes and propagates cancellation', async () => {
		const cancel = vi.fn();
		const upstream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('data: ok\n\n'));
			},
			cancel
		});
		const reader = reliableOpenAiStream(upstream).getReader();
		const part = await reader.read();

		expect(new TextDecoder().decode(part.value)).toBe('data: ok\n\n');
		await reader.cancel('stopped');
		expect(cancel).toHaveBeenCalledWith('stopped');
	});

	it('emits a structured readiness timeout and one done marker', async () => {
		vi.useFakeTimers();
		const cancel = vi.fn();
		const output = reliableOpenAiStream(new ReadableStream<Uint8Array>({ cancel }));
		const text = outputToText(output);

		await vi.advanceTimersByTimeAsync(180_000);
		const body = await text;

		expect(body).toContain('"code":"readiness_timeout"');
		expect(body.match(/data: \[DONE\]/gu)).toHaveLength(1);
		expect(cancel).toHaveBeenCalled();
	});
});

async function outputToText(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let output = '';
	while (true) {
		const part = await reader.read();
		if (part.done) return output;
		output += decoder.decode(part.value, { stream: true });
	}
}
