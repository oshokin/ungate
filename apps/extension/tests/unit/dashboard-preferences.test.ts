import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readDashboardPreferences, writeDashboardPreference } from '../../src/dashboard-preferences';

const { inspect, update } = vi.hoisted(() => ({ inspect: vi.fn(), update: vi.fn() }));
vi.mock('vscode', () => ({
	ConfigurationTarget: { Global: 1 },
	workspace: { getConfiguration: () => ({ inspect, update }) }
}));

describe('inline dashboard preferences', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});
	it('reads actual global values, ignoring workspace values', () => {
		inspect.mockReturnValue({ globalValue: 100, workspaceValue: 999 });
		expect(readDashboardPreferences()).toEqual({
			'logs.maxEntries': 100,
			'tunnel.connectTimeoutSeconds': 100,
			'network.providerHeaderTimeoutSeconds': 100
		});
	});
	it('uses defaults when only workspace values exist', () => {
		inspect.mockReturnValue({ workspaceValue: 100 });
		expect(Object.values(readDashboardPreferences())).toEqual([500, 45, 30]);
	});
	it('persists valid changes globally without API operations', async () => {
		await writeDashboardPreference({ type: 'set-dashboard-preference', key: 'logs.maxEntries', value: 800 });
		expect(update).toHaveBeenCalledExactlyOnceWith('logs.maxEntries', 800, 1);
	});
	it.each([99, 5001, 500.1, '500', null, NaN, Infinity])('never persists invalid value %s', async (value) => {
		await expect(writeDashboardPreference({ type: 'set-dashboard-preference', key: 'logs.maxEntries', value })).rejects.toThrow();
		expect(update).not.toHaveBeenCalled();
	});
	it.each(['__proto__', 'constructor', 'nodePath', 'port'])('rejects arbitrary key %s', async (key) => {
		await expect(writeDashboardPreference({ type: 'set-dashboard-preference', key, value: 100 })).rejects.toThrow();
		expect(update).not.toHaveBeenCalled();
	});
});
