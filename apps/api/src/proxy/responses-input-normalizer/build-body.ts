import { CodexInputUtils } from 'src/proxy/codex-input-utils';

import { ResponsesInputShape } from './input-shape';
import { ResponsesInputText } from './input-text';
import { ResponsesModelResolver } from './resolve-model';

import type { BuildResponsesBodyOptions, BuildResponsesBodyResult } from './types';
import type { OpenAIChatRequest } from 'src/types/openai';

export class ResponsesBodyBuilder {
	public static buildBody(
		body: OpenAIChatRequest,
		requestedModel: string,
		options: BuildResponsesBodyOptions
	): BuildResponsesBodyResult {
		const messages = CodexInputUtils.coerceMessages(body);
		const resolvedModel = ResponsesModelResolver.resolveModel(requestedModel);
		let reasoningEffort = body.reasoning?.effort ?? body.reasoning_effort ?? resolvedModel.reasoningEffort;

		// Astra requires at least low reasoning, including when Cursor requests none.
		if (resolvedModel.model === 'gpt-6-astra' && (reasoningEffort === 'none' || reasoningEffort === 'minimal')) {
			reasoningEffort = 'low';
		}

		const expandedInput = CodexInputUtils.expandInput(body.input);
		const usedExpandedInput = expandedInput !== null;

		let input: Record<string, unknown>[];

		if (expandedInput) {
			input = expandedInput;
		} else {
			input = CodexInputUtils.buildFromMessages(messages);
		}

		let finalInput = ResponsesInputShape.filterOrphans(input);

		if (!usedExpandedInput) {
			finalInput = ResponsesInputShape.patchLastUser(finalInput, messages);
		}

		if (!ResponsesInputText.hasActionableUserContent(finalInput)) {
			const fallbackText = ResponsesInputText.buildFallbackText(messages);

			if (finalInput.length === 0) {
				finalInput = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: fallbackText }] }];
			} else {
				finalInput = [...finalInput, { type: 'message', role: 'user', content: [{ type: 'input_text', text: fallbackText }] }];
			}
		}

		if (finalInput.length === 0) {
			finalInput = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello.' }] }];
		}

		finalInput = CodexInputUtils.normalizeAssistantText(finalInput);

		const rawTools = Array.isArray(body.tools) ? body.tools : [];
		const payload: Record<string, unknown> = {
			model: resolvedModel.model,
			input: finalInput,
			stream: true,
			store: false
		};

		if (body.service_tier) {
			payload.service_tier = body.service_tier;
		}
		if (body.prompt_cache_key?.trim()) {
			payload.prompt_cache_key = body.prompt_cache_key.trim();
		}

		if (options.extraInstruction?.trim()) {
			payload.instructions = options.extraInstruction.trim();
		} else if (options.envInstructions?.trim()) {
			payload.instructions = options.envInstructions.trim();
		} else {
			payload.instructions = options.instructionsFallback;
		}

		if (reasoningEffort) {
			payload.reasoning = { effort: reasoningEffort };
		}

		const tools = rawTools.flatMap((tool) => {
			const converted = this.toResponsesTool(tool);

			return converted ? [converted] : [];
		});

		if (tools.length > 0) {
			payload.tools = tools;
			const toolChoice = this.mapChoice(body.tool_choice);
			if (toolChoice !== undefined) payload.tool_choice = toolChoice;
		}

		const debug = {
			chatMessages: messages.length,
			inputField: Array.isArray(body.input) ? body.input.length : 0,
			codexItems: input.length,
			fromBodyInput: usedExpandedInput
		};

		return { payload, debug };
	}

	/**
	 * Cursor's Responses client sends flat function tools and drops every other type.
	 * Nested Chat tools are flattened so Codex sees `tools[0].name`.
	 */
	private static toResponsesTool(tool: unknown): Record<string, unknown> | undefined {
		const record = (tool ?? {}) as Record<string, unknown>;
		const fn = record.function as Record<string, unknown> | undefined;

		if (record.type === 'function' && typeof record.name === 'string' && !fn) return record;
		if (record.type === 'function' && fn && typeof fn.name === 'string') {
			const flattened: Record<string, unknown> = {
				type: 'function',
				name: fn.name,
				parameters: fn.parameters ?? { type: 'object', properties: {} }
			};

			if (typeof fn.description === 'string') {
				flattened.description = fn.description;
			}

			if (typeof fn.strict === 'boolean') {
				flattened.strict = fn.strict;
			}

			return flattened;
		}

		return undefined;
	}

	private static mapChoice(
		toolChoice: OpenAIChatRequest['tool_choice'] | undefined
	): string | Record<string, unknown> | undefined {
		if (toolChoice === undefined || toolChoice === null) {
			return undefined;
		}

		if (typeof toolChoice === 'string') {
			return toolChoice;
		}

		const toolChoiceRecord = toolChoice as {
			type?: string;
			function?: { name?: string };
			name?: string;
		};

		if (toolChoiceRecord.type === 'function') {
			if (toolChoiceRecord.function?.name) {
				return { type: 'function', name: toolChoiceRecord.function.name };
			}

			if (toolChoiceRecord.name) {
				return { type: 'function', name: toolChoiceRecord.name };
			}
		}

		return { ...toolChoiceRecord };
	}
}
