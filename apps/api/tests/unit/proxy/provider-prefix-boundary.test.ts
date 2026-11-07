import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	fetch: vi.fn<typeof fetch>(),
	miniMaxFetch: vi.fn<typeof fetch>(),
	token: vi.fn(),
	refresh: vi.fn()
}));
vi.mock('src/auth/openai/openai-oauth-service', () => ({
	OpenAIOAuthService: { getValidToken: mocks.token, refreshToken: mocks.refresh }
}));
vi.mock('src/auth', () => ({ getProvider: () => ({ getAuthHeader: () => Promise.resolve('Bearer test-key') }) }));
vi.mock('src/database/app-settings', () => ({ Settings: { get: () => ({ extraInstruction: 'Stable editor instructions' }) } }));
vi.mock('src/database/provider-settings', () => ({ ProviderSettings: { get: () => ({ baseUrl: 'https://api.minimax.io' }) } }));
vi.mock('src/security/minimax-url', () => ({
	validateMiniMaxBaseUrl: (url: string) => Promise.resolve(url),
	fetchMiniMax: mocks.miniMaxFetch
}));
vi.mock('src/utils/logger', () => ({ logger: { log: vi.fn(), error: vi.fn() } }));

import { proxyMiniMaxAnthropicRequest } from 'src/proxy/minimax-anthropic-client';
import { proxyMiniMaxRequest } from 'src/proxy/minimax-client';
import { OpenAiClient } from 'src/proxy/openai-client';

import type { AnthropicRequest } from 'src/types';
import type { OpenAIChatRequest } from 'src/types/openai';

function chat(): OpenAIChatRequest {
	return {
		model: 'gpt-5.4',
		messages: [
			{ role: 'system', content: 'Stable system prefix' },
			{ role: 'user', content: 'Inspect the project' },
			{
				role: 'assistant',
				content: null,
				tool_calls: [{ id: 'call_read', type: 'function', function: { name: 'Read', arguments: '{"path":"a.ts"}' } }]
			},
			{ role: 'tool', tool_call_id: 'call_read', content: 'file contents' },
			{ role: 'assistant', content: 'Inspection complete' },
			{ role: 'user', content: 'Continue' }
		],
		tools: [
			{
				type: 'function',
				function: {
					name: 'Read',
					description: 'Read a file',
					parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
				}
			}
		],
		tool_choice: 'auto'
	};
}

function captured(fetchMock: typeof mocks.fetch, index: number): Record<string, unknown> {
	return JSON.parse(fetchMock.mock.calls[index][1]!.body as string) as Record<string, unknown>;
}

describe('provider prefix fetch boundaries', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.stubGlobal('fetch', mocks.fetch);
		mocks.token.mockResolvedValue({ accessToken: 'test-token', refreshToken: 'test-refresh', accountId: 'test-account' });
		mocks.refresh.mockResolvedValue({ accessToken: 'refreshed-test-token', accountId: 'test-account' });
		// An upstream rejection avoids exercising unrelated response-stream translation.
		mocks.fetch.mockImplementation(() =>
			Promise.resolve(Response.json({ error: { message: 'test rejection' } }, { status: 400 }))
		);
		mocks.miniMaxFetch.mockImplementation(() => Promise.resolve(Response.json({ content: [] })));
	});
	afterEach(() => vi.unstubAllGlobals());

	it.each([undefined, 'client-session-key'])(
		'preserves Codex cache-key policy and stable prefix across turns and auth retry (%s)',
		async (key) => {
			const first = chat();
			if (key !== undefined) first.prompt_cache_key = key;
			const original = structuredClone(first);
			await OpenAiClient.proxy(first);
			const next = structuredClone(first);
			next.messages.push({ role: 'assistant', content: 'Next answer' }, { role: 'user', content: 'One more turn' });
			mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
			await OpenAiClient.proxy(next);

			expect(mocks.fetch).toHaveBeenCalledTimes(3);
			const bodies = [0, 1, 2].map((index) => captured(mocks.fetch, index));
			for (const body of bodies) {
				expect(body.instructions).toBe('Stable editor instructions');
				expect(body.tools).toEqual([
					{ type: 'function', name: 'Read', description: 'Read a file', parameters: first.tools![0].function.parameters }
				]);
				expect(body.tool_choice).toBe('auto');
				expect(Object.hasOwn(body, 'prompt_cache_key')).toBe(key !== undefined);
				expect(body.prompt_cache_key).toBe(key);
				expect(body).not.toHaveProperty('prompt_cache_retention');
			}
			const prefix = bodies[0].input as unknown[];
			expect(prefix).toContainEqual({ type: 'function_call', call_id: 'call_read', name: 'Read', arguments: '{"path":"a.ts"}' });
			expect(prefix).toContainEqual({ type: 'function_call_output', call_id: 'call_read', output: 'file contents' });
			expect((bodies[1].input as unknown[]).slice(0, prefix.length)).toEqual(prefix);
			expect(mocks.fetch.mock.calls[1][1]!.body).toBe(mocks.fetch.mock.calls[2][1]!.body);
			expect(new Headers(mocks.fetch.mock.calls[1][1]!.headers).get('authorization')).toBe('Bearer test-token');
			expect(new Headers(mocks.fetch.mock.calls[2][1]!.headers).get('authorization')).toBe('Bearer refreshed-test-token');
			expect(first).toEqual(original);
		}
	);

	it.each(['/v1/messages', '/v1/messages/count_tokens'] as const)(
		'preserves explicit MiniMax Anthropic cache policy and body at %s',
		async (endpoint) => {
			const body: AnthropicRequest = {
				model: 'local-alias',
				max_tokens: 100,
				system: [{ type: 'text', text: 'Stable prefix', cache_control: { type: 'ephemeral' } }],
				messages: [{ role: 'user', content: [{ type: 'text', text: 'Inspect', cache_control: { type: 'ephemeral' } }] }],
				tools: [
					{
						name: 'Read',
						description: 'Read file',
						input_schema: { type: 'object', properties: {} },
						cache_control: { type: 'ephemeral' }
					}
				]
			};
			const original = structuredClone(body);
			await proxyMiniMaxAnthropicRequest(endpoint, body, 'MiniMax-M2.7', {
				'anthropic-beta': 'prompt-caching-test',
				'anthropic-version': '2023-06-01'
			});
			expect(mocks.miniMaxFetch.mock.calls[0][0]).toBe(`https://api.minimax.io/anthropic${endpoint}`);
			expect(captured(mocks.miniMaxFetch, 0)).toEqual({ ...original, model: 'MiniMax-M2.7' });
			expect(mocks.miniMaxFetch.mock.calls[0][1]!.headers).toMatchObject({
				'anthropic-beta': 'prompt-caching-test',
				'anthropic-version': '2023-06-01'
			});
			expect(body).toEqual(original);
		}
	);

	it('uses MiniMax automatic chat caching without inventing Anthropic policy or cache keys', async () => {
		const body = { ...chat(), model: 'MiniMax-M2.7', prompt_cache_key: 'codex-only-key' };
		const original = structuredClone(body);
		await proxyMiniMaxRequest(body);
		const next = structuredClone(body);
		next.messages.push({ role: 'assistant', content: 'Answer' }, { role: 'user', content: 'Next' });
		await proxyMiniMaxRequest(next);
		const first = captured(mocks.miniMaxFetch, 0);
		const second = captured(mocks.miniMaxFetch, 1);
		expect(mocks.miniMaxFetch.mock.calls[0][0]).toBe('https://api.minimax.io/v1/text/chatcompletion_v2');
		expect(first.messages).toEqual(body.messages);
		expect(first.tools).toEqual(body.tools);
		expect(second.tools).toEqual(first.tools);
		expect((second.messages as unknown[]).slice(0, body.messages.length)).toEqual(first.messages);
		for (const payload of [first, second]) {
			expect(payload).not.toHaveProperty('prompt_cache_key');
			expect(payload).not.toHaveProperty('cache_control');
			expect(JSON.stringify(payload)).not.toContain('cache_control');
		}
		expect(body).toEqual(original);
	});
});
