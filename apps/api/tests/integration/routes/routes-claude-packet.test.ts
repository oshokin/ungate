import { afterEach, describe, expect, it, vi } from 'vitest';

import { Settings } from 'src/database/app-settings';
import { ModelMappings } from 'src/database/model-mappings';
import { ProviderSettings } from 'src/database/provider-settings';
import { CLAUDE_CODE_OPUS_PACKET } from 'src/proxy/claude-code-packet';
import openaiPlugin from 'src/routes/openai';

import { withPlugin } from '../test-harness';

const anthropicOk = () =>
	new Response(
		JSON.stringify({
			id: 'msg_1',
			type: 'message',
			role: 'assistant',
			model: 'claude-opus-5-5',
			content: [{ type: 'text', text: 'ok' }],
			stop_reason: 'end_turn',
			usage: { input_tokens: 3, output_tokens: 1 }
		}),
		{ status: 200, headers: { 'content-type': 'application/json' } }
	);

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('Claude Code Opus packet', () => {
	it('sends the 2.1.322 headers and body for a dotted Opus 5.5 mapping', async () => {
		Settings.get();
		Settings.update({ claudeCliVersionMode: 'latest' });
		ModelMappings.replace([
			{
				id: 'opus-5.5-medium',
				label: 'Opus 5.5 Medium',
				provider: 'claude',
				upstreamModel: 'claude-opus-5.5',
				sortOrder: 0,
				reasoningBudget: 'medium',
				serviceTier: null
			}
		]);
		ProviderSettings.upsertOAuth('claude', {
			accessToken: 'token-opus',
			refreshToken: 'refresh-opus',
			expiresAt: Date.now() + 3_600_000,
			email: 'opus@example.com'
		});

		let captured: { url: string; headers: Record<string, string>; body: string } | undefined;
		vi.stubGlobal(
			'fetch',
			vi.fn((url: string, init?: RequestInit) => {
				const headers = init?.headers;
				captured = {
					url: String(url),
					headers: headers && !(headers instanceof Headers) && !Array.isArray(headers) ? { ...headers } : {},
					body: typeof init?.body === 'string' ? init.body : ''
				};

				return Promise.resolve(anthropicOk());
			})
		);

		const app = await withPlugin(openaiPlugin, { apiKey: 'secret' });
		try {
			const response = await app.inject({
				method: 'POST',
				url: '/v1/chat/completions',
				headers: { authorization: 'Bearer secret' },
				payload: {
					model: 'opus-5.5-medium',
					max_tokens: 128000,
					stream: false,
					messages: [{ role: 'user', content: 'hi' }],
					tools: [
						{
							type: 'function',
							function: {
								name: 'Shell',
								description: 'Run a command',
								parameters: { type: 'object', properties: { command: { type: 'string' } } }
							}
						}
					]
				}
			});

			expect(response.statusCode).toBe(200);
			expect(captured?.url).toBe('https://api.anthropic.com/v1/messages?beta=true');
			expect(captured?.headers.Authorization).toBe('Bearer token-opus');
			expect(captured?.headers['anthropic-beta']).toBe(CLAUDE_CODE_OPUS_PACKET.betas.join(','));
			expect(captured?.headers['User-Agent']).toBe(CLAUDE_CODE_OPUS_PACKET.userAgent);
			expect(captured?.headers['anthropic-version']).toBe('2023-06-01');
			expect(captured?.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
			expect(captured?.headers['x-app']).toBe('cli');

			const body = JSON.parse(captured?.body ?? '{}') as {
				model: string;
				max_tokens: number;
				thinking: unknown;
				output_config: unknown;
				context_management: unknown;
				system: { type: string; text?: string }[];
				tools: { name: string }[];
			};
			expect(body.model).toBe('claude-opus-5-5');
			expect(body.max_tokens).toBe(128000);
			expect(body.thinking).toEqual(CLAUDE_CODE_OPUS_PACKET.thinking);
			expect(body.output_config).toEqual({ effort: 'medium' });
			expect(body.context_management).toEqual(CLAUDE_CODE_OPUS_PACKET.contextManagement);
			expect(body.system[0]).toEqual({ type: 'text', text: CLAUDE_CODE_OPUS_PACKET.identity });
			expect(body.tools.map((tool) => tool.name)).toEqual(['Shell']);
		} finally {
			await app.close();
		}
	});
});
