import type { StreamProcessResult, StreamState } from './stream-state';
import type { ChatCompletionUsage, OpenAIToolCall } from 'src/types/openai';

interface ToolCallDelta {
	index?: number;
	id?: string;
	type?: 'function';
	function?: { name?: string; arguments?: string };
}

export class CompletionAccumulator {
	private content = '';
	private readonly toolCalls = new Map<number, OpenAIToolCall>();
	private finishReason: 'stop' | 'length' | 'tool_calls' = 'stop';
	private usage?: ChatCompletionUsage;

	consume(results: StreamProcessResult[]): void {
		for (const result of results) {
			if (result.type !== 'chunk' || !result.data) continue;
			const choice = (result.data.choices as Record<string, unknown>[] | undefined)?.[0];
			const delta = choice?.delta as Record<string, unknown> | undefined;
			if (typeof delta?.content === 'string') this.content += delta.content;

			for (const call of (delta?.tool_calls as ToolCallDelta[] | undefined) ?? []) {
				const index = call.index;
				if (typeof index !== 'number') continue;
				const current = this.toolCalls.get(index) ?? {
					id: call.id ?? `call_${index}`,
					type: 'function',
					function: { name: call.function?.name ?? '', arguments: '' }
				};
				if (call.id) current.id = call.id;
				if (call.function?.name) current.function.name = call.function.name;
				if (call.function?.arguments) current.function.arguments += call.function.arguments;
				this.toolCalls.set(index, current);
			}

			const finish = choice?.finish_reason;
			if (finish === 'stop' || finish === 'length' || finish === 'tool_calls') this.finishReason = finish;
			const usage = result.data.usage;
			if (usage && typeof usage === 'object') this.usage = usage as ChatCompletionUsage;
		}
	}

	response(state: StreamState): Record<string, unknown> {
		const toolCalls = [...this.toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
		const message: Record<string, unknown> = { role: 'assistant', content: this.content || null };
		if (toolCalls.length > 0) message.tool_calls = toolCalls;

		return {
			id: state.id,
			object: 'chat.completion',
			created: state.created,
			model: state.model,
			choices: [{ index: 0, message, finish_reason: toolCalls.length > 0 ? 'tool_calls' : this.finishReason }],
			...((this.usage ?? state.usage) ? { usage: this.usage ?? state.usage } : {})
		};
	}
}
