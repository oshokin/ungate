import { isIP } from 'node:net';

import { MILLISECONDS_PER_SECOND, providerHeaderTimeoutFromEnv, type ModelMappingProvider } from '@ungate/shared';
import { ProviderHealth } from 'src/metrics/provider-health';

/** One bounded retry absorbs transient failures before any response bytes exist. */
const UPSTREAM_RETRY_ATTEMPTS = 1;
const UPSTREAM_RETRY_BASE_DELAY_MS = 300;
const UPSTREAM_RETRY_MAX_DELAY_MS = 2_000;
const UPSTREAM_RETRY_TOTAL_BUDGET_MS = 5_000;
const RETRYABLE_UPSTREAM_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
/** Nested `error.cause` links walked when classifying a failed fetch. */
const ERROR_CAUSE_WALK_LIMIT = 5;
const RETRYABLE_NETWORK_CODES = new Set([
	'ECONNRESET',
	'ECONNREFUSED',
	'ENETDOWN',
	'ENETUNREACH',
	'EHOSTUNREACH',
	'EAI_AGAIN',
	'ETIMEDOUT',
	'UND_ERR_CONNECT_TIMEOUT',
	'UND_ERR_HEADERS_TIMEOUT',
	'UND_ERR_SOCKET'
]);

/** Shared deadline for catalog discovery and subscription usage reads. */
export const PROVIDER_READ_TIMEOUT_MS = 8_000;

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
	requestSignal?: AbortSignal,
	provider?: ModelMappingProvider,
	transport: typeof fetch = fetch
): Promise<Response> {
	const timeoutMs = providerHeaderTimeoutFromEnv(process.env.UPSTREAM_HEADER_TIMEOUT_MS);
	const replayable = init.body === undefined || init.body === null || typeof init.body === 'string';
	const safeMethod = ['GET', 'HEAD', 'OPTIONS'].includes((init.method ?? 'GET').toUpperCase());
	const maxAttempts = replayable && safeMethod ? UPSTREAM_RETRY_ATTEMPTS + 1 : 1;
	let retryBudgetUsed = 0;

	for (let attempt = 1; ; attempt += 1) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(new Error('Upstream response header timeout')), timeoutMs);
		timeout.unref();
		const signals = [controller.signal, requestSignal, init.signal].filter((signal): signal is AbortSignal => Boolean(signal));
		const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);

		try {
			const response = await transport(input, { ...init, redirect: 'manual', signal });
			if (!RETRYABLE_UPSTREAM_STATUSES.has(response.status) || attempt >= maxAttempts || requestSignal?.aborted) {
				if (provider) {
					if (response.ok) ProviderHealth.success(provider, response.status);
					else ProviderHealth.failure(provider, `http_${response.status}`, response.status);
				}

				return response;
			}

			const delay = retryDelayMs(response, attempt);
			if (retryBudgetUsed + delay > UPSTREAM_RETRY_TOTAL_BUDGET_MS) return response;
			retryBudgetUsed += delay;
			await response.body?.cancel();
			await abortableDelay(delay, requestSignal);
		} catch (error) {
			if (
				attempt >= maxAttempts ||
				requestSignal?.aborted ||
				init.signal?.aborted ||
				(!controller.signal.aborted && !isRetryableNetworkError(error))
			) {
				if (provider && !requestSignal?.aborted) ProviderHealth.failure(provider, networkErrorCategory(error));
				throw error;
			}

			const delay = Math.min(UPSTREAM_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), UPSTREAM_RETRY_MAX_DELAY_MS);
			if (retryBudgetUsed + delay > UPSTREAM_RETRY_TOTAL_BUDGET_MS) throw error;
			retryBudgetUsed += delay;
			await abortableDelay(delay, requestSignal);
		} finally {
			clearTimeout(timeout);
		}
	}
}

function networkErrorCategory(error: unknown): string {
	let current = error;
	for (let depth = 0; current && depth < ERROR_CAUSE_WALK_LIMIT; depth += 1) {
		if (typeof current !== 'object') break;
		const candidate = current as { cause?: unknown; code?: unknown };
		if (typeof candidate.code === 'string') return candidate.code.toLowerCase();
		current = candidate.cause;
	}

	return 'network_error';
}

function retryDelayMs(response: Response, attempt: number): number {
	const retryAfter = response.headers.get('retry-after');
	if (retryAfter) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * MILLISECONDS_PER_SECOND, UPSTREAM_RETRY_MAX_DELAY_MS);
		const date = Date.parse(retryAfter);
		if (!Number.isNaN(date)) return Math.min(Math.max(0, date - Date.now()), UPSTREAM_RETRY_MAX_DELAY_MS);
	}

	return Math.min(UPSTREAM_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), UPSTREAM_RETRY_MAX_DELAY_MS);
}

function isRetryableNetworkError(error: unknown): boolean {
	let current = error;
	for (let depth = 0; current && depth < ERROR_CAUSE_WALK_LIMIT; depth += 1) {
		if (typeof current !== 'object') return false;
		const candidate = current as { cause?: unknown; code?: unknown };
		if (typeof candidate.code === 'string' && RETRYABLE_NETWORK_CODES.has(candidate.code)) return true;
		current = candidate.cause;
	}

	return error instanceof TypeError && error.message.toLowerCase().includes('fetch failed');
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError(signal));

			return;
		}
		const timer = setTimeout(resolve, ms);
		timer.unref();
		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				reject(abortError(signal));
			},
			{ once: true }
		);
	});
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error(signal.reason ? String(signal.reason) : 'Aborted');
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
			(a === 192 && b === 0 && (parts[2] === 0 || parts[2] === 2)) ||
			(a === 192 && b === 88 && parts[2] === 99) ||
			(a === 198 && (b === 18 || b === 19 || (b === 51 && parts[2] === 100))) ||
			(a === 203 && b === 0 && parts[2] === 113) ||
			(a === 100 && b >= 64 && b <= 127) ||
			a >= 224
		);
	}
	if (isIP(address) === 6) {
		// Canonicalize expanded and mixed IPv6 forms before classifying them.
		const canonical = new URL(`http://[${normalized}]/`).hostname.slice(1, -1);
		if (canonical.startsWith('::ffff:')) {
			const words = canonical
				.slice('::ffff:'.length)
				.split(':')
				.map((word) => parseInt(word, 16));

			return isPublicIpAddress(`${words[0] >> 8}.${words[0] & 255}.${words[1] >> 8}.${words[1] & 255}`);
		}

		// Fail closed outside global unicast; exclude special-purpose allocations.
		const [first, second = '0'] = canonical.split(':');
		const secondWord = parseInt(second || '0', 16);

		return (
			/^[23]/.test(canonical) &&
			!(first === '2001' && (secondWord <= 0x1ff || secondWord === 0xdb8)) &&
			!canonical.startsWith('2002:') &&
			!(first === '3fff' && secondWord <= 0xfff)
		);
	}

	return false;
}
