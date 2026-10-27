import { logger } from 'src/utils/logger';

import { OpenAIOAuthService } from '../auth/openai/openai-oauth-service';
import { config } from '../config';
import { Settings } from '../database/app-settings';
import { fetchWithHeaderTimeout } from '../security/outbound-request';

import { ResponsesBodyBuilder } from './responses-input-normalizer/build-body';
import { ResponsesModelResolver } from './responses-input-normalizer/resolve-model';
import { ResponsesSseProcessor, StreamDiagnostics, StreamStateFactory } from './responses-stream-mapper';
import { CompletionAccumulator } from './responses-stream-mapper/completion-accumulator';
import { StreamChunkMapper } from './responses-stream-mapper/stream-openai-chunks';

import type { OpenAIChatRequest } from '../types/openai';
import type { RequestContext } from '../types/proxy';

/** Codex `/responses` requires non-empty `instructions` (api_error otherwise). */
const CODEX_INSTRUCTIONS_FALLBACK =
	'You are a coding assistant integrated with the user editor. Follow the conversation and use tools when appropriate.';

const ENV_CHATGPT_INSTRUCTIONS = process.env.CHATGPT_INSTRUCTIONS?.trim();

interface ProxyOpenAiResult {
	response: Response;
	context: RequestContext;
}

export class OpenAiClient {
	static async proxy(body: OpenAIChatRequest, signal?: AbortSignal): Promise<ProxyOpenAiResult> {
		const startTime = Date.now();
		const model = body.model;
		const resolvedModel = ResponsesModelResolver.resolveModel(model);
		const normalizedModel = resolvedModel.model;
		const creds = await OpenAIOAuthService.getValidToken();

		if (!creds?.accessToken) {
			return this.authErrorResult(model, startTime, 'Not authenticated with OpenAI');
		}

		const accountId = creds.accountId;

		if (!accountId) {
			return this.authErrorResult(model, startTime, 'ChatGPT account id missing. Re-login to refresh your ChatGPT token.');
		}

		let response = await this.fetchCodexResponses(body, model, normalizedModel, creds.accessToken, accountId, signal);
		if (response.status === 401 && creds.refreshToken) {
			const refreshed = await OpenAIOAuthService.refreshToken(creds.refreshToken);
			if (refreshed?.accountId) {
				response = await this.fetchCodexResponses(
					body,
					model,
					normalizedModel,
					refreshed.accessToken,
					refreshed.accountId,
					signal
				);
			}
		}

		if (!response.ok) {
			return this.upstreamErrorResult(response, model, startTime);
		}

		return this.successResult(body, response, model, normalizedModel, startTime);
	}

	private static authErrorResult(model: string, startTime: number, message: string): ProxyOpenAiResult {
		const errorResponse = new Response(JSON.stringify({ error: { message, type: 'authentication_error' } }), {
			status: 401,
			headers: { 'Content-Type': 'application/json' }
		});

		return {
			response: errorResponse,
			context: this.errorContext(model, startTime)
		};
	}

	private static async fetchCodexResponses(
		body: OpenAIChatRequest,
		model: string,
		normalizedModel: string,
		accessToken: string,
		accountId: string,
		signal?: AbortSignal
	): Promise<Response> {
		const rawExtraInstruction = Settings.get().extraInstruction;
		const extraInstruction = rawExtraInstruction ?? undefined;
		const buildResult = ResponsesBodyBuilder.buildBody(body, model, {
			extraInstruction,
			envInstructions: ENV_CHATGPT_INSTRUCTIONS,
			instructionsFallback: CODEX_INSTRUCTIONS_FALLBACK
		});
		const requestBody = buildResult.payload;
		const incomingToolCount = Array.isArray(body.tools) ? body.tools.length : 0;

		logger.log(
			`[Codex] upstreamModel=${model} chatMessages=${buildResult.debug.chatMessages} inputField=${buildResult.debug.inputField} codexItems=${buildResult.debug.codexItems} fromBodyInput=${buildResult.debug.fromBodyInput}`
		);

		logger.log(`OpenAI Codex proxy: ${model} → ${normalizedModel} tools=${incomingToolCount} stream=${body.stream ?? false}`);

		return fetchWithHeaderTimeout(
			`${config.openai.codexUrl}/responses`,
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${accessToken}`,
					'chatgpt-account-id': accountId,
					originator: 'codex_cli_rs',
					accept: 'text/event-stream'
				},
				body: JSON.stringify(requestBody)
			},
			signal
		);
	}

	private static async upstreamErrorResult(response: Response, model: string, startTime: number): Promise<ProxyOpenAiResult> {
		const errorText = await response.text();
		logger.error(`ChatGPT Codex upstream error: status=${response.status} bodyBytes=${Buffer.byteLength(errorText, 'utf8')}`);
		const errorMessage = this.parseUpstreamError(response.status, errorText);
		const errorResponse = new Response(JSON.stringify({ error: { message: errorMessage, type: 'api_error' } }), {
			status: response.status,
			headers: { 'Content-Type': 'application/json' }
		});

		return {
			response: errorResponse,
			context: this.errorContext(model, startTime)
		};
	}

	private static parseUpstreamError(status: number, errorText: string): string {
		let errorMessage = `ChatGPT API error (${status})`;

		try {
			const errBody = JSON.parse(errorText) as {
				error?: { message?: string };
				message?: string;
				detail?: string;
			};

			if (errBody.error?.message) {
				errorMessage = errBody.error.message;
			} else if (errBody.message) {
				errorMessage = errBody.message;
			} else if (errBody.detail) {
				errorMessage = errBody.detail;
			}
		} catch {
			if (errorText.trim()) {
				errorMessage = `${errorMessage}: ${errorText.slice(0, 500)}`;
			}
		}

		return errorMessage;
	}

	private static async successResult(
		body: OpenAIChatRequest,
		response: Response,
		model: string,
		normalizedModel: string,
		startTime: number
	): Promise<ProxyOpenAiResult> {
		const stream = body.stream ?? false;
		const state = StreamStateFactory.create(normalizedModel);

		if (stream) {
			const streamResponse = this.streamResponse(response, state);

			return {
				response: streamResponse,
				context: this.openAiContext(model, startTime)
			};
		}

		const bufferedResponse = await this.bufferedResponse(response, state);

		return {
			response: bufferedResponse,
			context: this.openAiContext(model, startTime)
		};
	}

	private static streamResponse(response: Response, state: ReturnType<typeof StreamStateFactory.create>): Response {
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();

		let cancelled = false;
		let finalized = false;
		const encoder = new TextEncoder();
		const streamBody = new ReadableStream({
			async pull(controller) {
				if (cancelled || finalized) return;
				try {
					let done = false;
					let emitted = false;
					while (!done && !emitted && !state.completed) {
						const next = await reader.read();
						done = next.done;
						if (cancelled) return;
						if (!done) {
							for (const result of ResponsesSseProcessor.process(state, decoder.decode(next.value, { stream: true }))) {
								emitted = true;
								controller.enqueue(
									encoder.encode(result.type === 'done' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(result.data)}\n\n`)
								);
							}
						}
					}
					if (!done && !state.completed) return;
					finalized = true;
					if (!state.completed) {
						state.pendingFunctionCalls.clear();
						controller.enqueue(encoder.encode(`data: ${JSON.stringify(StreamChunkMapper.chunk(state, {}, 'length'))}\n\n`));
						controller.enqueue(encoder.encode('data: [DONE]\n\n'));
					}
					controller.close();
				} catch (error) {
					finalized = true;
					if (!cancelled) controller.error(error);
				} finally {
					if (finalized) {
						await reader.cancel().catch(() => {});
						reader.releaseLock();
						StreamDiagnostics.logFinished(state, 'stream');
					}
				}
			},
			cancel(reason) {
				cancelled = true;

				return reader.cancel(reason);
			}
		});

		return new Response(streamBody, {
			status: 200,
			headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }
		});
	}

	private static async bufferedResponse(
		response: Response,
		state: ReturnType<typeof StreamStateFactory.create>
	): Promise<Response> {
		const accumulator = new CompletionAccumulator();
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();

		while (true) {
			const { done, value } = await reader.read();

			if (done) {
				break;
			}

			const text = decoder.decode(value, { stream: true });
			const results = ResponsesSseProcessor.process(state, text);

			accumulator.consume(results);
		}

		const trailing = decoder.decode();
		if (trailing) accumulator.consume(ResponsesSseProcessor.process(state, trailing));
		reader.releaseLock();
		StreamDiagnostics.logFinished(state, 'buffer');

		return new Response(JSON.stringify(accumulator.response(state)), {
			status: 200,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	private static errorContext(model: string, startTime: number): RequestContext {
		return { model, source: 'error', startTime, reverseToolMapping: {}, inputTokens: 0, outputTokens: 0 };
	}

	private static openAiContext(model: string, startTime: number): RequestContext {
		return { model, source: 'openai', startTime, reverseToolMapping: {}, inputTokens: 0, outputTokens: 0 };
	}
}
