/** SSE keepalive interval while the provider is thinking without producing bytes. */
const STREAM_HEARTBEAT_MS = 15_000;
const STREAM_FIRST_BYTE_TIMEOUT_MS = 180_000;
const STREAM_IDLE_TIMEOUT_MS = 300_000;
const HEARTBEAT_FRAME = ': ping\n\n';

export function reliableOpenAiStream(upstream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	const reader = upstream.getReader();
	const encoder = new TextEncoder();
	let cancelled = false;

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			let first = true;
			let lastByteAt = Date.now();
			const heartbeat = setInterval(() => {
				if (!cancelled && Date.now() - lastByteAt >= STREAM_HEARTBEAT_MS) controller.enqueue(encoder.encode(HEARTBEAT_FRAME));
			}, STREAM_HEARTBEAT_MS);
			heartbeat.unref();

			try {
				while (!cancelled) {
					const timeoutMs = first ? STREAM_FIRST_BYTE_TIMEOUT_MS : STREAM_IDLE_TIMEOUT_MS;
					const result = await readWithTimeout(reader, timeoutMs);
					if (result === 'timeout') {
						await reader.cancel(new Error('Upstream stream timeout')).catch(() => {});
						const code = first ? 'readiness_timeout' : 'idle_timeout';
						const message = first
							? `Upstream produced no output within ${timeoutMs} ms.`
							: `Upstream stream was idle for ${timeoutMs} ms.`;
						controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message, type: 'server_error', code } })}\n\n`));
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
		},
		cancel(reason) {
			cancelled = true;

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
