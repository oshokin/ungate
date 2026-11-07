import { MILLISECONDS_PER_SECOND } from '@ungate/shared';
import { logger } from 'src/utils/logger';

/** Characters of tool arguments written to the stream diagnostic log. */
const LOGGED_TOOL_ARGUMENT_CHARS = 200;

import { ToolTranslator } from '../tools/translator';

import type { ContentBlock, AnthropicResponse } from '../types';
import type {
	ChatCompletionUsage,
	OpenAIChatResponse,
	OpenAIStreamChunkToolCall,
	OpenAIStreamChunk,
	OpenAIToolCall
} from '../types/openai';

export class AnthropicToOpenai {
	static convertUsage(usage?: {
		input_tokens?: number;
		output_tokens?: number;
		cache_creation_input_tokens?: number;
		cache_read_input_tokens?: number;
	}): ChatCompletionUsage {
		const promptTokens =
			(usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0);
		const completionTokens = usage?.output_tokens ?? 0;

		return {
			prompt_tokens: promptTokens,
			completion_tokens: completionTokens,
			total_tokens: promptTokens + completionTokens,
			...(usage?.cache_read_input_tokens !== undefined
				? { prompt_tokens_details: { cached_tokens: usage.cache_read_input_tokens } }
				: {})
		};
	}

	static convert(
		anthropicResponse: AnthropicResponse,
		model: string,
		reverseToolMapping: Record<string, string> = {}
	): OpenAIChatResponse {
		let content =
			anthropicResponse.content
				?.filter((block: ContentBlock) => block.type === 'text')
				.map((block: ContentBlock) => (block.type === 'text' ? block.text : ''))
				.join('') ?? '';
		const toolCalls: OpenAIToolCall[] =
			anthropicResponse.content
				?.filter((block: ContentBlock) => block.type === 'tool_use')
				.map((block: ContentBlock) => {
					const id = block.id ?? `call_${Date.now()}`;
					const name = block.name ?? 'unknown';

					return {
						id,
						type: 'function' as const,
						function: {
							name: reverseToolMapping[name] ?? name,
							arguments: JSON.stringify(block.input ?? {})
						}
					};
				}) ?? [];

		if (ToolTranslator.needsTranslation(content)) {
			content = ToolTranslator.translate(content);
		}

		const stopReason = anthropicResponse.stop_reason;
		const finishReason =
			toolCalls.length > 0 || stopReason === 'tool_use'
				? 'tool_calls'
				: stopReason === 'end_turn' || stopReason === null
					? 'stop'
					: stopReason === 'max_tokens'
						? 'length'
						: 'stop';
		const message: OpenAIChatResponse['choices'][number]['message'] = {
			role: 'assistant',
			content: content || null
		};
		if (toolCalls.length > 0) message.tool_calls = toolCalls;

		const result: OpenAIChatResponse = {
			id: `chatcmpl-${anthropicResponse.id ?? Date.now()}`,
			object: 'chat.completion',
			created: Math.floor(Date.now() / MILLISECONDS_PER_SECOND),
			model,
			choices: [{ index: 0, message, finish_reason: finishReason }],
			usage: this.convertUsage(anthropicResponse.usage)
		};

		return result;
	}

	static streamStart(id: string, model: string): string {
		const chunk: OpenAIStreamChunk = {
			id: `chatcmpl-${id}`,
			object: 'chat.completion.chunk',
			created: Math.floor(Date.now() / MILLISECONDS_PER_SECOND),
			model,
			choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
		};

		return `data: ${JSON.stringify(chunk)}\n\n`;
	}

	static streamChunk(
		id: string,
		model: string,
		content?: string,
		finishReason?: 'stop' | 'length' | 'tool_calls' | null,
		usage?: ChatCompletionUsage | null
	): string {
		const chunk: {
			id: string;
			object: string;
			created: number;
			model: string;
			choices: { index: number; delta: { content?: string }; finish_reason: string | null }[];
			usage?: ChatCompletionUsage | null;
		} = {
			id: `chatcmpl-${id}`,
			object: 'chat.completion.chunk',
			created: Math.floor(Date.now() / MILLISECONDS_PER_SECOND),
			model,
			choices:
				usage === undefined
					? [{ index: 0, delta: content !== undefined ? { content } : {}, finish_reason: finishReason ?? null }]
					: []
		};

		if (usage !== undefined) {
			chunk.usage = usage;
		}

		return `data: ${JSON.stringify(chunk)}\n\n`;
	}

	// OpenAI streams tool calls in multiple chunks:
	// First chunk: id, type="function", function.name, function.arguments=""
	// Subsequent: only function.arguments with fragments
	static toolCallChunk(
		id: string,
		model: string,
		toolCallIndex: number,
		toolCallId?: string,
		functionName?: string,
		functionArgs?: string,
		finishReason?: 'tool_calls' | null
	): string {
		const toolCall: OpenAIStreamChunkToolCall = { index: toolCallIndex };

		if (toolCallId) {
			toolCall.id = toolCallId;
			toolCall.type = 'function';
			toolCall.function = { name: functionName ?? '', arguments: '' };
		} else if (functionArgs !== undefined) {
			toolCall.function = { arguments: functionArgs };
		}

		const chunk: OpenAIStreamChunk = {
			id: `chatcmpl-${id}`,
			object: 'chat.completion.chunk',
			created: Math.floor(Date.now() / MILLISECONDS_PER_SECOND),
			model,
			choices: [{ index: 0, delta: { tool_calls: [toolCall] }, finish_reason: finishReason ?? null }]
		};

		logger.log(
			`[EMIT TOOL CALL CHUNK] index=${toolCallIndex}, id=${toolCallId ?? '-'}, name=${functionName ?? '-'}, args=${functionArgs ? functionArgs.slice(0, LOGGED_TOOL_ARGUMENT_CHARS) : '-'}`
		);

		return `data: ${JSON.stringify(chunk)}\n\n`;
	}
}
