import { ResponsesEventRouter } from './responses-event-router';

import type { StreamProcessResult, StreamState } from './stream-state';

export class ResponsesSseProcessor {
	static parsePart(part: string): Record<string, unknown>[] {
		const payloads: Record<string, unknown>[] = [];

		for (const line of part.split('\n')) {
			if (!line.startsWith('data:')) {
				continue;
			}

			const data = line.slice(5).trim();

			if (!data || data === '[DONE]') {
				continue;
			}

			try {
				payloads.push(JSON.parse(data) as Record<string, unknown>);
			} catch {
				// malformed JSON line — skip
			}
		}

		return payloads;
	}

	static process(state: StreamState, chunk: string): StreamProcessResult[] {
		state.buffer += chunk.replace(/\r/g, '');
		if (Buffer.byteLength(state.buffer, 'utf8') > state.maxSseEventBytes && !state.buffer.includes('\n\n')) {
			throw new Error(`Codex SSE event exceeded ${state.maxSseEventBytes} bytes`);
		}
		const results: StreamProcessResult[] = [];
		const parts = state.buffer.split('\n\n');
		const tail = parts.pop();
		state.buffer = '';

		if (tail != null) {
			state.buffer = tail;
		}

		for (const part of parts) {
			if (Buffer.byteLength(part, 'utf8') > state.maxSseEventBytes) {
				throw new Error(`Codex SSE event exceeded ${state.maxSseEventBytes} bytes`);
			}
			const payloads = this.parsePart(part);

			for (const payload of payloads) {
				ResponsesEventRouter.route(state, payload, results);
			}
		}

		return results;
	}

	/** Flush a provider stream that ended without the optional final blank SSE line. */
	static flush(state: StreamState, trailing = ''): StreamProcessResult[] {
		const results = trailing ? this.process(state, trailing) : [];
		if (!state.buffer.trim()) {
			state.buffer = '';

			return results;
		}

		return [...results, ...this.process(state, '\n\n')];
	}

	static failTruncated(state: StreamState): StreamProcessResult[] {
		if (state.completed) return [];
		const error = {
			message: 'ChatGPT Codex stream ended before a terminal event.',
			type: 'api_error',
			code: 'truncated_stream'
		};
		state.pendingFunctionCalls.clear();
		state.error = error;
		state.completed = true;
		state.successfulCompletion = false;

		return [{ type: 'error', data: { error } }, { type: 'done' }];
	}
}
