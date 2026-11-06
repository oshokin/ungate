import { STREAM_FIRST_BYTE_TIMEOUT_MS, STREAM_HEARTBEAT_MS } from './stream-timing';

const STREAM_IDLE_TIMEOUT_MS = 300_000;
const HEARTBEAT_FRAME = ': ping\n\n';

export function reliableOpenAiStream(upstream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	const reader = upstream.getReader();
	const encoder = new TextEncoder();
	let cancelled = false;
	let resume: (() => void) | undefined;
	let heartbeat: ReturnType<typeof setInterval> | undefined;

	return new ReadableStream<Uint8Array>({
		start(controller) {
			void (async () => {
				let first = true;
				let lastByteAt = Date.now();
				heartbeat = setInterval(() => {
					if (!cancelled && (controller.desiredSize ?? 0) > 0 && Date.now() - lastByteAt >= STREAM_HEARTBEAT_MS)
						controller.enqueue(encoder.encode(HEARTBEAT_FRAME));
				}, STREAM_HEARTBEAT_MS);
				heartbeat.unref();

				try {
					while (!cancelled) {
						if ((controller.desiredSize ?? 0) <= 0) {
							await new Promise<void>((resolve) => {
								resume = resolve;
							});
							resume = undefined;
							if (cancelled) break;
						}
						const timeoutMs = first ? STREAM_FIRST_BYTE_TIMEOUT_MS : STREAM_IDLE_TIMEOUT_MS;
						const result = await readWithTimeout(reader, timeoutMs);
						if (cancelled) break;
						if (result === 'timeout') {
							// Provider cancellation may never settle; terminal output must not
							// depend on the upstream underlying source acknowledging it.
							void reader.cancel(new Error('Upstream stream timeout')).catch(() => {});
							const code = first ? 'readiness_timeout' : 'idle_timeout';
							const message = first
								? `Upstream produced no output within ${timeoutMs} ms.`
								: `Upstream stream was idle for ${timeoutMs} ms.`;
							controller.enqueue(
								encoder.encode(`data: ${JSON.stringify({ error: { message, type: 'server_error', code } })}\n\n`)
							);
							controller.enqueue(encoder.encode('data: [DONE]\n\n'));
							break;
						}
						if (result.done) break;
						first = false;
						lastByteAt = Date.now();
						controller.enqueue(result.value);
					}
					if (!cancelled) controller.close();
				} catch (error) {
					if (!cancelled) controller.error(error);
				} finally {
					clearInterval(heartbeat);
					reader.releaseLock();
				}
			})();
		},
		pull() {
			resume?.();
		},
		cancel(reason) {
			cancelled = true;
			clearInterval(heartbeat);
			resume?.();

			return reader.cancel(reason);
		}
	});
}

async function readWithTimeout(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	timeoutMs: number
): Promise<ReadableStreamReadResult<Uint8Array> | 'timeout'> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<'timeout'>((resolve) => {
		timer = setTimeout(() => resolve('timeout'), timeoutMs);
		timer.unref();
	});

	try {
		return await Promise.race([reader.read(), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
