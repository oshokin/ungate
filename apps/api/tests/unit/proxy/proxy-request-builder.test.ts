import { describe, expect, it, vi } from 'vitest';

vi.mock('src/database/app-settings', () => ({
	Settings: {
		get: vi.fn(() => ({
			extraInstruction: 'extra instruction from settings',
			claudeCliVersionMode: 'latest',
			claudeCliVersionCustom: null
		}))
	}
}));

import { CLAUDE_CODE_OPUS_PACKET } from 'src/proxy/claude-code-packet';
import { canonicalizeClaudeModel, RequestBuilder } from 'src/proxy/request-builder';

describe('proxy-request-builder', () => {
	it('prepares claude code body without changing explicit cache TTLs', () => {
		const prepared = RequestBuilder.prepareClaudeCodeBody({
			model: 'claude-sonnet-4-6',
			max_tokens: 1024,
			reasoning_budget: 'high',
			system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } }],
			messages: [
				{
					role: 'user',
					content: [{ type: 'text', text: 'u', cache_control: { type: 'ephemeral', ttl: '5m' } }]
				}
			]
		});

		expect(prepared.reasoning_budget).toBeUndefined();
		expect(prepared.thinking).toEqual(CLAUDE_CODE_OPUS_PACKET.thinking);
		expect(prepared.output_config).toEqual({ effort: 'high' });
		expect(prepared.context_management).toEqual(CLAUDE_CODE_OPUS_PACKET.contextManagement);
		expect(Array.isArray(prepared.system)).toBe(true);
		const system = prepared.system as { type: string; text?: string; cache_control?: { ttl?: string } }[];
		expect(system.some((block) => block.text === 'extra instruction from settings')).toBe(true);
		expect(system.find((block) => block.text === 'sys')?.cache_control?.ttl).toBe('1h');
		const userBlock = (prepared.messages[0].content as { cache_control?: { ttl?: string } }[])[0];
		expect(userBlock.cache_control?.ttl).toBe('5m');
	});

	it('passes each reasoning tier through verbatim as the effort level', () => {
		for (const tier of ['low', 'medium', 'high', 'xhigh'] as const) {
			const prepared = RequestBuilder.prepareClaudeCodeBody({
				model: 'claude-opus-4-8',
				max_tokens: 1024,
				reasoning_budget: tier,
				messages: [{ role: 'user', content: 'hello' }]
			});

			expect(prepared.reasoning_budget).toBeUndefined();
			expect(prepared.thinking).toEqual(CLAUDE_CODE_OPUS_PACKET.thinking);
			expect(prepared.output_config).toEqual({ effort: tier });
			expect(prepared.context_management).toEqual(CLAUDE_CODE_OPUS_PACKET.contextManagement);
		}
	});

	it('requests thinking updates and rewrites the dotted Opus 5.5 id', () => {
		const prepared = RequestBuilder.prepareClaudeCodeBody({
			model: ' Claude-Opus-5.5 ',
			max_tokens: 32000,
			reasoning_budget: 'xhigh',
			messages: [{ role: 'user', content: 'hello' }]
		});

		expect(prepared.model).toBe('claude-opus-5-5');
		expect(prepared.thinking).toEqual(CLAUDE_CODE_OPUS_PACKET.thinking);
		expect(prepared.output_config).toEqual({ effort: 'xhigh' });
		expect(prepared.context_management).toEqual(CLAUDE_CODE_OPUS_PACKET.contextManagement);
	});

	it('rewrites only the exact dotted Opus 5.5 id', () => {
		expect(canonicalizeClaudeModel('claude-opus-5.5')).toBe('claude-opus-5-5');
		expect(canonicalizeClaudeModel('claude-opus-5-5')).toBe('claude-opus-5-5');
		expect(canonicalizeClaudeModel('claude-opus-5.5-high')).toBe('claude-opus-5.5-high');
		expect(canonicalizeClaudeModel('claude-opus-4-8')).toBe('claude-opus-4-8');
		const prepared = RequestBuilder.prepareClaudeCodeBody({
			model: 'claude-opus-4-8',
			max_tokens: 1024,
			messages: [{ role: 'user', content: 'hello' }]
		});
		expect(prepared.model).toBe('claude-opus-4-8');
		expect(prepared.context_management).toBeUndefined();
	});

	it('ignores a non-tier reasoning budget without enabling thinking', () => {
		const prepared = RequestBuilder.prepareClaudeCodeBody({
			model: 'claude-opus-4-8',
			max_tokens: 1024,
			reasoning_budget: 10000,
			messages: [{ role: 'user', content: 'hello' }]
		});

		expect(prepared.reasoning_budget).toBeUndefined();
		expect(prepared.thinking).toBeUndefined();
		expect(prepared.output_config).toBeUndefined();
		expect(prepared.context_management).toBeUndefined();
	});

	it('does not set thinking when no reasoning budget is provided', () => {
		const prepared = RequestBuilder.prepareClaudeCodeBody({
			model: 'claude-opus-4-8',
			max_tokens: 1024,
			messages: [{ role: 'user', content: 'hello' }]
		});

		expect(prepared.thinking).toBeUndefined();
		expect(prepared.output_config).toBeUndefined();
	});

	it('converts string system prompt into system blocks', () => {
		const prepared = RequestBuilder.prepareClaudeCodeBody({
			model: 'claude-sonnet-4-6',
			max_tokens: 512,
			system: 'custom system',
			messages: [{ role: 'user', content: 'hello' }]
		});

		const system = prepared.system as { type: string; text?: string }[];
		expect(Array.isArray(system)).toBe(true);
		expect(system.some((block) => block.text === CLAUDE_CODE_OPUS_PACKET.identity)).toBe(true);
		expect(system.some((block) => block.text === 'custom system')).toBe(true);
		expect(system.some((block) => block.text === 'extra instruction from settings')).toBe(true);
	});

	it('builds the Claude Code 2.1.322 OAuth fingerprint from app settings', () => {
		expect(CLAUDE_CODE_OPUS_PACKET.betas).toHaveLength(18);
		expect(RequestBuilder.getClaudeOAuthUserAgent()).toBe(CLAUDE_CODE_OPUS_PACKET.userAgent);
		const headers = RequestBuilder.getClaudeOAuthHeaders('token-opus');
		expect(headers['User-Agent']).toBe(CLAUDE_CODE_OPUS_PACKET.userAgent);
		expect(headers['anthropic-beta']).toBe(CLAUDE_CODE_OPUS_PACKET.betas.join(','));
		expect(headers.Authorization).toBe('Bearer token-opus');
	});
});
