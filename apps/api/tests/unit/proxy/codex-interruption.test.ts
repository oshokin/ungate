import { describe, expect, it, vi } from 'vitest';

import { OpenAiClient } from 'src/proxy/openai-client';
import { StreamStateFactory } from 'src/proxy/responses-stream-mapper';

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

	it('forwards an SSE error object to streaming clients', async () => {
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

		expect(output).toContain(
			'data: {"error":{"message":"Your input exceeds the model context window.","type":"invalid_request_error","code":"context_length_exceeded"}}'
		);
		expect(output).not.toContain('"finish_reason":"length"');
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

		expect(output).toContain('"code":"context_length_exceeded"');
		expect(output).not.toContain('"finish_reason":"length"');
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
