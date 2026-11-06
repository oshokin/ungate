import { MILLISECONDS_PER_SECOND } from './constants';

/** Response-header deadline only; not a stream byte-idle timeout. */
export const PROVIDER_HEADER_TIMEOUT = {
	defaultSeconds: 30,
	minSeconds: 5,
	maxSeconds: 120
} as const;

export function normalizeProviderHeaderTimeoutMs(seconds: unknown): number {
	return typeof seconds === 'number' &&
		Number.isInteger(seconds) &&
		seconds >= PROVIDER_HEADER_TIMEOUT.minSeconds &&
		seconds <= PROVIDER_HEADER_TIMEOUT.maxSeconds
		? seconds * MILLISECONDS_PER_SECOND
		: PROVIDER_HEADER_TIMEOUT.defaultSeconds * MILLISECONDS_PER_SECOND;
}

/** Environment accepts integer milliseconds within the same 5–120 second bounds. */
export function providerHeaderTimeoutFromEnv(value: string | undefined): number {
	const ms = value?.trim() && /^\d+$/.test(value.trim()) ? Number(value) : NaN;

	return Number.isInteger(ms) &&
		ms >= PROVIDER_HEADER_TIMEOUT.minSeconds * MILLISECONDS_PER_SECOND &&
		ms <= PROVIDER_HEADER_TIMEOUT.maxSeconds * MILLISECONDS_PER_SECOND
		? ms
		: PROVIDER_HEADER_TIMEOUT.defaultSeconds * MILLISECONDS_PER_SECOND;
}
