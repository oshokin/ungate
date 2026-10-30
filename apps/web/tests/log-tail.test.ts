import { describe, expect, it } from 'vitest';

import { countNewEntryIds } from '../src/features/logs/log-tail';

describe('countNewEntryIds', () => {
	it('does not count the initial snapshot', () => {
		expect(countNewEntryIds([], ['api-1', 'api-2'])).toBe(0);
	});

	it('returns zero for a repeated snapshot', () => {
		expect(countNewEntryIds(['api-1', 'api-2'], ['api-1', 'api-2'])).toBe(0);
	});

	it('counts exactly three new API records', () => {
		expect(countNewEntryIds(['api-1'], ['api-1', 'api-2', 'api-3', 'api-4'])).toBe(3);
	});

	it('counts exactly three new Tunnel records', () => {
		expect(countNewEntryIds(['tunnel-1'], ['tunnel-1', 'tunnel-2', 'tunnel-3', 'tunnel-4'])).toBe(3);
	});

	it('handles ring-buffer rollover without counting retained records', () => {
		expect(countNewEntryIds(['id-1', 'id-2', 'id-3'], ['id-2', 'id-3', 'id-4'])).toBe(1);
	});
	it('does not count older history loaded by increasing the display limit', () => {
		expect(countNewEntryIds(['id-3', 'id-4'], ['id-1', 'id-2', 'id-3', 'id-4'], true)).toBe(0);
	});
	it('still counts new messages after the retained history when the limit grows', () => {
		expect(countNewEntryIds(['id-3', 'id-4'], ['id-1', 'id-2', 'id-3', 'id-4', 'id-5'], true)).toBe(1);
	});
	it('counts an earlier-arriving identity during normal polling without a limit change', () => {
		expect(countNewEntryIds(['id-3', 'id-4'], ['id-2', 'id-3', 'id-4'])).toBe(1);
	});
});
