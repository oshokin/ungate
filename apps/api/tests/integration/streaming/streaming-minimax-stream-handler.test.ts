import { afterEach, describe, expect, it } from 'vitest';

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
	afterEach(() => {});

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

	it('finishes cleanly when the stream ends without DONE', async () => {
		const response = createResponseWithSse([
			'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}'
		]);
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
