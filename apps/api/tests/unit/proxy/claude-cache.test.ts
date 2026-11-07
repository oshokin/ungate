import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('src/database/app-settings', () => ({ Settings: { get: () => ({ extraInstruction: '' }) } }));
vi.mock('src/database/provider-settings', () => ({ ProviderSettings: { get: vi.fn() } }));
vi.mock('src/auth/oauth', () => ({ OAuth: { getValidToken: () => Promise.resolve({ accessToken: 'test-token' }) } }));
vi.mock('src/security/outbound-request', () => ({ fetchWithHeaderTimeout: vi.fn(() => Promise.resolve(new Response('{}'))) }));

import { openaiToAnthropic } from 'src/adapter/openai-to-anthropic';
import { proxyRequest } from 'src/proxy/anthropic-client';
import { RequestBuilder } from 'src/proxy/request-builder';
import { fetchWithHeaderTimeout } from 'src/security/outbound-request';

import type { AnthropicRequest } from 'src/types';

const body = (): AnthropicRequest => ({
	model: 'claude-sonnet-4-6',
	max_tokens: 10,
	messages: [{ role: 'user', content: 'hi' }]
});

afterEach(() => vi.clearAllMocks());

describe('Claude automatic caching', () => {
	it.each([undefined, '5m', '1h'] as const)('preserves four chat breakpoints with ttl=%s without adding a fifth', (ttl) => {
		const policy = { type: 'ephemeral' as const, ...(ttl ? { ttl } : {}) };
		const text = (value: string) => ({ type: 'text' as const, text: value, cache_control: policy });
		const input = {
			model: 'claude-sonnet-4-6',
			tools: [{ type: 'function' as const, function: { name: 'Read', parameters: { type: 'object' } }, cache_control: policy }],
			messages: [
				{ role: 'system' as const, content: 'before' },
				{ role: 'system' as const, content: [text('cached system'), { type: 'text' as const, text: 'after block' }] },
				{ role: 'system' as const, content: 'after system' },
				{ role: 'user' as const, content: [text('user')] },
				{ role: 'assistant' as const, content: [text('assistant')] }
			]
		};
		const original = structuredClone(input);
		const converted = openaiToAnthropic(input);
		const convertedOriginal = structuredClone(converted);
		const prepared = RequestBuilder.prepareClaudeCodeBody(converted, '/v1/messages');
		expect(prepared).not.toHaveProperty('cache_control');
		expect(prepared.tools?.[0].cache_control).toEqual(policy);
		expect(prepared.system).toEqual(
			expect.arrayContaining([
				{ type: 'text', text: 'before' },
				text('cached system'),
				{ type: 'text', text: 'after block' },
				{ type: 'text', text: 'after system' }
			])
		);
		expect((prepared.system as unknown[]).slice(-4)).toEqual([
			{ type: 'text', text: 'before' },
			text('cached system'),
			{ type: 'text', text: 'after block' },
			{ type: 'text', text: 'after system' }
		]);
		expect(prepared.messages).toEqual([
			{ role: 'user', content: [text('user')] },
			{ role: 'assistant', content: [text('assistant')] }
		]);
		expect(input).toEqual(original);
		expect(converted).toEqual(convertedOriginal);
		expect(JSON.stringify(prepared).match(/"cache_control"/g)).toHaveLength(4);
		expect(prepared).not.toHaveProperty('thinking');
	});

	it.each(['https://example.com/image.png', 'data:image/png;base64,YQ=='])(
		'preserves image policies through conversion and preparation (%s)',
		(url) => {
			const cache_control = { type: 'ephemeral' as const, ttl: '5m' as const };
			const content = [{ type: 'image_url' as const, image_url: { url }, cache_control }];
			const input = { model: 'claude', messages: [{ role: 'user' as const, content }] };
			const original = structuredClone(input);
			const prepared = RequestBuilder.prepareClaudeCodeBody(openaiToAnthropic(input), '/v1/messages');
			expect(prepared.messages[0].content).toEqual([expect.objectContaining({ type: 'image', cache_control })]);
			expect(prepared).not.toHaveProperty('cache_control');
			expect(input).toEqual(original);
		}
	);

	it('keeps unmarked chat content and tools unmarked while retaining the builder default', () => {
		const converted = openaiToAnthropic({
			model: 'claude',
			tools: [{ type: 'function', function: { name: 'Read' } }],
			messages: [
				{
					role: 'system',
					content: [
						{ type: 'text', text: 'one' },
						{ type: 'text', text: 'two' }
					]
				},
				{ role: 'user', content: [{ type: 'text', text: 'hi' }] }
			]
		});
		expect(converted.system).toBe('one\ntwo');
		expect(JSON.stringify(converted)).not.toContain('cache_control');
		const prepared = RequestBuilder.prepareClaudeCodeBody(converted, '/v1/messages');
		expect(prepared.cache_control).toEqual({ type: 'ephemeral' });
		expect(JSON.stringify(prepared).match(/"cache_control"/g)).toHaveLength(1);
	});

	it.each([false, true])('adds a TTL-free default at the actual Claude fetch boundary (chat=%s)', async (chat) => {
		const input = chat ? openaiToAnthropic({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] }) : body();
		const original = structuredClone(input);
		await proxyRequest('/v1/messages', input, {});
		const init = vi.mocked(fetchWithHeaderTimeout).mock.calls[0][1];
		expect((JSON.parse(init.body as string) as AnthropicRequest).cache_control).toEqual({ type: 'ephemeral' });
		expect(input).toEqual(original);
	});

	it('does not add caching to count_tokens', async () => {
		await proxyRequest('/v1/messages/count_tokens', body(), {});
		const init = vi.mocked(fetchWithHeaderTimeout).mock.calls[0][1];
		expect(JSON.parse(init.body as string)).not.toHaveProperty('cache_control');
	});

	it.each([undefined, '5m', '1h'] as const)('preserves explicit top-level policy ttl=%s through chat conversion', (ttl) => {
		const cache_control = ttl ? { type: 'ephemeral' as const, ttl } : { type: 'ephemeral' as const };
		const request = openaiToAnthropic({ model: 'claude', messages: [{ role: 'user', content: 'hi' }], cache_control });
		expect(RequestBuilder.prepareClaudeCodeBody(request, '/v1/messages').cache_control).toEqual(cache_control);
	});

	it.each(['system', 'messages', 'tools', 'four'] as const)('leaves explicit %s breakpoints and source untouched', (location) => {
		const input = body();
		const block = { type: 'text' as const, text: 'stable', cache_control: { type: 'ephemeral' as const, ttl: '1h' as const } };
		if (location === 'system') input.system = [block];
		if (location === 'messages' || location === 'four')
			input.messages[0].content = Array.from({ length: location === 'four' ? 4 : 1 }, () => structuredClone(block));
		if (location === 'tools')
			input.tools = [{ name: 'test', description: '', input_schema: {}, cache_control: block.cache_control }];
		const original = structuredClone(input);
		const prepared = RequestBuilder.prepareClaudeCodeBody(input, '/v1/messages');
		expect(prepared).not.toHaveProperty('cache_control');
		expect(input).toEqual(original);
		expect(prepared.messages).toEqual(original.messages);
		expect(prepared.tools).toEqual(original.tools);
	});
});
