import type { TunnelStatus } from './runtime';

export type TunnelPublicStatus = 'unchecked' | 'checking' | 'reachable' | 'unreachable';

export interface TunnelState {
	status: TunnelStatus;
	url: string | null;
	error: string | null;
	publicStatus?: TunnelPublicStatus;
	publicCheckedAt?: number | null;
	publicError?: string | null;
	startedAt?: number | null;
}
