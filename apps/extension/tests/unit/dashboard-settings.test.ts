import { readFileSync } from 'node:fs';

import { LOG_LIMITS, MILLISECONDS_PER_SECOND, normalizeLogEntryLimit, UNGATE_VERSION } from '@ungate/shared';
import { describe, expect, it, vi } from 'vitest';

import { dashboardLogEntryLimit, tunnelConnectTimeoutMs } from '../../src/dashboard-settings';
import { normalizeTunnelConnectTimeoutMs, TUNNEL_CONNECT } from '../../src/tunnel-connect';

const inspect = vi.hoisted(() => vi.fn());
vi.mock('vscode', () => ({ workspace: { getConfiguration: () => ({ inspect }) } }));

describe('dashboard preferences and release identity', () => {
	it('uses one bounded default and excludes workspace overrides', () => {
		inspect.mockReturnValue({ workspaceValue: 2000 });
		expect(dashboardLogEntryLimit()).toBe(LOG_LIMITS.defaultEntries);
		inspect.mockReturnValue({ globalValue: 1000, workspaceValue: 3000 });
		expect(dashboardLogEntryLimit()).toBe(1000);
	});
	it.each([undefined, null, '1000', 0, -1, 99, 5001, 100.5, Infinity, NaN])('rejects invalid log limit %s', (value) => {
		expect(normalizeLogEntryLimit(value)).toBe(LOG_LIMITS.defaultEntries);
	});
	it('keeps manifest defaults, supported bounds and API release in sync', () => {
		const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
			version: string;
			contributes: { configuration: { properties: Record<string, unknown> } };
		};
		const setting = manifest.contributes.configuration.properties['ungate.logs.maxEntries'];
		expect(manifest.version).toBe(UNGATE_VERSION);
		expect(setting).toMatchObject({
			default: LOG_LIMITS.defaultEntries,
			minimum: LOG_LIMITS.minEntries,
			maximum: LOG_LIMITS.maxEntries,
			scope: 'application'
		});
		expect(manifest.contributes.configuration.properties['ungate.tunnel.connectTimeoutSeconds']).toMatchObject({
			default: TUNNEL_CONNECT.defaultSeconds,
			minimum: TUNNEL_CONNECT.minSeconds,
			maximum: TUNNEL_CONNECT.maxSeconds,
			scope: 'machine'
		});
	});
	it('uses the machine tunnel timeout and ignores a workspace override', () => {
		inspect.mockReturnValue({ workspaceValue: 120 });
		expect(tunnelConnectTimeoutMs()).toBe(TUNNEL_CONNECT.defaultSeconds * MILLISECONDS_PER_SECOND);
		inspect.mockReturnValue({ globalValue: 90, workspaceValue: 15 });
		expect(tunnelConnectTimeoutMs()).toBe(90 * MILLISECONDS_PER_SECOND);
	});
	it.each([undefined, null, '45', 14, 121, 45.5, Infinity, NaN])('rejects invalid tunnel timeout %s', (value) => {
		expect(normalizeTunnelConnectTimeoutMs(value)).toBe(TUNNEL_CONNECT.defaultSeconds * MILLISECONDS_PER_SECOND);
	});
});
