export * from './types';
export * from './constants';
export * from './guards';
export * from './helpers/model-provider';
export * from './helpers/claude-cli';
export * from './helpers/provider-labels';
export * from './helpers/utils';
export * from './schemas';
export * from './service';
export * from './limits';
export * from './usage';

import type { LogEntry, TunnelState } from './types';

export type DashboardPreferenceKey = 'logs.maxEntries' | 'tunnel.connectTimeoutSeconds' | 'network.providerHeaderTimeoutSeconds';
export type DashboardPreferences = Record<DashboardPreferenceKey, number>;

export type ExtensionToWebview =
	| { type: 'dashboard-preferences'; values: DashboardPreferences }
	| { type: 'dashboard-preference-result'; key: DashboardPreferenceKey; error: string | null }
	| { type: 'usage-state'; state: import('./usage').UsageState }
	| { type: 'port'; port: number | null }
	| { type: 'tunnel-status'; state: TunnelState }
	| { type: 'service-state'; state: import('./service').ServiceState }
	| { type: 'log'; source: 'api' | 'tunnel'; entry: LogEntry; entryId?: string; maxEntries?: number }
	| { type: 'log-bulk'; source: 'api' | 'tunnel'; entries: LogEntry[]; entryIds?: string[]; maxEntries?: number }
	| { type: 'logs-cleared'; source: 'api' | 'tunnel' };

export type WebviewToExtension =
	| { type: 'get-dashboard-preferences' }
	| { type: 'set-dashboard-preference'; key: DashboardPreferenceKey; value: number }
	| { type: 'webview-ready' }
	| { type: 'restart-server' }
	| { type: 'start-tunnel' }
	| { type: 'stop-tunnel' }
	| { type: 'restart-tunnel' }
	| { type: 'clear-logs'; source: 'api' | 'tunnel' };
