import { describe, expect, it, vi } from 'vitest';

import { OpenAiClient } from 'src/proxy/openai-client';
import { ResponsesSseProcessor, StreamStateFactory } from 'src/proxy/responses-stream-mapper';

vi.mock('src/database/app-settings', () => ({ Settings: { get: () => ({}) } }));
const streamResponse = (
	OpenAiClient as unknown as { streamResponse(response: Response, state: ReturnType<typeof StreamStateFactory.create>): Response }
).streamResponse.bind(OpenAiClient);
const bufferedResponse = (
	OpenAiClient as unknown as {
		bufferedResponse(response: Response, state: ReturnType<typeof StreamStateFactory.create>): Promise<Response>;
	}
).bufferedResponse.bind(OpenAiClient);
const events = [
	{ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'one', name: 'Write' } },
	{ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path":' }
];

describe('Codex interruption (#68)', () => {
	it.each([{ prefix: [] }, { prefix: events }])(
		'serializes reader rejection without releasing partial tools (%j)',
		async ({ prefix }) => {
			let reads = 0;
			const source = new ReadableStream<Uint8Array>({
				pull(controller) {
					if (reads++ === 0 && prefix.length) {
						controller.enqueue(new TextEncoder().encode(prefix.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')));
					} else controller.error(new Error('connection reset'));
				}
			});
			const state = StreamStateFactory.create('test');
			const output = await streamResponse(new Response(source), state).text();
			expect(output).toContain('"code":"truncated_stream"');
			expect(output).not.toContain('tool_calls');
			expect(output).not.toContain('finish_reason');
			expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
			expect(state.pendingFunctionCalls.size).toBe(0);
			expect(state.successfulCompletion).toBe(false);
			expect(source.locked).toBe(false);
		}
	);

	it('serializes parser exceptions and cleans up the reader', async () => {
		const state = StreamStateFactory.create('test');
		state.maxSseEventBytes = 8;
		const source = new Response('data: oversized event');
		const output = await streamResponse(source, state).text();
		expect(output).toContain('"code":"truncated_stream"');
		expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
		expect(source.body!.locked).toBe(false);
	});

	it('returns a buffered error on reader rejection and releases its lock', async () => {
		const source = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.error(new Error('connection reset'));
			}
		});
		const response = await bufferedResponse(new Response(source), StreamStateFactory.create('test'));
		expect(response.status).toBe(502);
		const output = await response.text();
		expect(output).toContain('truncated_stream');
		expect(source.locked).toBe(false);
	});

	it('preserves a completed state if the parser subsequently throws', async () => {
		const state = StreamStateFactory.create('test');
		const process = vi.spyOn(ResponsesSseProcessor, 'process').mockImplementationOnce(() => {
			state.completed = true;
			state.successfulCompletion = true;
			throw new Error('late parser failure');
		});
		try {
			const output = await streamResponse(new Response('data: anything\n\n'), state).text();
			expect(output).toBe('data: [DONE]\n\n');
			expect(state.successfulCompletion).toBe(true);
			expect(state.error).toBeUndefined();
		} finally {
			process.mockRestore();
		}
	});

	it('completes normally exactly once and cancels the upstream reader', async () => {
		const cancel = vi.fn();
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{}}\n\n'));
			},
			cancel
		});
		const state = StreamStateFactory.create('test');
		const output = await streamResponse(new Response(source), state).text();
		expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
		expect(output).not.toContain('"error"');
		expect(state.successfulCompletion).toBe(true);
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(source.locked).toBe(false);
	});

	it('cancels an in-flight read without fabricating completion', async () => {
		const cancel = vi.fn();
		const source = new ReadableStream<Uint8Array>({ cancel });
		const state = StreamStateFactory.create('test');
		const reader = streamResponse(new Response(source), state).body!.getReader();
		const pending = reader.read();
		await Promise.resolve();
		await reader.cancel('stopped');
		const result = await pending;
		expect(result).toEqual({ done: true, value: undefined });
		expect(state.completed).not.toBe(true);
		expect(state.error).toBeUndefined();
		expect(cancel).toHaveBeenCalledWith('stopped');
		expect(source.locked).toBe(false);
	});

	it('reports unexpected EOF exactly once without emitting unfinished tool arguments', async () => {
		const response = new Response(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''));
		const output = await streamResponse(response, StreamStateFactory.create('test')).text();
		expect(output).toContain('"code":"truncated_stream"');
		expect(output).not.toContain('tool_calls');
		expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
	});

	it('propagates downstream cancellation to the provider reader', async () => {
		const cancel = vi.fn();
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"hello"}\n\n'));
			},
			cancel
		});
		const reader = streamResponse(new Response(source), StreamStateFactory.create('test')).body!.getReader();
		await reader.read();
		await reader.cancel('user stopped');
		expect(cancel).toHaveBeenCalledWith('user stopped');
	});

	it('renders a context-window failure as an actionable error without retrying', async () => {
		const upstreamError = {
			type: 'error',
			error: {
				type: 'invalid_request_error',
				code: 'context_length_exceeded',
				message: 'Your input exceeds the model context window.'
			}
		};
		const output = await streamResponse(
			new Response(`data: ${JSON.stringify(upstreamError)}\n\n`),
			StreamStateFactory.create('test')
		).text();

		expect(output).toContain('This conversation exceeds the model context window');
		expect(output).not.toContain('"finish_reason":"stop"');
		expect(output).toContain('"code":"context_length_exceeded"');
		expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
	});

	it('returns a non-streaming OpenAI error for response.failed', async () => {
		const upstreamError = {
			type: 'response.failed',
			response: {
				error: { code: 'server_error', message: 'The model failed while processing the request.' }
			}
		};
		const response = await bufferedResponse(
			new Response(`data: ${JSON.stringify(upstreamError)}\n\n`),
			StreamStateFactory.create('test')
		);
		const body = await response.json();

		expect(response.status).toBe(502);
		expect(body).toEqual({
			error: {
				type: 'api_error',
				code: 'server_error',
				message: 'The model failed while processing the request.'
			}
		});
	});

	it('processes a final error event without a trailing blank SSE line', async () => {
		const upstreamError = {
			type: 'error',
			error: { code: 'context_length_exceeded', message: 'Your input exceeds the model context window.' }
		};
		const output = await streamResponse(
			new Response(`data: ${JSON.stringify(upstreamError)}`),
			StreamStateFactory.create('test')
		).text();

		expect(output).toContain('This conversation exceeds the model context window');
		expect(output).not.toContain('"finish_reason":"stop"');
		expect(output).toContain('"code":"context_length_exceeded"');
		expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
	});

	it('returns a non-streaming error when the provider closes without a terminal event', async () => {
		const response = await bufferedResponse(
			new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'),
			StreamStateFactory.create('test')
		);
		const body = await response.json();

		expect(response.status).toBe(502);
		expect(body).toEqual({
			error: {
				type: 'api_error',
				code: 'truncated_stream',
				message: 'ChatGPT Codex stream ended before a terminal event.'
			}
		});
	});
});
