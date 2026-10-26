import { describe, expect, it } from 'vitest';

import { blocksDashboardUi } from '../src/shared/action-policy';

describe('dashboard action policy', () => {
	it.each(['copy-api-key', 'copy-tunnel-url'] as const)('keeps the dashboard stable during %s', (action) => {
		expect(blocksDashboardUi(action)).toBe(false);
	});

	it.each(['restart-services', 'start-tunnel', 'stop-services'] as const)('blocks competing UI during %s', (action) => {
		expect(blocksDashboardUi(action)).toBe(true);
	});
});
