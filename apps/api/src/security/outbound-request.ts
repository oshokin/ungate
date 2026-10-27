import { isIP } from 'node:net';

const DEFAULT_HEADER_TIMEOUT_MS = 30_000;

export function createRequestAbortSignal(
	request: { raw: NodeJS.EventEmitter & { aborted?: boolean } },
	reply: { raw: NodeJS.EventEmitter & { writableEnded?: boolean } }
): {
	signal: AbortSignal;
	cleanup: () => void;
} {
	const controller = new AbortController();
	const abort = () => controller.abort(new Error('Client disconnected'));
	const abortReply = () => {
		if (!reply.raw.writableEnded) abort();
	};
	request.raw.once('aborted', abort);
	reply.raw.once('close', abortReply);
	const cleanup = () => {
		request.raw.off('aborted', abort);
		reply.raw.off('close', abortReply);
		reply.raw.off('finish', cleanup);
	};
	reply.raw.once('finish', cleanup);

	return {
		signal: controller.signal,
		cleanup
	};
}

export async function fetchWithHeaderTimeout(
	input: string | URL,
	init: RequestInit,
	requestSignal?: AbortSignal
): Promise<Response> {
	const controller = new AbortController();
	const timeoutMs = Number(process.env.UPSTREAM_HEADER_TIMEOUT_MS) || DEFAULT_HEADER_TIMEOUT_MS;
	const timeout = setTimeout(() => controller.abort(new Error('Upstream response header timeout')), timeoutMs);
	timeout.unref();
	const abort = () => controller.abort(requestSignal?.reason);
	requestSignal?.addEventListener('abort', abort, { once: true });

	try {
		return await fetch(input, { ...init, redirect: 'manual', signal: controller.signal });
	} catch (error) {
		requestSignal?.removeEventListener('abort', abort);
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

export function isPublicIpAddress(address: string): boolean {
	const normalized = address.toLowerCase();
	if (isIP(address) === 4) {
		const parts = address.split('.').map(Number);
		const [a, b] = parts;

		return !(
			a === 0 ||
			a === 10 ||
			a === 127 ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 100 && b >= 64 && b <= 127) ||
			a >= 224
		);
	}
	if (isIP(address) === 6) {
		return !(
			normalized === '::' ||
			normalized === '::1' ||
			normalized.startsWith('fc') ||
			normalized.startsWith('fd') ||
			normalized.startsWith('fe8') ||
			normalized.startsWith('fe9') ||
			normalized.startsWith('fea') ||
			normalized.startsWith('feb') ||
			normalized.startsWith('ff') ||
			normalized.startsWith('2001:db8:')
		);
	}

	return false;
}
