import { Formatter } from '../../shared/formatter';

import type { LogEntry } from '@ungate/shared/frontend';

export function formatLogEntry(entry: LogEntry): string {
	return `${Formatter.date(entry.timestamp)} [${entry.level.toUpperCase()}] ${entry.message}`;
}
