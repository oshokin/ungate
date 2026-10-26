import { describe, expect, it } from 'vitest';

import { StreamDiagnostics, StreamStateFactory } from 'src/proxy/responses-stream-mapper';
import { ResponsesEventRouter } from 'src/proxy/responses-stream-mapper/responses-event-router';

describe('ported Codex usage mapping', () => {
	it('stores the completed upstream usage and emits the same protocol values', () => {
		const state = StreamStateFactory.create('model');
		const results: import('src/proxy/responses-stream-mapper').StreamProcessResult[] = [];
		ResponsesEventRouter.route(
			state,
			{ type: 'response.completed', response: { usage: { input_tokens: 8, output_tokens: 3 } } },
			results
		);
		expect(state.usage).toEqual({ prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 });
		expect(results.find((result) => result.type === 'chunk')?.data?.usage).toEqual(state.usage);
	});
	it('preserves cached and reasoning details without estimated totals', () => {
		expect(
			StreamDiagnostics.mapUsage({
				input_tokens: 120,
				output_tokens: 30,
				total_tokens: 150,
				input_tokens_details: { cached_tokens: 100 },
				output_tokens_details: { reasoning_tokens: 20 }
			})
		).toEqual({
			prompt_tokens: 120,
			completion_tokens: 30,
			total_tokens: 150,
			prompt_tokens_details: { cached_tokens: 100 },
			completion_tokens_details: { reasoning_tokens: 20 }
		});
	});
	it('does not turn absent or malformed upstream usage into a zero allowance', () => {
		expect(StreamDiagnostics.mapUsage(undefined)).toBeUndefined();
		expect(StreamDiagnostics.mapUsage({ input_tokens: '12', output_tokens: -1 })).toBeUndefined();
		expect(StreamDiagnostics.mapUsage({ input_tokens: 0, output_tokens: 0 })).toEqual({
			prompt_tokens: 0,
			completion_tokens: 0,
			total_tokens: 0
		});
	});
});
