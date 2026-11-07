import { describe, expect, it } from 'vitest';

import { CompletionAccumulator } from 'src/proxy/responses-stream-mapper/completion-accumulator';
import { ResponsesSseProcessor, StreamStateFactory } from 'src/proxy/responses-stream-mapper';

describe('synthetic terminal policy regressions', () => {
	it.each(['max_output_tokens', 'content_filter', 'unknown'])('preserves incomplete reason %s after a completed tool', (reason) => {
		const state = StreamStateFactory.create('synthetic');
		const accumulator = new CompletionAccumulator();
		const events = [
			{ type: 'response.output_item.done', output_index: 0, item: { id: 'a', type: 'function_call', call_id: 'call_a', name: 'Read', arguments: '{}' } },
			{ type: 'response.output_item.added', output_index: 1, item: { id: 'b', type: 'function_call', call_id: 'call_b', name: 'Read' } },
			{ type: 'response.incomplete', response: { incomplete_details: { reason } } },
			{ type: 'response.output_text.delta', delta: 'must not appear' },
			{ type: 'response.completed', response: {} }
		];
		const results = ResponsesSseProcessor.process(state, events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
		accumulator.consume(results);
		const response = accumulator.response(state);
		expect(response.choices).toEqual([expect.objectContaining({ finish_reason: reason === 'content_filter' ? 'content_filter' : 'length' })]);
		expect(JSON.stringify(response)).not.toContain('must not appear');
		expect(results.filter((result) => result.type === 'done')).toHaveLength(1);
		expect(state.successfulCompletion).toBe(false);
	});

	it('ignores accumulator input after its terminal chunk', () => {
		const state = StreamStateFactory.create('synthetic');
		const accumulator = new CompletionAccumulator();
		accumulator.consume([
			{ type: 'chunk', data: { choices: [{ delta: { content: 'before' }, finish_reason: 'length' }] } },
			{ type: 'chunk', data: { choices: [{ delta: { content: 'after' }, finish_reason: 'stop' }] } }
		]);
		expect(accumulator.response(state).choices).toEqual([{ index: 0, message: { role: 'assistant', content: 'before' }, finish_reason: 'length' }]);
	});
});
