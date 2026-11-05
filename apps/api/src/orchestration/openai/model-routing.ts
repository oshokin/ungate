import { openaiToAnthropic } from 'src/adapter/openai-to-anthropic';
import { resolveMaxOutputTokens } from 'src/proxy/output-tokens';
import { DEFAULT_MAX_TOKENS } from 'src/proxy/token-budgets';

import type { ModelMappingConfig } from '@ungate/shared';
import type { OpenAIChatRequest } from 'src/types/openai';

export class CompletionModelRouting {
	static shouldRouteMiniMax(resolved: ModelMappingConfig | null, _requestedModel: string): boolean {
		return resolved?.provider === 'minimax';
	}

	static buildMiniMaxBody(openaiBody: OpenAIChatRequest, resolved: ModelMappingConfig | null): OpenAIChatRequest {
		if (resolved?.provider === 'minimax') {
			return {
				...openaiBody,
				model: resolved.upstreamModel,
				max_completion_tokens: resolveMaxOutputTokens(
					openaiBody.max_completion_tokens ?? openaiBody.max_tokens,
					resolved.maxOutputTokens,
					DEFAULT_MAX_TOKENS
				)
			};
		}

		return openaiBody;
	}

	static isOpenAiMapped(resolved: ModelMappingConfig | null): resolved is ModelMappingConfig {
		if (!resolved) {
			return false;
		}

		if (String(resolved.provider) !== 'openai') {
			return false;
		}

		return true;
	}

	static buildOpenAiUpstreamBody(openaiBody: OpenAIChatRequest, resolved: ModelMappingConfig): OpenAIChatRequest {
		const withModel: OpenAIChatRequest = {
			...openaiBody,
			model: resolved.upstreamModel
		};
		const withServiceTier: OpenAIChatRequest = resolved.serviceTier
			? {
					...withModel,
					service_tier: resolved.serviceTier
				}
			: withModel;

		if (resolved.reasoningBudget && openaiBody.reasoning?.effort === undefined && openaiBody.reasoning_effort === undefined) {
			const withReasoning: OpenAIChatRequest = {
				...withServiceTier,
				reasoning: { effort: resolved.reasoningBudget }
			};

			return withReasoning;
		}

		return withServiceTier;
	}

	static toAnthropicRequest(
		openaiBody: OpenAIChatRequest,
		resolved: ModelMappingConfig | null
	): ReturnType<typeof openaiToAnthropic> {
		if (resolved?.provider === 'claude') {
			return openaiToAnthropic(openaiBody, {
				model: resolved.upstreamModel,
				reasoningBudget: resolved.reasoningBudget,
				maxOutputTokens: resolved.maxOutputTokens
			});
		}

		return openaiToAnthropic(openaiBody);
	}
}
