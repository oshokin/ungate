import { describe, expect, it, vi } from 'vitest';

import { OpenAiClient } from 'src/proxy/openai-client';
import { StreamStateFactory } from 'src/proxy/responses-stream-mapper';

vi.mock('src/database/app-settings', () => ({ Settings: { get: () => ({}) } }));
const streamResponse = (
	OpenAiClient as unknown as { streamResponse(response: Response, state: ReturnType<typeof StreamStateFactory.create>): Response }
).streamResponse.bind(OpenAiClient);
const events = [
	{ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'one', name: 'Write' } },
	{ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path":' }
];

describe('Codex interruption (#68)', () => {
	it('terminates unexpected EOF exactly once without emitting unfinished tool arguments', async () => {
		const response = new Response(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''));
		const output = await streamResponse(response, StreamStateFactory.create('test')).text();
		expect(output).toContain('"finish_reason":"length"');
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
});
