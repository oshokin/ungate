import { describe, expect, it } from 'vitest';

import { anthropicRequestSchema, MAX_REQUEST_OUTPUT_TOKENS, MAX_STOP_SEQUENCE_CHARS, openAiChatRequestSchema } from 'src/schemas/proxy-requests';
import { DEFAULT_STREAM_TIMING, OpenAIStreamHandler } from 'src/streaming/openai-stream-handler';
import { MAX_NODE_TIMER_MS, STREAM_FIRST_BYTE_TIMEOUT_MS, STREAM_HEARTBEAT_MS } from 'src/streaming/stream-timing';

describe('API domain policy boundaries', () => {
	it('keeps stop-string and output-token policies independent', () => {
		expect(openAiChatRequestSchema.body.properties.stop.anyOf[0].maxLength).toBe(MAX_STOP_SEQUENCE_CHARS);
		expect(anthropicRequestSchema.body.properties.max_tokens.maximum).toBe(MAX_REQUEST_OUTPUT_TOKENS);
		expect(MAX_STOP_SEQUENCE_CHARS).toBe(1_000_000);
		expect(MAX_REQUEST_OUTPUT_TOKENS).toBe(1_000_000);
	});

	it('uses the provider transport timing policies', () => {
		expect(DEFAULT_STREAM_TIMING).toEqual({
			keepaliveIntervalMs: STREAM_HEARTBEAT_MS,
			upstreamIdleTimeoutMs: STREAM_FIRST_BYTE_TIMEOUT_MS
		});
	});

	it.each([0, -1, 0.5, Infinity, NaN, MAX_NODE_TIMER_MS + 1])('rejects unsafe timer %s before locking a body', (value) => {
		const response = new Response('data');
		expect(() =>
			OpenAIStreamHandler.createStreamResponse(
				response,
				'id',
				'claude',
				{ model: 'claude', source: 'claude', startTime: 0, reverseToolMapping: {} },
				{ upstreamIdleTimeoutMs: value }
			)
		).toThrow(RangeError);
		expect(response.body?.locked).toBe(false);
	});
});
