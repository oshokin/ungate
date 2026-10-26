import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpenAiClient } from 'src/proxy/openai-client';

vi.mock('src/database/provider-settings', () => ({
	ProviderSettings: { get: () => ({ accessToken: 'test-token', accountId: 'test-account' }) }
}));
vi.mock('src/database/app-settings', () => ({ Settings: { get: () => ({ extraInstruction: null }) } }));
vi.mock('src/utils/logger', () => ({ logger: { log: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
afterEach(() => {
	vi.unstubAllGlobals();
});

describe('buffered Codex protocol usage', () => {
	it.each([true, false])('preserves presence of actual upstream usage: %s', async (withUsage) => {
		const usage = {
			input_tokens: 37,
			output_tokens: 5,
			total_tokens: 42,
			input_tokens_details: { cached_tokens: 16 },
			output_tokens_details: { reasoning_tokens: 3 }
		};
		const events = [
			{ type: 'response.output_text.delta', delta: 'OK' },
			{ type: 'response.completed', response: withUsage ? { usage } : {} }
		];
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')))
		);
		const result = await OpenAiClient.proxy({ model: 'gpt-5.4', messages: [{ role: 'user', content: 'Hi' }], stream: false });
		const body = (await result.response.json()) as Record<string, unknown>;
		if (withUsage)
			expect(body.usage).toEqual({
				prompt_tokens: 37,
				completion_tokens: 5,
				total_tokens: 42,
				prompt_tokens_details: { cached_tokens: 16 },
				completion_tokens_details: { reasoning_tokens: 3 }
			});
		else expect(body).not.toHaveProperty('usage');
	});
});
