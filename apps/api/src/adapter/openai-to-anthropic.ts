import { logger } from 'src/utils/logger';

import { resolveMaxOutputTokens } from '../proxy/output-tokens';
import { DEFAULT_MAX_TOKENS, REASONING_MAX_TOKENS } from '../proxy/token-budgets';

import type { AnthropicRequest, AnthropicMessage, CacheControl, ContentBlock, Tool, ToolChoice } from '../types';
import type { OpenAIContentPart, OpenAIChatRequest } from '../types/openai';
import type { ReasoningBudgetTier } from '@ungate/shared';

// Legacy Cursor model names can include explicit budgets or the old "-thinking" suffix.
// e.g. "claude-4.6-opus-high" → "claude-opus-4-6" with reasoningBudget="high"
export function normalizeModelName(model: string): { model: string; reasoningBudget?: string } {
	const match46 = /^claude-4\.6-(opus|sonnet)(?:-(high|medium|low))?(?:-thinking)?$/.exec(model);
	if (match46) {
		return {
			model: `claude-${match46[1]}-4-6`,
			reasoningBudget: match46[2] || undefined
		};
	}

	const match = /^claude-4\.5-(opus|sonnet|haiku)(?:-(high|medium|low))?(?:-thinking)?$/.exec(model);
	if (match) {
		const modelType = match[1] as 'opus' | 'sonnet' | 'haiku';
		const budget = match[2];

		const modelMap = {
			opus: 'claude-opus-4-5-20251101',
			sonnet: 'claude-sonnet-4-5-20250929',
			haiku: 'claude-haiku-4-5-20251001'
		} as const;

		return { model: modelMap[modelType], reasoningBudget: budget || undefined };
	}

	return { model };
}

export interface AnthropicModelOverride {
	model: string;
	reasoningBudget?: ReasoningBudgetTier | null;
	maxOutputTokens?: number | null;
}

// Anthropic rejects tool ids that don't match ^[a-zA-Z0-9_-]+$, and Cursor's plan mode sends
// ids like "functions.AskUserQuestion:1". The remap has to be deterministic: a tool_use and
// its tool_result are paired by id, and both arrive on every subsequent turn.
const ILLEGAL_TOOL_ID_CHARS = /[^a-zA-Z0-9_-]/g;

function sanitizeToolId(id: string): string {
	return id.replace(ILLEGAL_TOOL_ID_CHARS, '_');
}

/** Copy only supported cache policies; never invent a TTL or mutate the client payload. */
function cachePolicy(value: unknown): { cache_control?: CacheControl } {
	const policy = (value as { cache_control?: CacheControl }).cache_control;
	if (policy?.type !== 'ephemeral' || (policy.ttl !== undefined && policy.ttl !== '5m' && policy.ttl !== '1h')) {
		return {};
	}

	return { cache_control: { type: 'ephemeral', ...(policy.ttl === undefined ? {} : { ttl: policy.ttl }) } };
}

function sanitizeToolBlockId(block: ContentBlock): ContentBlock {
	if (block.type === 'tool_use' && block.id) {
		return { ...block, id: sanitizeToolId(block.id) };
	}

	if (block.type === 'tool_result' && block.tool_use_id) {
		return { ...block, tool_use_id: sanitizeToolId(block.tool_use_id) };
	}

	return block;
}

/** Cursor's chat client sends nested functions and does not fail the turn on another tool type. */
function chatTools(tools: OpenAIChatRequest['tools']): Tool[] {
	if (!tools || tools.length === 0) return [];
	const functions: Tool[] = [];
	const passthrough: Tool[] = [];

	for (const tool of tools) {
		const value = tool as unknown as {
			type?: string;
			name?: string;
			description?: string;
			input_schema?: Record<string, unknown>;
			function?: { name?: string; description?: string; parameters?: Record<string, unknown> };
		};
		if (value.type === 'function' && typeof value.function?.name === 'string') {
			functions.push({
				...cachePolicy(tool),
				name: value.function.name,
				description: value.function.description ?? '',
				input_schema: value.function.parameters ?? { type: 'object', properties: {} }
			});
			continue;
		}
		if (typeof value.name === 'string' && value.input_schema && typeof value.input_schema === 'object') {
			passthrough.push({
				...cachePolicy(tool),
				name: value.name,
				description: value.description ?? '',
				input_schema: value.input_schema
			});
		}
	}

	return functions.length > 0 ? functions : passthrough;
}

/** OpenAI's string and function choice are not valid Anthropic tool_choice values. */
function chatToolChoice(choice: OpenAIChatRequest['tool_choice']): ToolChoice | undefined {
	if (!choice) return undefined;
	if (choice === 'none') return undefined;
	if (choice === 'auto') return { type: 'auto' };
	if (choice === 'required') return { type: 'any' };
	if (choice.type === 'function' && choice.function.name) return { type: 'tool', name: choice.function.name };

	return undefined;
}

function convertContent(content: string | OpenAIContentPart[] | ContentBlock[]): string | ContentBlock[] {
	if (typeof content === 'string') {
		return content;
	}

	const blocks: ContentBlock[] = [];

	for (const part of content) {
		// Pass through Anthropic-format blocks directly (Cursor sends these)
		if ((part as ContentBlock).type === 'tool_use' || (part as ContentBlock).type === 'tool_result') {
			blocks.push(sanitizeToolBlockId(part as ContentBlock));
			continue;
		}

		const openaiPart = part as OpenAIContentPart;
		if (openaiPart.type === 'text') {
			if (openaiPart.text && openaiPart.text.trim().length > 0) {
				blocks.push({ type: 'text', text: openaiPart.text, ...cachePolicy(part) });
			}
		} else if (openaiPart.type === 'image_url' && openaiPart.image_url) {
			const url = openaiPart.image_url.url;
			if (url.startsWith('data:')) {
				const match = /^data:([^;]+);base64,(.+)$/.exec(url);
				if (match) {
					blocks.push({
						...cachePolicy(part),
						type: 'image',
						source: {
							type: 'base64',
							media_type: match[1],
							data: match[2]
						}
					});
				}
			} else {
				blocks.push({ type: 'image', source: { type: 'url', url }, ...cachePolicy(part) });
			}
		} else if ((part as ContentBlock).type === 'image' && (part as ContentBlock).source) {
			blocks.push(part as ContentBlock);
		}
	}

	return blocks;
}

export function openaiToAnthropic(request: OpenAIChatRequest, override?: AnthropicModelOverride): AnthropicRequest {
	const messages: AnthropicMessage[] = [];
	let system: string | ContentBlock[] | undefined;

	for (const msg of request.messages) {
		if (msg.role === 'system') {
			const parts = typeof msg.content === 'string' ? undefined : (msg.content ?? []);
			const content = typeof msg.content === 'string' ? msg.content : (parts ?? []).map((p) => p.text ?? '').join('\n');
			if (Array.isArray(system) || parts?.some((part) => cachePolicy(part).cache_control)) {
				const previous = typeof system === 'string' ? [{ type: 'text' as const, text: system }] : (system ?? []);
				const next = parts
					? parts.map((part) => ({ type: 'text' as const, text: part.text ?? '', ...cachePolicy(part) }))
					: [{ type: 'text' as const, text: content }];
				system = [...previous, ...next];
			} else if (system) {
				system = `${system}\n${content}`;
			} else {
				system = content;
			}
		} else if (msg.role === 'assistant') {
			const contentBlocks: ContentBlock[] = [];

			if (msg.content) {
				const convertedContent = convertContent(msg.content);
				if (typeof convertedContent === 'string' && convertedContent.trim().length > 0) {
					contentBlocks.push({ type: 'text', text: convertedContent });
				} else if (Array.isArray(convertedContent)) {
					contentBlocks.push(...convertedContent);
				}
			}

			if (msg.tool_calls && msg.tool_calls.length > 0) {
				for (const toolCall of msg.tool_calls) {
					let input = {};
					try {
						input = JSON.parse(toolCall.function.arguments);
					} catch {
						input = { raw: toolCall.function.arguments };
					}
					contentBlocks.push({
						type: 'tool_use',
						id: sanitizeToolId(toolCall.id),
						name: toolCall.function.name,
						input
					});
				}
			}

			if (contentBlocks.length > 0) {
				messages.push({ role: 'assistant', content: contentBlocks });
			}
		} else if (msg.role === 'tool') {
			const resultContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

			const toolResultContent: ContentBlock[] = [
				{
					type: 'tool_result',
					tool_use_id: sanitizeToolId(msg.tool_call_id ?? ''),
					content: resultContent
				}
			];

			const lastMsg = messages[messages.length - 1];
			if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content)) {
				lastMsg.content.push(...toolResultContent);
			} else {
				messages.push({ role: 'user', content: toolResultContent });
			}
		} else if (msg.role === 'user') {
			const convertedContent = convertContent(msg.content ?? '');

			if (typeof convertedContent === 'string') {
				if (convertedContent.trim().length === 0) continue;
			} else {
				if (convertedContent.length === 0) continue;
			}

			messages.push({ role: 'user', content: convertedContent });
		}
	}

	if (messages.length > 0 && messages[0].role !== 'user') {
		messages.unshift({ role: 'user', content: 'Continue.' });
	}

	let normalized: { model: string; reasoningBudget?: string };

	if (override) {
		normalized = { model: override.model };

		if (override.reasoningBudget && override.reasoningBudget !== 'none') {
			normalized.reasoningBudget = override.reasoningBudget;
		}
	} else {
		normalized = normalizeModelName(request.model);
	}

	const requestedMaxTokens = request.max_tokens ?? request.max_completion_tokens;
	const maxTokens = resolveMaxOutputTokens(
		requestedMaxTokens,
		override?.maxOutputTokens,
		normalized.reasoningBudget ? REASONING_MAX_TOKENS : DEFAULT_MAX_TOKENS
	);
	const maxTokensSource =
		request.max_tokens != null
			? 'max_tokens'
			: request.max_completion_tokens != null
				? 'max_completion_tokens'
				: normalized.reasoningBudget
					? 'thinking-default'
					: 'default';

	logger.log(
		`[OpenAI→Anthropic] "${request.model}" → "${normalized.model}"${normalized.reasoningBudget ? ` (reasoning_budget: ${normalized.reasoningBudget})` : ''} | max_tokens=${maxTokens} max_tokens_source=${maxTokensSource}`
	);

	const result: AnthropicRequest = {
		model: normalized.model,
		messages,
		system,
		max_tokens: maxTokens,
		temperature: request.temperature,
		top_p: request.top_p,
		stream: request.stream,
		stop_sequences: request.stop ? (Array.isArray(request.stop) ? request.stop : [request.stop]) : undefined
	};
	if (
		request.cache_control?.type === 'ephemeral' &&
		(request.cache_control.ttl === undefined || request.cache_control.ttl === '5m' || request.cache_control.ttl === '1h')
	) {
		result.cache_control = { ...request.cache_control };
	}

	// Cursor's Anthropic client sends no tools when the choice is none.
	if (request.tool_choice !== 'none') {
		const tools = chatTools(request.tools);
		if (tools.length > 0) result.tools = tools;
		const toolChoice = chatToolChoice(request.tool_choice);
		if (toolChoice) result.tool_choice = toolChoice;
	}

	if (normalized.reasoningBudget) {
		result.reasoning_budget = normalized.reasoningBudget;
	}

	return result;
}
