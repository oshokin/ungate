import { DEFAULT_MAX_SSE_EVENT_BYTES, DEFAULT_MAX_TOOL_ARGUMENT_BYTES, providerByteLimit } from 'src/streaming/stream-limits';

import type { ChatCompletionUsage } from 'src/types/openai';

export interface StreamProcessResult {
	type: 'chunk' | 'done';
	data?: Record<string, unknown>;
}

export interface PendingFunctionCallState {
	callId: string;
	openAiIndex: number;
	argsBuffer: string;
	deferred: boolean;
	name?: string;
}

export interface StreamState {
	usage?: ChatCompletionUsage;
	buffer: string;
	completed?: boolean;
	successfulCompletion?: boolean;
	id: string;
	model: string;
	created: number;
	roleSent: boolean;
	sawTextDelta: boolean;
	toolCallsSeen: boolean;
	toolCallIndex: number;
	processedItemIds: Set<string>;
	pendingFunctionCalls: Map<number, PendingFunctionCallState>;
	sseKindCounts: Map<string, number>;
	outputItemTypeAdded: Map<string, number>;
	outputItemTypeDone: Map<string, number>;
	maxSseEventBytes: number;
	maxToolArgumentBytes: number;
}

export class StreamStateFactory {
	static create(model: string): StreamState {
		const state: StreamState = {
			buffer: '',
			id: `chatcmpl-${Date.now().toString(36)}`,
			model,
			created: Math.floor(Date.now() / 1000),
			roleSent: false,
			sawTextDelta: false,
			toolCallsSeen: false,
			toolCallIndex: 0,
			processedItemIds: new Set(),
			pendingFunctionCalls: new Map(),
			sseKindCounts: new Map(),
			outputItemTypeAdded: new Map(),
			outputItemTypeDone: new Map(),
			maxSseEventBytes: providerByteLimit(process.env.CODEX_MAX_SSE_EVENT_BYTES, DEFAULT_MAX_SSE_EVENT_BYTES),
			maxToolArgumentBytes: providerByteLimit(process.env.PROVIDER_MAX_TOOL_ARGUMENT_BYTES, DEFAULT_MAX_TOOL_ARGUMENT_BYTES)
		};

		return state;
	}
}
