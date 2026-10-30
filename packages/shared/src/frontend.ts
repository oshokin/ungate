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

import type { LogEntry, TunnelState } from './types';

export type ExtensionToWebview =
	| { type: 'port'; port: number | null }
	| { type: 'tunnel-status'; state: TunnelState }
	| { type: 'service-state'; state: import('./service').ServiceState }
	| { type: 'log'; source: 'api' | 'tunnel'; entry: LogEntry; entryId?: string; maxEntries?: number }
	| { type: 'log-bulk'; source: 'api' | 'tunnel'; entries: LogEntry[]; entryIds?: string[]; maxEntries?: number }
	| { type: 'logs-cleared'; source: 'api' | 'tunnel' };

export type WebviewToExtension =
	| { type: 'webview-ready' }
	| { type: 'restart-server' }
	| { type: 'start-tunnel' }
	| { type: 'stop-tunnel' }
	| { type: 'restart-tunnel' }
	| { type: 'clear-logs'; source: 'api' | 'tunnel' };
