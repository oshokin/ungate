import { describe, expect, it } from 'vitest';

import { StreamDiagnostics } from 'src/proxy/responses-stream-mapper/stream-diagnostics';

describe('synthetic usage presence contract', () => {
	it.each([undefined, {}, { input_tokens: 1 }, { output_tokens: 0 }, { input_tokens: -1, output_tokens: 2 }])('omits unavailable or malformed usage %j', (usage) => {
		expect(StreamDiagnostics.mapUsage(usage)).toBeUndefined();
	});

	it('preserves explicit zero total without adding cached or reasoning subtotals', () => {
		expect(StreamDiagnostics.mapUsage({
			input_tokens: 10, output_tokens: 20, total_tokens: 0,
			input_tokens_details: { cached_tokens: 5 }, output_tokens_details: { reasoning_tokens: 7 }
		})).toEqual({
			prompt_tokens: 10, completion_tokens: 20, total_tokens: 0,
			prompt_tokens_details: { cached_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 7 }
		});
	});

	it('derives a missing total only from complete top-level counts', () => {
		expect(StreamDiagnostics.mapUsage({ input_tokens: 0, output_tokens: 2 })).toEqual({
			prompt_tokens: 0, completion_tokens: 2, total_tokens: 2
		});
	});
});
