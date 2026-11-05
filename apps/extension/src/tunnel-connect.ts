import { MILLISECONDS_PER_SECOND } from '@ungate/shared';

/** How long cloudflared may take to publish a tunnel URL. */
export const TUNNEL_CONNECT = {
	/** Seconds used when ungate.tunnel.connectTimeoutSeconds is unset or invalid. */
	defaultSeconds: 45,
	/** Smallest accepted value. Shorter waits fail on ordinary networks. */
	minSeconds: 15,
	/** Largest accepted value. A longer wait leaves a stuck start running. */
	maxSeconds: 120
} as const;

/** Milliseconds to wait for a tunnel URL. Invalid input uses the default. */
export function normalizeTunnelConnectTimeoutMs(value: unknown): number {
	return typeof value === 'number' &&
		Number.isInteger(value) &&
		value >= TUNNEL_CONNECT.minSeconds &&
		value <= TUNNEL_CONNECT.maxSeconds
		? value * MILLISECONDS_PER_SECOND
		: TUNNEL_CONNECT.defaultSeconds * MILLISECONDS_PER_SECOND;
}
