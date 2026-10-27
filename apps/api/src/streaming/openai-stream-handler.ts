import { logger } from 'src/utils/logger';

import { AnthropicToOpenai } from '../adapter/anthropic-to-openai';
import { ToolNormalizer } from '../tools/normalizer';
import { type ToolUseBlock, type StreamResult, type RequestContext } from '../types/proxy';

import type { AnthropicStopReason, AnthropicStreamEvent } from '../types/anthropic-stream';

interface StreamHandlerOptions {
	reader: ReadableStreamDefaultReader<Uint8Array>;
	streamId: string;
	modelName: string;
	context: RequestContext;
}

interface ActiveToolCall {
	id: string;
	name: string;
	inputJson: string;
	index: number;
	outputIndex: number;
}

interface StreamUsage {
	input_tokens: number;
	output_tokens: number;
	cache_read_input_tokens: number;
	cache_creation_input_tokens: number;
}

const MAX_SSE_EVENT_BYTES = Number(process.env.PROVIDER_MAX_SSE_EVENT_BYTES) || 1024 * 1024;
const MAX_TOOL_ARGUMENT_BYTES = Number(process.env.PROVIDER_MAX_TOOL_ARGUMENT_BYTES) || 4 * 1024 * 1024;

export class OpenAIStreamHandler {
	static createStreamResponse(response: Response, streamId: string, modelName: string, context: RequestContext): StreamResult {
		const headers: Record<string, string> = {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no',
			'x-request-id': `req_${streamId}`,
			'openai-processing-ms': '0',
			'openai-version': '2020-10-01'
		};

		const reader = response.body?.getReader();
		if (!reader) {
			throw new Error('No response body');
		}

		const stream = this.createStream({ reader, streamId, modelName, context });

		return { stream, headers };
	}

	private static createStream(options: StreamHandlerOptions): ReadableStream {
		const { reader, streamId, modelName, context } = options;

		let cancelled = false;
		let resumePull: (() => void) | undefined;
		let pullRequested = false;
		const activeToolCalls = new Map<number, ActiveToolCall>();

		const describeOpenTool = (): string =>
			[...activeToolCalls.values()]
				.map((tool) => `tool=${tool.name} toolId=${tool.id} argsLength=${tool.inputJson.length}`)
				.join('; ') || 'tool=none';

		return new ReadableStream(
			{
				async start(controller) {
					const decoder = new TextDecoder();
					let buffer = '';
					let sentStart = false;
					let toolCallIndex = 0;
					let completedToolCalls = 0;
					let finalized = false;
					let stopReason: AnthropicStopReason | null = null;
					let finalUsage: StreamUsage | null = null;
					let salvageFailed = false;

					const safeEnqueue = (data: Uint8Array) => {
						try {
							if (!cancelled) {
								controller.enqueue(data);
							}
						} catch {
							cancelled = true;
						}
					};

					const flushToolCall = (index: number, mode: 'complete' | 'salvage'): boolean => {
						const currentToolCall = activeToolCalls.get(index);
						if (!currentToolCall) {
							return false;
						}

						if (mode === 'salvage' && !currentToolCall.inputJson) {
							logger.error(`Incomplete tool call ${describeOpenTool()}`);
							activeToolCalls.delete(index);

							return false;
						}

						let finalJson = currentToolCall.inputJson || '{}';

						try {
							const parsedArgs = JSON.parse(finalJson);
							const toolUse: ToolUseBlock = {
								type: 'tool_use',
								id: currentToolCall.id,
								name: currentToolCall.name,
								input: parsedArgs
							};

							const normalized = ToolNormalizer.normalize(toolUse);
							if (ToolNormalizer.hasChanged(toolUse, normalized)) {
								finalJson = JSON.stringify(normalized.input);
							}
						} catch {
							logger.error(`Failed to parse tool args for ${currentToolCall.name}`);

							salvageFailed = true;
							activeToolCalls.delete(index);

							return false;
						}

						safeEnqueue(
							new TextEncoder().encode(
								AnthropicToOpenai.toolCallChunk(
									streamId,
									modelName,
									currentToolCall.outputIndex,
									undefined,
									undefined,
									finalJson,
									null
								)
							)
						);

						completedToolCalls++;
						activeToolCalls.delete(index);

						return true;
					};

					const mapFinishReason = (unexpectedEof: boolean): 'stop' | 'length' | 'tool_calls' => {
						if (unexpectedEof || salvageFailed || stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded') {
							return 'length';
						}

						if (completedToolCalls > 0) {
							return 'tool_calls';
						}

						return 'stop';
					};

					const finalizeStream = (unexpectedEof: boolean) => {
						if (finalized || cancelled) {
							return;
						}

						finalized = true;

						logger.log(
							`Stream stop_reason=${stopReason ?? 'none'} unexpectedEof=${unexpectedEof} completedToolCalls=${toolCallIndex}`
						);

						if (activeToolCalls.size > 0) {
							logger.error(`Incomplete stream with open tool call ${describeOpenTool()}`);
							salvageFailed = true;
							activeToolCalls.clear();
						}

						const finishReason = mapFinishReason(unexpectedEof);

						safeEnqueue(new TextEncoder().encode(AnthropicToOpenai.streamChunk(streamId, modelName, undefined, finishReason)));

						if (finalUsage) {
							safeEnqueue(
								new TextEncoder().encode(
									AnthropicToOpenai.streamChunk(streamId, modelName, undefined, undefined, {
										prompt_tokens: finalUsage.input_tokens,
										completion_tokens: finalUsage.output_tokens,
										total_tokens: finalUsage.input_tokens + finalUsage.output_tokens
									})
								)
							);
						}

						safeEnqueue(new TextEncoder().encode('data: [DONE]\n\n'));
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
							if (done) {
								finalizeStream(true);
								break;
							}

							buffer += decoder.decode(value, { stream: true });
							if (Buffer.byteLength(buffer, 'utf8') > MAX_SSE_EVENT_BYTES && !buffer.includes('\n')) {
								throw new Error(`Claude SSE event exceeded ${MAX_SSE_EVENT_BYTES} bytes`);
							}
							const lines = buffer.split('\n');
							buffer = lines.pop() ?? '';

							for (const line of lines) {
								if (cancelled) break;
								if (finalized || !line.startsWith('data: ')) continue;

								const data = line.slice(6);
								if (data === '[DONE]') {
									finalizeStream(false);
									continue;
								}

								try {
									const event = JSON.parse(data) as AnthropicStreamEvent;

									if (event.type === 'message_start' && !sentStart) {
										safeEnqueue(new TextEncoder().encode(AnthropicToOpenai.streamStart(streamId, modelName)));
										sentStart = true;
									}

									if (event.type === 'content_block_start') {
										if (!sentStart) {
											safeEnqueue(new TextEncoder().encode(AnthropicToOpenai.streamStart(streamId, modelName)));
											sentStart = true;
										}

										const block = event.content_block;

										if (block?.type === 'tool_use') {
											const originalName = context.reverseToolMapping[block.name] ?? block.name;

											const outputIndex = toolCallIndex++;
											activeToolCalls.set(event.index, {
												id: block.id,
												name: originalName,
												inputJson: '',
												index: event.index,
												outputIndex
											});

											safeEnqueue(
												new TextEncoder().encode(
													AnthropicToOpenai.toolCallChunk(
														streamId,
														modelName,
														outputIndex,
														block.id,
														originalName,
														undefined,
														null
													)
												)
											);
										}
									}

									if (event.type === 'content_block_stop' && activeToolCalls.has(event.index)) {
										flushToolCall(event.index, 'complete');
									}

									if (
										event.type === 'content_block_delta' &&
										activeToolCalls.has(event.index) &&
										event.delta?.type === 'input_json_delta' &&
										activeToolCalls.has(event.index)
									) {
										const tool = activeToolCalls.get(event.index)!;
										const fragment = event.delta.partial_json ?? '';
										if (
											Buffer.byteLength(tool.inputJson, 'utf8') + Buffer.byteLength(fragment, 'utf8') >
											MAX_TOOL_ARGUMENT_BYTES
										) {
											throw new Error(`Claude tool arguments exceeded ${MAX_TOOL_ARGUMENT_BYTES} bytes`);
										}
										tool.inputJson += fragment;
										continue;
									}

									if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta?.text) {
										if (!sentStart) {
											safeEnqueue(new TextEncoder().encode(AnthropicToOpenai.streamStart(streamId, modelName)));
											sentStart = true;
										}

										safeEnqueue(new TextEncoder().encode(AnthropicToOpenai.streamChunk(streamId, modelName, event.delta.text)));
									}

									if (event.type === 'message_start' && event.message?.usage) {
										const usage = event.message.usage;
										const cacheRead = usage.cache_read_input_tokens ?? 0;
										const cacheCreate = usage.cache_creation_input_tokens ?? 0;
										const regularInput = usage.input_tokens ?? 0;

										finalUsage = {
											input_tokens: regularInput + cacheCreate + cacheRead,
											output_tokens: usage.output_tokens ?? 0,
											cache_read_input_tokens: cacheRead,
											cache_creation_input_tokens: cacheCreate
										};
									}

									if (event.type === 'message_delta') {
										if (event.delta?.stop_reason) {
											stopReason = event.delta.stop_reason;
										}

										if (event.usage && finalUsage) {
											finalUsage.output_tokens = event.usage.output_tokens ?? 0;
										}
									}

									if (event.type === 'message_stop') {
										if (stopReason === 'tool_use') {
											for (const index of activeToolCalls.keys()) {
												if (!flushToolCall(index, 'salvage')) salvageFailed = true;
											}
										}

										finalizeStream(false);
									}
								} catch (parseError) {
									if (!cancelled) {
										logger.error(`Failed to parse stream event: ${String(parseError)}`);
									}
								}
							}
						}
					} catch (streamError) {
						if (!cancelled) {
							logger.error(`Stream processing failed: ${String(streamError)}`);

							const errorStr = String(streamError);
							if (errorStr.includes('illegal') || errorStr.includes('invalid') || errorStr.includes('argument')) {
								logger.rareError(`Stream error: ${errorStr}`, {
									error: streamError,
									streamId: options.streamId,
									model: options.modelName
								});
							}

							try {
								controller.error(streamError);
							} catch {
								// Controller already closed
							}
						}
					} finally {
						try {
							if (!cancelled) reader.cancel().catch(() => {});
						} catch {
							// Reader already released
						}

						try {
							if (!cancelled) controller.close();
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
					logger.error(`Downstream cancelled stream id=${streamId} reason=${String(reason)} ${describeOpenTool()}`);
					reader.cancel(reason).catch(() => {});
				}
			},
			new CountQueuingStrategy({ highWaterMark: 64 })
		);
	}
}
