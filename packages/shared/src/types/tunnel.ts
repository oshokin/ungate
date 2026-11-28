import type { TunnelStatus } from './runtime';

export type TunnelPublicStatus = 'unchecked' | 'checking' | 'reachable' | 'unreachable';

export interface TunnelState {
	/** Verified running executable, never the selected preference. Older hosts omit it. */
	provider?: 'quick' | 'ngrok' | null;
	status: TunnelStatus;
	url: string | null;
	error: string | null;
	publicStatus?: TunnelPublicStatus;
	publicCheckedAt?: number | null;
	publicError?: string | null;
	startedAt?: number | null;
}
