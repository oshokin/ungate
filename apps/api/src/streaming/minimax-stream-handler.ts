import { MILLISECONDS_PER_SECOND, OPENAI_API_VERSION } from '@ungate/shared';
import { logger } from 'src/utils/logger';

import {
	DEFAULT_MAX_SSE_EVENT_BYTES,
	DEFAULT_MAX_TOOL_ARGUMENT_BYTES,
	providerByteLimit,
	SSE_QUEUE_HIGH_WATER_MARK
} from './stream-limits';

import type { ChatCompletionUsage } from '../types/openai';
import type { RequestContext, StreamResult } from '../types/proxy';

type MiniMaxStreamState = 'content' | 'thinking';

interface MiniMaxToolCallDelta {
	index: number;
	id?: string;
	type?: string;
	function?: {
		name?: string;
		arguments?: string;
	};
}

interface MiniMaxStreamEvent {
	choices?: {
		delta?: {
			content?: string | null;
			role?: string;
			tool_calls?: MiniMaxToolCallDelta[];
		};
		finish_reason?: string | null;
	}[];
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
		prompt_tokens_details?: ChatCompletionUsage['prompt_tokens_details'];
	};
}

/** Opening tag MiniMax uses for reasoning text inside the content stream. */
const THINK_OPEN = '<think>';
/** Closing tag MiniMax uses for reasoning text inside the content stream. */
const THINK_CLOSE = '</think>';

function buildChunk(
	streamId: string,
	modelName: string,
	delta: Record<string, unknown>,
	finishReason: string | null = null
): string {
	return `data: ${JSON.stringify({
		id: `chatcmpl-${streamId}`,
		object: 'chat.completion.chunk',
		created: Math.floor(Date.now() / MILLISECONDS_PER_SECOND),
		model: modelName,
		choices: [{ index: 0, delta, finish_reason: finishReason }]
	})}\n\n`;
}

function buildUsageChunk(streamId: string, modelName: string, usage: ChatCompletionUsage): string {
	return `data: ${JSON.stringify({
		id: `chatcmpl-${streamId}`,
		object: 'chat.completion.chunk',
		created: Math.floor(Date.now() / MILLISECONDS_PER_SECOND),
		model: modelName,
		choices: [],
		usage
	})}\n\n`;
}

function getPartialTagSuffix(text: string): string {
	const candidates = [THINK_OPEN, THINK_CLOSE];

	for (let length = Math.min(text.length, THINK_CLOSE.length); length > 0; length--) {
		const suffix = text.slice(-length);
		if (candidates.some((tag) => tag.startsWith(suffix))) {
			return suffix;
		}
	}

	return '';
}

function parseMiniMaxDelta(
	text: string,
	state: MiniMaxStreamState,
	pendingTag: string
): {
	segments: { kind: 'content' | 'reasoning'; text: string }[];
	state: MiniMaxStreamState;
	pendingTag: string;
} {
	const segments: { kind: 'content' | 'reasoning'; text: string }[] = [];
	let buffer = pendingTag + text;
	let nextState = state;

	while (buffer.length > 0) {
		if (nextState === 'content') {
			const openIndex = buffer.indexOf(THINK_OPEN);

			if (openIndex === -1) {
				const pending = getPartialTagSuffix(buffer);
				const safeText = pending ? buffer.slice(0, -pending.length) : buffer;
				if (safeText) {
					segments.push({ kind: 'content', text: safeText });
				}

				return { segments, state: nextState, pendingTag: pending };
			}

			if (openIndex > 0) {
				segments.push({ kind: 'content', text: buffer.slice(0, openIndex) });
			}

			buffer = buffer.slice(openIndex + THINK_OPEN.length);
			nextState = 'thinking';
			continue;
		}

		const closeIndex = buffer.indexOf(THINK_CLOSE);

		if (closeIndex === -1) {
			const pending = getPartialTagSuffix(buffer);
			const safeText = pending ? buffer.slice(0, -pending.length) : buffer;
			if (safeText) {
				segments.push({ kind: 'reasoning', text: safeText });
			}

			return { segments, state: nextState, pendingTag: pending };
		}

		if (closeIndex > 0) {
			segments.push({ kind: 'reasoning', text: buffer.slice(0, closeIndex) });
		}

		buffer = buffer.slice(closeIndex + THINK_CLOSE.length);
		nextState = 'content';
	}

	return { segments, state: nextState, pendingTag: '' };
}

export class MiniMaxStreamHandler {
	static createStreamResponse(response: Response, streamId: string, modelName: string, context: RequestContext): StreamResult {
		const headers: Record<string, string> = {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no',
			'x-request-id': `req_${streamId}`,
			'openai-processing-ms': '0',
			'openai-version': OPENAI_API_VERSION
		};

		const reader = response.body?.getReader();
		if (!reader) {
			throw new Error('No response body');
		}

		return {
			stream: this.createStream({ reader, streamId, modelName, context }),
			headers
		};
	}

	private static createStream(options: {
		reader: ReadableStreamDefaultReader<Uint8Array>;
		streamId: string;
		modelName: string;
		context: RequestContext;
	}): ReadableStream {
		const { reader, streamId, modelName, context } = options;
		let cancelled = false;
		let resumePull: (() => void) | undefined;
		let pullRequested = false;
		const maxSseEventBytes = providerByteLimit(process.env.PROVIDER_MAX_SSE_EVENT_BYTES, DEFAULT_MAX_SSE_EVENT_BYTES);
		const maxToolArgumentBytes = providerByteLimit(process.env.PROVIDER_MAX_TOOL_ARGUMENT_BYTES, DEFAULT_MAX_TOOL_ARGUMENT_BYTES);

		return new ReadableStream(
			{
				async start(controller) {
					const decoder = new TextDecoder();
					const encoder = new TextEncoder();
					let sseBuffer = '';
					let sentStart = false;
					let finishReason: 'stop' | 'length' | 'tool_calls' | null = null;
					let sawDone = false;
					const pendingTools = new Map<number, MiniMaxToolCallDelta>();
					let usage: ChatCompletionUsage | undefined;
					let streamState: MiniMaxStreamState = 'content';
					let pendingTag = '';

					const safeEnqueue = (chunk: string) => {
						try {
							if (!cancelled) {
								controller.enqueue(encoder.encode(chunk));
							}
						} catch {
							cancelled = true;
						}
					};

					try {
						while (true) {
							if (cancelled) break;
							if ((controller.desiredSize ?? 1) <= 0) {
								if (pullRequested) {
									pullRequested = false;
								} else {
									await new Promise<void>((resolve) => {
										resumePull = resolve;
									});
									resumePull = undefined;
								}
								if (cancelled) break;
							}

							const { done, value } = await reader.read();
							if (cancelled) break;

							sseBuffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
							// Process the final event even when EOF is not preceded by a newline.
							if (done && sseBuffer) sseBuffer += '\n';
							if (Buffer.byteLength(sseBuffer, 'utf8') > maxSseEventBytes && !sseBuffer.includes('\n')) {
								throw new Error(`MiniMax SSE event exceeded ${maxSseEventBytes} bytes`);
							}
							const lines = sseBuffer.split('\n');
							sseBuffer = lines.pop() ?? '';

							for (const rawLine of lines) {
								const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
								if (Buffer.byteLength(line, 'utf8') > maxSseEventBytes) {
									throw new Error(`MiniMax SSE event exceeded ${maxSseEventBytes} bytes`);
								}
								if (cancelled || !line.startsWith('data: ')) continue;

								const data = line.slice(6);
								if (data === '[DONE]') {
									sawDone = true;
									continue;
								}

								try {
									const event = JSON.parse(data) as MiniMaxStreamEvent;
									const choice = event.choices?.[0];

									if (!sentStart) {
										safeEnqueue(buildChunk(streamId, modelName, { role: 'assistant' }));
										sentStart = true;
									}

									if (choice?.finish_reason) {
										finishReason = choice.finish_reason as 'stop' | 'length' | 'tool_calls';
									}

									if (event.usage?.completion_tokens !== undefined) {
										const promptTokens = event.usage.prompt_tokens ?? context.inputTokens ?? 0;
										const completionTokens = event.usage.completion_tokens;
										const totalTokens = event.usage.total_tokens ?? promptTokens + completionTokens;
										usage = {
											prompt_tokens: promptTokens,
											completion_tokens: completionTokens,
											total_tokens: totalTokens,
											...(event.usage.prompt_tokens_details !== undefined
												? {
														prompt_tokens_details: event.usage.prompt_tokens_details
													}
												: {})
										};
									}

									const toolCallDeltas = choice?.delta?.tool_calls;
									if (toolCallDeltas && toolCallDeltas.length > 0) {
										for (const tc of toolCallDeltas) {
											const previous = pendingTools.get(tc.index);
											const argumentsValue = (previous?.function?.arguments ?? '') + (tc.function?.arguments ?? '');
											if (Buffer.byteLength(argumentsValue, 'utf8') > maxToolArgumentBytes) {
												throw new Error(`MiniMax tool arguments exceeded ${maxToolArgumentBytes} bytes`);
											}
											pendingTools.set(tc.index, {
												index: tc.index,
												id: tc.id ?? previous?.id,
												type: tc.type ?? previous?.type,
												function: {
													name: tc.function?.name ?? previous?.function?.name,
													arguments: argumentsValue
												}
											});
										}
										continue;
									}

									const deltaText = choice?.delta?.content;
									if (!deltaText) {
										continue;
									}

									const parsed = parseMiniMaxDelta(deltaText, streamState, pendingTag);
									streamState = parsed.state;
									pendingTag = parsed.pendingTag;

									for (const segment of parsed.segments) {
										if (!segment.text) continue;

										if (segment.kind === 'reasoning') {
											safeEnqueue(
												buildChunk(streamId, modelName, {
													reasoning_content: segment.text
												})
											);
											continue;
										}

										safeEnqueue(
											buildChunk(streamId, modelName, {
												content: segment.text
											})
										);
									}
								} catch (error) {
									logger.error(`MiniMax stream parse error: ${String(error)}`);
									throw error;
								}
							}
							if (done) break;
						}

						if (pendingTag) {
							if (streamState === 'thinking') {
								safeEnqueue(
									buildChunk(streamId, modelName, {
										reasoning_content: pendingTag
									})
								);
							} else {
								safeEnqueue(buildChunk(streamId, modelName, { content: pendingTag }));
							}
						}

						let finalReason = finishReason ?? (sawDone && pendingTools.size === 0 ? 'stop' : 'length');
						if (pendingTools.size > 0) {
							try {
								if (finishReason !== 'tool_calls') throw new Error('Unfinished tool stream');
								for (const tool of pendingTools.values()) {
									if (!tool.id || !tool.function?.name) throw new Error('Incomplete tool identity');
									JSON.parse(tool.function.arguments ?? '');
								}
								safeEnqueue(
									buildChunk(streamId, modelName, {
										tool_calls: [...pendingTools.values()]
									})
								);
							} catch {
								finalReason = 'length';
							}
						}
						safeEnqueue(buildChunk(streamId, modelName, {}, finalReason));

						if (usage) {
							safeEnqueue(buildUsageChunk(streamId, modelName, usage));
						}

						safeEnqueue('data: [DONE]\n\n');
					} catch (error) {
						if (!cancelled) {
							logger.error(`MiniMax stream processing failed: ${String(error)}`);
							safeEnqueue(buildChunk(streamId, modelName, {}, 'length'));
							safeEnqueue('data: [DONE]\n\n');
						}
					} finally {
						if (!sawDone && !cancelled) {
							try {
								reader.cancel().catch(() => {});
							} catch {
								// Reader already released
							}
						}

						try {
							if (!cancelled) {
								controller.close();
							}
						} catch {
							// Controller already closed
						}
					}
				},
				pull() {
					if (resumePull) resumePull();
					else pullRequested = true;
				},
				cancel(reason) {
					cancelled = true;
					resumePull?.();
					reader.cancel(reason).catch(() => {});
				}
			},
			new CountQueuingStrategy({ highWaterMark: SSE_QUEUE_HIGH_WATER_MARK })
		);
	}
}
