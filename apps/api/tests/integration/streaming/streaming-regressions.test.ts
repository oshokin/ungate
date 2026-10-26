import { describe, expect, it, vi } from 'vitest';

import { OpenAIStreamHandler } from 'src/streaming/openai-stream-handler';
import { MiniMaxStreamHandler } from 'src/streaming/minimax-stream-handler';

const context = { model: 'test', source: 'claude' as const, startTime: 0, reverseToolMapping: {} };
function upstream(events: unknown[]): Response {
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
}
async function chunks(stream: ReadableStream): Promise<Record<string, unknown>[]> {
	const text = await new Response(stream).text();
	expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
	return text
		.split('\n')
		.filter((line) => line.startsWith('data: {'))
		.map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}
function deltas(output: Record<string, unknown>[]) {
	return output.flatMap(
		(chunk) =>
			(chunk.choices as { delta?: { tool_calls?: { index: number; function?: { arguments?: string } }[] } }[])?.[0]?.delta
				?.tool_calls ?? []
	);
}
function finish(output: Record<string, unknown>[]) {
	return (output.filter((chunk) => (chunk.choices as unknown[])?.length).at(-1)?.choices as { finish_reason: string }[])?.[0]
		?.finish_reason;
}

describe('interruption and parallel-tool regressions', () => {
	it.each(['end_turn', 'refusal', 'pause_turn', 'stop_sequence'])(
		'Claude %s cannot complete an open tool block (#67)',
		async (reason) => {
			const { stream } = OpenAIStreamHandler.createStreamResponse(
				upstream([
					{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'one', name: 'Write' } },
					{ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
					{ type: 'message_delta', delta: { stop_reason: reason } },
					{ type: 'message_stop' }
				]),
				'test',
				'test',
				context
			);
			const output = await chunks(stream);
			expect(finish(output)).toBe('length');
			expect(
				deltas(output)
					.map((delta) => delta.function?.arguments)
					.filter(Boolean)
			).toEqual([]);
		}
	);

	it('preserves interleaved Claude calls and distinct output indexes (#74)', async () => {
		const { stream } = OpenAIStreamHandler.createStreamResponse(
			upstream([
				{ type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'one', name: 'Read' } },
				{ type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
				{ type: 'content_block_start', index: 8, content_block: { type: 'tool_use', id: 'two', name: 'Read' } },
				{ type: 'content_block_delta', index: 8, delta: { type: 'input_json_delta', partial_json: '{"path":"b"}' } },
				{ type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '"a"}' } },
				{ type: 'content_block_stop', index: 8 },
				{ type: 'content_block_stop', index: 3 },
				{ type: 'message_delta', delta: { stop_reason: 'tool_use' } },
				{ type: 'message_stop' }
			]),
			'test',
			'test',
			context
		);
		const output = await chunks(stream);
		const calls = deltas(output);
		expect(calls.filter((call) => call.function?.arguments).map((call) => [call.index, call.function?.arguments])).toEqual([
			[1, '{"path":"b"}'],
			[0, '{"path":"a"}']
		]);
		expect(finish(output)).toBe('tool_calls');
	});

	it('MiniMax EOF discards even parseable tool arguments until a tool finish reason (#68)', async () => {
		const { stream } = MiniMaxStreamHandler.createStreamResponse(
			upstream([
				{
					choices: [{ delta: { tool_calls: [{ index: 0, id: 'one', function: { name: 'Write', arguments: '{"path":"a"}' } }] } }]
				}
			]),
			'test',
			'test',
			context
		);
		const output = await chunks(stream);
		expect(finish(output)).toBe('length');
		expect(deltas(output)).toEqual([]);
	});
});
