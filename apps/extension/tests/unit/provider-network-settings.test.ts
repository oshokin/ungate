import { PROVIDER_HEADER_TIMEOUT, providerHeaderTimeoutFromEnv } from '@ungate/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import manifest from '../../package.json';
import { providerHeaderTimeoutEnvironment } from '../../src/provider-network-settings';

const mocks = vi.hoisted(() => ({ inspect: vi.fn() }));
vi.mock('vscode', () => ({
	workspace: { getConfiguration: () => ({ inspect: mocks.inspect }) }
}));
beforeEach(() => mocks.inspect.mockReset());

describe('provider header timeout configuration', () => {
	it('aligns the advanced machine manifest with runtime bounds', () => {
		expect(manifest.contributes.configuration.properties['ungate.network.providerHeaderTimeoutSeconds']).toMatchObject({
			type: 'integer',
			scope: 'machine',
			tags: ['advanced'],
			default: PROVIDER_HEADER_TIMEOUT.defaultSeconds,
			minimum: PROVIDER_HEADER_TIMEOUT.minSeconds,
			maximum: PROVIDER_HEADER_TIMEOUT.maxSeconds
		});
	});
	it.each([5, 30, 120])('passes the machine snapshot %s in milliseconds', (globalValue) => {
		mocks.inspect.mockReturnValue({ globalValue });
		expect(providerHeaderTimeoutEnvironment({})).toEqual({ UPSTREAM_HEADER_TIMEOUT_MS: String(globalValue * 1000) });
	});
	it.each([undefined, null, '60', NaN, Infinity, -1, 4, 121, 5.5])('defaults invalid setting %s', (globalValue) => {
		mocks.inspect.mockReturnValue({ globalValue, workspaceValue: 90 });
		expect(providerHeaderTimeoutEnvironment({}).UPSTREAM_HEADER_TIMEOUT_MS).toBe('30000');
	});
	it.each(['5000', '120000', '', '-1', 'Infinity', 'bad'])('preserves explicit inherited override %s', (value) => {
		mocks.inspect.mockReturnValue({ globalValue: 60 });
		expect(providerHeaderTimeoutEnvironment({ UPSTREAM_HEADER_TIMEOUT_MS: value })).toEqual({
			UPSTREAM_HEADER_TIMEOUT_MS: value
		});
		expect(mocks.inspect).not.toHaveBeenCalled();
	});
	it('defaults when configuration is unavailable', () => {
		expect(providerHeaderTimeoutEnvironment({}).UPSTREAM_HEADER_TIMEOUT_MS).toBe('30000');
		expect(providerHeaderTimeoutFromEnv('bad')).toBe(30000);
	});
});
