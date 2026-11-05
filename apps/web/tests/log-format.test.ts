import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatLogEntry } from '../src/features/logs/log-format';

describe('formatLogEntry', () => {
	afterEach(() => vi.restoreAllMocks());

	it('uses the host local date formatter when copying logs', () => {
		const localDate = vi.spyOn(Date.prototype, 'toLocaleString').mockReturnValue('11/4/2026, 11:54:55 AM');

		expect(formatLogEntry({ timestamp: 1, level: 'info', message: 'Registered tunnel connection' })).toBe(
			'11/4/2026, 11:54:55 AM [INFO] Registered tunnel connection'
		);
		expect(localDate).toHaveBeenCalledTimes(1);
	});
});
