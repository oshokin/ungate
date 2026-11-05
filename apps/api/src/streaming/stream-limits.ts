/** Largest single SSE event accepted from a provider before the stream is aborted. */
export const DEFAULT_MAX_SSE_EVENT_BYTES = 1024 * 1024;

/** Largest accumulated tool-argument payload accepted from one provider stream. */
export const DEFAULT_MAX_TOOL_ARGUMENT_BYTES = 4 * 1024 * 1024;

/** Queued SSE chunks before the downstream reader applies backpressure. */
export const SSE_QUEUE_HIGH_WATER_MARK = 64;

/** Positive integer from the environment, otherwise the built-in byte limit. */
export function providerByteLimit(raw: string | undefined, fallback: number): number {
	const parsed = Number(raw);

	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
