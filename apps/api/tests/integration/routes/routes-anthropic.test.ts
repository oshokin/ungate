import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import anthropicPlugin from 'src/routes/anthropic';
import { ModelMappings } from 'src/database/model-mappings';
import { withPlugin } from '../test-harness';

const proxyRequestMock = vi.fn();
const minimaxRequestMock = vi.fn();

vi.mock('src/proxy/minimax-anthropic-client', () => ({
	proxyMiniMaxAnthropicRequest: (...args: unknown[]) => minimaxRequestMock(...args)
}));

vi.mock('src/proxy/anthropic-client', () => ({
	proxyRequest: (...args: unknown[]) => proxyRequestMock(...args)
}));

describe('routes-anthropic', () => {
	const mapping = { id: 'm', label: 'Model', provider: 'claude' as const, upstreamModel: 'claude-upstream', sortOrder: 0, reasoningBudget: null, serviceTier: null, contextWindow: null, maxOutputTokens: null };
	beforeEach(() => {
		vi.spyOn(ModelMappings, 'resolveForChatCompletion').mockReturnValue(mapping);
	});
	afterEach(() => {
		vi.resetAllMocks();
		vi.restoreAllMocks();
	});

	it.each(['/v1/messages', '/v1/messages/count_tokens'])('preserves MiniMax routing on %s', async (url) => {
		vi.mocked(ModelMappings.resolveForChatCompletion).mockReturnValue({ ...mapping, provider: 'minimax', upstreamModel: 'MiniMax-M2.7' });
		minimaxRequestMock.mockResolvedValueOnce(new Response('{}'));
		const app = await withPlugin(anthropicPlugin, { apiKey: 'secret' });
		const response = await app.inject({ method: 'POST', url, headers: { 'x-api-key': 'secret' }, payload: { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] } });
		expect(response.statusCode).toBe(200);
		expect(minimaxRequestMock.mock.calls[0][2]).toBe('MiniMax-M2.7');
		expect(minimaxRequestMock.mock.calls[0][1]).not.toHaveProperty('cache_control');
		expect(proxyRequestMock).not.toHaveBeenCalled();
		await app.close();
	});

	it.each(['/v1/messages', '/v1/messages/count_tokens'])('resolves Claude aliases on %s', async (url) => {
		proxyRequestMock.mockResolvedValueOnce({ response: new Response('{}') });
		const app = await withPlugin(anthropicPlugin, { apiKey: 'secret' });
		const response = await app.inject({ method: 'POST', url, headers: { 'x-api-key': 'secret' }, payload: { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] } });
		expect(response.statusCode).toBe(200);
		expect(proxyRequestMock.mock.calls[0][1].model).toBe('claude-upstream');
		await app.close();
	});

	it.each(['/v1/messages', '/v1/messages/count_tokens'])('rejects unknown and incompatible models on %s', async (url) => {
		const app = await withPlugin(anthropicPlugin, { apiKey: 'secret' });
		for (const resolved of [null, { ...mapping, provider: 'openai' as const }]) {
			vi.mocked(ModelMappings.resolveForChatCompletion).mockReturnValue(resolved);
			const response = await app.inject({ method: 'POST', url, headers: { 'x-api-key': 'secret' }, payload: { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] } });
			expect(response.statusCode).toBe(400);
		}
		expect(proxyRequestMock).not.toHaveBeenCalled();
		await app.close();
	});

	it('proxies stream body and headers', async () => {
		const upstreamBody = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('ok'));
				controller.close();
			}
		});
		proxyRequestMock.mockResolvedValueOnce({
			response: new Response(upstreamBody, {
				status: 201,
				headers: { 'content-type': 'text/plain', 'content-encoding': 'gzip', 'x-up': '1' }
			})
		});

		const app = await withPlugin(anthropicPlugin, { apiKey: 'secret' });
		const response = await app.inject({
			method: 'POST',
			url: '/v1/messages',
			headers: { 'x-api-key': 'secret' },
			payload: { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }
		});

		expect(response.statusCode).toBe(201);
		expect(response.headers['x-up']).toBeUndefined();
		expect(response.headers['content-encoding']).toBeUndefined();
		await app.close();
	});

	it('uses arrayBuffer fallback when body is missing', async () => {
		const noBodyResponse = new Response(null, { status: 202, headers: { 'x-up': 'x' } });
		proxyRequestMock.mockResolvedValueOnce({ response: noBodyResponse });

		const app = await withPlugin(anthropicPlugin, { apiKey: 'secret' });
		const response = await app.inject({
			method: 'POST',
			url: '/v1/messages',
			headers: { authorization: 'Bearer secret' },
			payload: { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }
		});

		expect(response.statusCode).toBe(202);
		await app.close();
	});

	it('returns a sanitized 500 on an unexpected internal error', async () => {
		proxyRequestMock.mockRejectedValueOnce(new Error('upstream boom'));
		const app = await withPlugin(anthropicPlugin, { apiKey: 'secret' });
		const response = await app.inject({
			method: 'POST',
			url: '/v1/messages',
			headers: { authorization: 'Bearer secret' },
			payload: { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }
		});

		expect(response.statusCode).toBe(500);
		expect(response.json().error.message).toBe('Internal gateway error.');
		await app.close();
	});
});
