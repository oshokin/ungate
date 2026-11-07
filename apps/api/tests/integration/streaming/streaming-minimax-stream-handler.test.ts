import { afterEach, describe, expect, it, vi } from 'vitest';

import { MiniMaxStreamHandler } from 'src/streaming/minimax-stream-handler';

function createResponseWithSse(lines: string[]): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const encoder = new TextEncoder();
			controller.enqueue(encoder.encode(lines.join('\n') + '\n'));
			controller.close();
		}
	});

	return new Response(stream);
}

async function readStream(stream: ReadableStream): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let out = '';

	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}

		out += decoder.decode(value, { stream: true });
	}

	out += decoder.decode();

	return out;
}

describe('streaming-minimax-stream-handler', () => {
	it.each([70, 0, undefined])('preserves inclusive usage and cache details (%s)', async (cachedTokens) => {
		const usage = {
			prompt_tokens: 100,
			completion_tokens: 5,
			total_tokens: 105,
			...(cachedTokens === undefined ? {} : { prompt_tokens_details: { cached_tokens: cachedTokens } })
		};
		const response = createResponseWithSse([`data: ${JSON.stringify({ choices: [], usage })}`, 'data: [DONE]']);
		const { stream } = MiniMaxStreamHandler.createStreamResponse(response, 'cache', 'minimax', {
			model: 'minimax',
			source: 'minimax',
			startTime: Date.now(),
			reverseToolMapping: {}
		});
		const output = await readStream(stream);
		const chunks = output
			.split('\n')
			.filter((line) => line.startsWith('data: {'))
			.map((line) => JSON.parse(line.slice(6)) as { usage?: unknown });
		expect(chunks.filter((chunk) => chunk.usage).map((chunk) => chunk.usage)).toEqual([usage]);
	});

	afterEach(() => vi.unstubAllEnvs());

	const context = {
		model: 'minimax',
		source: 'minimax' as const,
		startTime: 0,
		reverseToolMapping: {}
	};
	const tool = {
		index: 0,
		id: 'call_1',
		type: 'function',
		function: { name: 'Read', arguments: '{}' }
	};
	const toolEvent = (argumentsValue: string, finishReason?: string) => ({
		choices: [
			{
				delta: {
					tool_calls: [
						{
							...tool,
							function: { ...tool.function, arguments: argumentsValue }
						}
					]
				},
				finish_reason: finishReason
			}
		]
	});
	const eventLine = (event: unknown) => `data: ${JSON.stringify(event)}`;

	function expectIncomplete(output: string) {
		expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
		const chunks = output
			.split('\n')
			.filter((line) => line.startsWith('data: {'))
			.map(
				(line) =>
					JSON.parse(line.slice(6)) as {
						choices: {
							delta: { tool_calls?: unknown[] };
							finish_reason: string | null;
						}[];
					}
			);
		expect(chunks.flatMap((chunk) => chunk.choices.flatMap((choice) => choice.delta.tool_calls ?? []))).toEqual([]);
		expect(chunks.flatMap((chunk) => chunk.choices.map((choice) => choice.finish_reason)).filter(Boolean)).toEqual(['length']);
	}

	it.each(['\n', '\r\n'])('processes final SSE event without trailing newline (%j)', async (separator) => {
		const response = new Response(
			[eventLine({ choices: [{ delta: { content: 'hello' } }] }), eventLine(toolEvent('{}', 'tool_calls'))].join(separator)
		);
		const { stream } = MiniMaxStreamHandler.createStreamResponse(response, 'eof', 'minimax', context);
		const output = await readStream(stream);
		expect(output).toContain('"content":"hello"');
		expect(output).toContain('"id":"call_1"');
		expect(output).toContain('"finish_reason":"tool_calls"');
		expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
	});

	it.each(['', '\r\n'])('recognizes CRLF events and DONE with ending %j', async (ending) => {
		const response = new Response(`${eventLine({ choices: [{ delta: { content: 'hello' } }] })}\r\n\r\ndata: [DONE]${ending}`);
		const { stream } = MiniMaxStreamHandler.createStreamResponse(response, 'crlf', 'minimax', context);
		const output = await readStream(stream);
		expect(output).toContain('"content":"hello"');
		expect(output).toContain('"finish_reason":"stop"');
		expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
	});

	it.each(['{', '{}'])('discards unfinished tool arguments %j at EOF and read errors', async (argumentsValue) => {
		for (const failRead of [false, true]) {
			let read = false;
			const response = new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						if (!read) {
							read = true;
							controller.enqueue(new TextEncoder().encode(eventLine(toolEvent(argumentsValue)) + '\n'));
						} else if (failRead) controller.error(new Error('read failed'));
						else controller.close();
					}
				})
			);
			const { stream } = MiniMaxStreamHandler.createStreamResponse(response, 'incomplete', 'minimax', context);
			const output = await readStream(stream);
			expectIncomplete(output);
		}
	});

	it.each(['size', 'processing', 'parse'])('fails closed after a %s error despite later tool completion', async (failure) => {
		if (failure === 'size') vi.stubEnv('PROVIDER_MAX_TOOL_ARGUMENT_BYTES', '4');
		const failedEvent =
			failure === 'parse'
				? 'data: {bad'
				: eventLine(failure === 'size' ? toolEvent('12345') : { choices: [{ delta: { tool_calls: [null] } }] });
		const response = createResponseWithSse([
			eventLine(toolEvent('{}')),
			failedEvent,
			eventLine(toolEvent('', 'tool_calls')),
			'data: [DONE]'
		]);
		const { stream } = MiniMaxStreamHandler.createStreamResponse(response, 'error', 'minimax', context);
		const output = await readStream(stream);
		expectIncomplete(output);
	});

	it('streams content, reasoning, usage and done', async () => {
		const response = createResponseWithSse([
			'data: {"choices":[{"delta":{"role":"assistant","content":"a <think>reason</think> b"},"finish_reason":null}]}',
			'data: {"choices":[{"delta":{"content":" end"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}}',
			'data: [DONE]'
		]);

		const { stream, headers } = MiniMaxStreamHandler.createStreamResponse(response, 'mm1', 'minimax-model', {
			model: 'minimax-model',
			source: 'minimax',
			startTime: Date.now(),
			reverseToolMapping: {}
		});

		expect(headers['Content-Type']).toBe('text/event-stream');
		expect(headers['x-request-id']).toBe('req_mm1');

		const output = await readStream(stream);
		expect(output).toContain('"role":"assistant"');
		expect(output).toContain('"content":"a "');
		expect(output).toContain('"reasoning_content":"reason"');
		expect(output).toContain('"finish_reason":"stop"');
		expect(output).toContain('"usage"');
		expect(output).toContain('data: [DONE]');
	});

	it('bounds upstream reads under backpressure and forwards cancellation', async () => {
		const cancel = vi.fn();
		let reads = 0;
		const response = new Response(
			new ReadableStream<Uint8Array>({
				pull(controller) {
					reads++;
					controller.enqueue(new TextEncoder().encode(eventLine({ choices: [{ delta: { content: 'text' } }] }) + '\n'));
				},
				cancel
			})
		);
		const { stream } = MiniMaxStreamHandler.createStreamResponse(response, 'backpressure', 'minimax', context);
		// Allow the producer to fill its bounded queue without a downstream consumer.
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
		expect(reads).toBeGreaterThan(0);
		expect(reads).toBeLessThanOrEqual(65);
		await stream.cancel('consumer stopped');
		expect(cancel).toHaveBeenCalledExactlyOnceWith('consumer stopped');
	});

	it('finishes cleanly when the stream ends without DONE', async () => {
		const response = createResponseWithSse(['data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}']);
		const { stream } = MiniMaxStreamHandler.createStreamResponse(response, 'mm-incomplete', 'minimax-model', {
			model: 'minimax-model',
			source: 'minimax',
			startTime: Date.now(),
			reverseToolMapping: {}
		});

		await expect(readStream(stream)).resolves.toContain('data: [DONE]');
	});

	it('streams tool call deltas', async () => {
		const response = createResponseWithSse([
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"Read","arguments":"{\\"path\\":\\"a.ts\\"}"}}]},"finish_reason":"tool_calls"}]}',
			'data: [DONE]'
		]);

		const { stream } = MiniMaxStreamHandler.createStreamResponse(response, 'mm2', 'minimax-model', {
			model: 'minimax-model',
			source: 'minimax',
			startTime: Date.now(),
			reverseToolMapping: {}
		});

		const output = await readStream(stream);
		expect(output).toContain('"tool_calls"');
		expect(output).toContain('"id":"call_1"');
		expect(output).toContain('"finish_reason":"tool_calls"');
	});

	it('throws when upstream response has no body', () => {
		expect(() =>
			MiniMaxStreamHandler.createStreamResponse(new Response(null), 'mm3', 'minimax-model', {
				model: 'minimax-model',
				source: 'minimax',
				startTime: Date.now(),
				reverseToolMapping: {}
			})
		).toThrowError('No response body');
	});
});
