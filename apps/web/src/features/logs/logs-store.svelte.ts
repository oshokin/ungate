import { LOG_LIMITS, normalizeLogEntryLimit } from '@ungate/shared/frontend';

import { postExtensionMessage } from '$shared/vscode';

import { countNewEntryIds } from './log-tail';

import type { LogSource } from '$shared/vscode';
import type { ExtensionToWebview, LogEntry } from '@ungate/shared/frontend';

interface SourceState {
	entries: LogEntry[];
	entryIds: string[];
	revision: number;
	maxEntries: number;
	historyExpanded: boolean;
}

const logs = $state<Record<LogSource, SourceState>>({
	api: { entries: [], entryIds: [], revision: 0, maxEntries: LOG_LIMITS.defaultEntries, historyExpanded: false },
	tunnel: { entries: [], entryIds: [], revision: 0, maxEntries: LOG_LIMITS.defaultEntries, historyExpanded: false }
});

window.addEventListener('message', (event: MessageEvent<ExtensionToWebview>) => {
	const message = event.data;
	if (
		!message ||
		typeof message !== 'object' ||
		!('source' in message) ||
		(message.source !== 'api' && message.source !== 'tunnel')
	)
		return;
	const source = logs[message.source];
	if (message.type === 'log' || message.type === 'log-bulk') {
		const previousLimit = source.maxEntries;
		let maxEntries = previousLimit;
		if (message.maxEntries !== undefined) maxEntries = normalizeLogEntryLimit(message.maxEntries);
		source.maxEntries = maxEntries;
		// A live entry can announce the new preference before the expanded history arrives.
		source.historyExpanded ||= maxEntries > previousLimit;
		if (message.type === 'log') {
			source.entries = [...source.entries, message.entry].slice(-maxEntries);
			source.revision += 1;
			source.entryIds = [...source.entryIds, message.entryId ?? ''].slice(-maxEntries);
		} else {
			const ids = (message.entryIds ?? []).slice(-maxEntries);
			source.entries = message.entries.slice(-maxEntries);
			source.revision += countNewEntryIds(source.entryIds, ids, source.historyExpanded);
			source.historyExpanded = false;
			source.entryIds = ids;
		}
	} else if (message.type === 'logs-cleared') reset(message.source);
});

function reset(source: LogSource): void {
	logs[source].entries = [];
	logs[source].entryIds = [];
	logs[source].historyExpanded = false;
}

function clear(source: LogSource): void {
	reset(source);
	postExtensionMessage({ type: 'clear-logs', source });
}

async function copy(source: LogSource): Promise<void> {
	const text = logs[source].entries
		.map((entry) => `${new Date(entry.timestamp).toISOString()} [${entry.level}] ${entry.message}`)
		.join('\n');
	await navigator.clipboard.writeText(text);
}

export function getLogsStore() {
	return {
		source(source: LogSource): SourceState {
			return logs[source];
		},
		clear,
		copy
	};
}
