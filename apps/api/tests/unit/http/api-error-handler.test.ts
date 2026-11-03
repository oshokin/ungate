import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { chatMessageLimitMessage, registerApiErrorHandler } from 'src/http/api-error-handler';
import { anthropicRequestSchema, MAX_CHAT_MESSAGES, openAiChatRequestSchema } from 'src/schemas/proxy-requests';

const limitMessage = (count: number) =>
	`Chat has ${count} messages (limit ${MAX_CHAT_MESSAGES}). Start a new chat; this one is unchanged.`;
const limitMessageWithoutCount = `Chat exceeds the ${MAX_CHAT_MESSAGES}-message limit. Start a new chat; this one is unchanged.`;

function appFor(schema: object, url: string): FastifyInstance {
	const app = Fastify({ logger: false });
	registerApiErrorHandler(app);
	app.post(url, { schema }, () => ({ ok: true }));

	return app;
}

function messages(count: number): { role: 'user'; content: string }[] {
	return Array.from({ length: count }, () => ({ role: 'user', content: 'x' }));
}

describe('chat message limit error', () => {
	const errors: unknown[][] = [];
	afterEach(() => {
		errors.length = 0;
		vi.restoreAllMocks();
	});

	it('tells Cursor the count, the limit, and to start a new chat', async () => {
		vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
			errors.push(args);
		});
		const app = appFor(openAiChatRequestSchema, '/v1/chat/completions');
		const count = MAX_CHAT_MESSAGES + 1;
		const response = await app.inject({
			method: 'POST',
			url: '/v1/chat/completions',
			payload: { model: 'gpt-5.6-sol', messages: messages(count) }
		});

		expect(response.statusCode).toBe(400);
		expect(response.json()).toEqual({
			error: { message: limitMessage(count), type: 'invalid_request_error', code: 'invalid_request' }
		});
		expect(String(errors.at(-1)?.[0])).toContain('/messages maxItems');
		expect(limitMessage(count)).not.toMatch(/maxItems|invalid|Request validation failed/);
		await app.close();
	});

	it('uses the same sentence for the Anthropic messages endpoint', async () => {
		const app = appFor(anthropicRequestSchema, '/v1/messages');
		const count = MAX_CHAT_MESSAGES + 1;
		const response = await app.inject({
			method: 'POST',
			url: '/v1/messages',
			payload: { model: 'claude', max_tokens: 16, messages: messages(count) }
		});

		expect(response.json()).toEqual({
			error: { message: limitMessage(count), type: 'invalid_request_error', code: 'invalid_request' }
		});
		await app.close();
	});

	it('accepts a transcript at the limit', async () => {
		const app = appFor(openAiChatRequestSchema, '/v1/chat/completions');
		const response = await app.inject({
			method: 'POST',
			url: '/v1/chat/completions',
			payload: { model: 'gpt-5.6-sol', messages: messages(MAX_CHAT_MESSAGES) }
		});

		expect(response.statusCode).toBe(200);
		await app.close();
	});

	it('keeps a missing model technical', async () => {
		const app = appFor(openAiChatRequestSchema, '/v1/chat/completions');
		const response = await app.inject({
			method: 'POST',
			url: '/v1/chat/completions',
			payload: { messages: messages(1) }
		});
		const body = response.json<{ error: { message: string } }>();

		expect(response.statusCode).toBe(400);
		expect(body.error.message).toContain('Request validation failed');
		expect(body.error.message).not.toContain('Start a new chat');
		await app.close();
	});

	it('does not treat another array limit as a long chat', async () => {
		const app = appFor(openAiChatRequestSchema, '/v1/chat/completions');
		const response = await app.inject({
			method: 'POST',
			url: '/v1/chat/completions',
			payload: {
				model: 'gpt-5.6-sol',
				messages: messages(1),
				stop: Array.from({ length: 17 }, () => 'stop')
			}
		});
		const body = response.json<{ error: { message: string } }>();

		expect(body.error.message).toContain('/stop');
		expect(body.error.message).not.toContain('Start a new chat');
		await app.close();
	});

	it('explains the limit when the message list cannot be counted', () => {
		expect(chatMessageLimitMessage([{ keyword: 'maxItems', instancePath: '/messages' }], null)).toBe(limitMessageWithoutCount);
		expect(chatMessageLimitMessage([{ keyword: 'maxItems', instancePath: '/messages' }], { messages: 'nope' })).toBe(
			limitMessageWithoutCount
		);
	});

	it('ignores a maxItems failure that is not the chat transcript', () => {
		expect(chatMessageLimitMessage([{ keyword: 'maxItems', instancePath: '/tools' }], { messages: [] })).toBeUndefined();
		expect(
			chatMessageLimitMessage([{ keyword: 'maxItems', instancePath: '/messages/0/content' }], { messages: [] })
		).toBeUndefined();
	});

	it('reports an oversized body without calling it a long chat', async () => {
		const app = Fastify({ logger: false, bodyLimit: 32 });
		registerApiErrorHandler(app);
		app.post('/v1/chat/completions', () => ({ ok: true }));
		const response = await app.inject({
			method: 'POST',
			url: '/v1/chat/completions',
			headers: { 'content-type': 'application/json' },
			payload: { model: 'gpt-5.6-sol', messages: messages(4) }
		});
		const body = response.json<{ error: { message: string; code: string } }>();

		expect(response.statusCode).toBe(413);
		expect(body.error).toEqual({ message: 'Request body too large', type: 'invalid_request_error', code: 'request_too_large' });
		await app.close();
	});

	it('hides an unexpected failure behind a short API error', async () => {
		const app = Fastify({ logger: false });
		registerApiErrorHandler(app);
		app.post('/boom', () => {
			throw new Error('disk full at /secret/path');
		});
		const response = await app.inject({ method: 'POST', url: '/boom' });

		expect(response.statusCode).toBe(500);
		expect(response.json()).toEqual({ error: { message: 'Request failed', type: 'api_error' } });
		await app.close();
	});
});
