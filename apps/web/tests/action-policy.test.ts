import { describe, expect, it } from 'vitest';

import { blocksDashboardUi, successNotice } from '../src/shared/action-policy';

describe('dashboard action policy', () => {
	it.each(['copy-api-key', 'copy-tunnel-url'] as const)('keeps the dashboard stable during %s', (action) => {
		expect(blocksDashboardUi(action)).toBe(false);
	});

	it.each(['restart-services', 'start-tunnel', 'stop-services'] as const)('blocks competing UI during %s', (action) => {
		expect(blocksDashboardUi(action)).toBe(true);
	});

	it.each(['reload-window', 'open-cursor-models'] as const)('does not claim unverifiable %s success', (action) => {
		expect(successNotice(action)).toBeNull();
	});

	it('reports only verified action outcomes', () => {
		expect(successNotice('copy-api-key')).toBe('API key copied');
		expect(successNotice('restart-tunnel')).toBe('Restart Tunnel: done');
	});
});
