import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_STREAM_TIMING, OpenAIStreamHandler } from 'src/streaming/openai-stream-handler';

function fixture() {
	let source!: ReadableStreamDefaultController<Uint8Array>;
	const cancel = vi.fn();
	const response = new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				source = controller;
			},
			cancel
		})
	);
	const { stream } = OpenAIStreamHandler.createStreamResponse(
		response,
		'keepalive',
		'claude',
		{
			model: 'claude',
			source: 'claude',
			startTime: Date.now(),
			reverseToolMapping: {}
		},
		{ keepaliveIntervalMs: 15, upstreamIdleTimeoutMs: 180 }
	);
	const send = (event: unknown) => source.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));

	return { stream, send, cancel };
}

async function drain(stream: ReadableStream<Uint8Array>) {
	let output = '';
	for await (const chunk of stream) output += new TextDecoder().decode(chunk);

	return output;
}

describe('Claude keepalive adaptation', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	for (const key of ['keepaliveIntervalMs', 'upstreamIdleTimeoutMs'] as const) {
		it.each([0, -1, 0.5, NaN, Infinity, -Infinity, 2_147_483_648, '15', null, undefined])(
			`rejects invalid ${key}: %s before locking the body`,
			(value) => {
				vi.useFakeTimers();
				const response = new Response(new ReadableStream<Uint8Array>());
				expect(() =>
					OpenAIStreamHandler.createStreamResponse(
						response,
						'id',
						'claude',
						{
							model: 'claude',
							source: 'claude',
							startTime: Date.now(),
							reverseToolMapping: {}
						},
						{ [key]: value }
					)
				).toThrow(RangeError);
				expect(response.body?.locked).toBe(false);
				expect(vi.getTimerCount()).toBe(0);
			}
		);
	}

	it.each([{}, { keepaliveIntervalMs: 1 }, { upstreamIdleTimeoutMs: 2_147_483_647 }])(
		'accepts defaults, partial overrides and timer boundaries: %j',
		async (timing) => {
			vi.useFakeTimers();
			const response = new Response(new ReadableStream<Uint8Array>());
			const { stream } = OpenAIStreamHandler.createStreamResponse(
				response,
				'id',
				'claude',
				{
					model: 'claude',
					source: 'claude',
					startTime: Date.now(),
					reverseToolMapping: {}
				},
				timing
			);
			await stream.cancel();
			expect(vi.getTimerCount()).toBe(0);
		}
	);

	it('protects shared timing defaults from mutation', () => {
		expect(Object.isFrozen(DEFAULT_STREAM_TIMING)).toBe(true);
		expect(DEFAULT_STREAM_TIMING).toEqual({ keepaliveIntervalMs: 15_000, upstreamIdleTimeoutMs: 180_000 });
	});

	it('preserves tool JSON and finish_reason across keepalives between argument fragments', async () => {
		vi.useFakeTimers();
		const f = fixture();
		const output = drain(f.stream);
		f.send({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool_1', name: 'custom_tool' } });
		f.send({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"text":"hello' } });
		await vi.advanceTimersByTimeAsync(45);
		f.send({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ' world","n":1}' } });
		f.send({ type: 'content_block_stop', index: 0 });
		f.send({ type: 'message_delta', delta: { stop_reason: 'tool_use' } });
		f.send({ type: 'message_stop' });
		const text = await output;
		const chunks = text
			.split('\n')
			.filter((line) => line.startsWith('data: {'))
			.map(
				(line) =>
					JSON.parse(line.slice(6)) as {
						choices?: { delta?: { tool_calls?: { index: number; function: { arguments?: string } }[] } }[];
					}
			);
		const calls = chunks.flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? []);
		expect(calls).toHaveLength(2);
		expect(calls[0]).toMatchObject({ index: 0, id: 'tool_1', function: { name: 'custom_tool' } });
		expect(JSON.parse(calls.map((call) => call.function.arguments ?? '').join(''))).toEqual({ text: 'hello world', n: 1 });
		expect(text).toContain('"content":""');
		expect(text.indexOf('"content":""')).toBeGreaterThan(text.indexOf('"id":"tool_1"'));
		expect(text.indexOf('"content":""')).toBeLessThan(text.indexOf('hello world'));
		expect(text).toContain('"finish_reason":"tool_calls"');
		expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('emits OpenAI data during silence and terminates an idle stream as incomplete', async () => {
		vi.useFakeTimers();
		const f = fixture();
		const output = drain(f.stream);
		await vi.advanceTimersByTimeAsync(181);
		const text = await output;
		expect(text).toContain('"content":""');
		expect(text).toContain('"finish_reason":"length"');
		expect(text.trimEnd()).toMatch(/data: \[DONE\]$/);
		expect(f.cancel).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('keeps thinking streams alive without a total-duration limit', async () => {
		vi.useFakeTimers();
		const f = fixture();
		const output = drain(f.stream);
		for (let i = 0; i < 30; i++) {
			f.send({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'private' } });
			await vi.advanceTimersByTimeAsync(30);
		}
		f.send({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'finished' } });
		f.send({ type: 'message_stop' });
		const text = await output;
		expect(text).toContain('"reasoning_content":"private"');
		expect(text).not.toContain('"content":"private"');
		expect(text).toContain('"content":"finished"');
		expect(text).toContain('"finish_reason":"stop"');
		expect(vi.getTimerCount()).toBe(0);
	});

	it('stops timers and upstream on client cancellation', async () => {
		vi.useFakeTimers();
		const f = fixture();
		await f.stream.cancel('client stopped');
		await vi.advanceTimersByTimeAsync(1000);
		expect(f.cancel).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('does not wait for upstream EOF or send keepalive after message_stop', async () => {
		vi.useFakeTimers();
		const f = fixture();
		const output = drain(f.stream);
		f.send({ type: 'message_stop' });
		await vi.advanceTimersByTimeAsync(1000);
		const text = await output;
		expect(text).not.toContain('"content":""');
		expect(vi.getTimerCount()).toBe(0);
	});

	it('bounds queued keepalives when the client is not reading', async () => {
		vi.useFakeTimers();
		const f = fixture();
		await vi.advanceTimersByTimeAsync(179);
		const reader = f.stream.getReader();
		let count = 0;
		const consume = (async () => {
			while (true) {
				const result = await reader.read();
				if (result.done) break;
				count++;
			}
		})();
		f.send({ type: 'message_stop' });
		await vi.advanceTimersByTimeAsync(1);
		await consume;
		expect(count).toBeLessThan(16);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('does not time out upstream while paused by downstream backpressure', async () => {
		vi.useFakeTimers();
		const f = fixture();
		for (let i = 0; i < 80; i++) {
			f.send({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } });
		}
		await vi.advanceTimersByTimeAsync(1000);
		expect(f.cancel).not.toHaveBeenCalled();
		f.send({ type: 'message_stop' });
		const output = await drain(f.stream);
		expect(output).toContain('"finish_reason":"stop"');
		expect(output).not.toContain('"finish_reason":"length"');
		expect(output).not.toContain('"content":""');
		expect(vi.getTimerCount()).toBe(0);
	});
});
