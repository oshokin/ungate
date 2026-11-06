import { LOG_LIMITS, MILLISECONDS_PER_SECOND, normalizeLogEntryLimit } from '@ungate/shared';
import { describe, expect, it } from 'vitest';

import manifest from '../../package.json';
import { normalizeTunnelConnectTimeoutMs, TUNNEL_CONNECT } from '../../src/tunnel-connect';

const settings = manifest.contributes.configuration.properties;

describe('manifest configuration contracts', () => {
	it('keeps tunnel defaults and inclusive bounds aligned with runtime', () => {
		const setting = settings['ungate.tunnel.connectTimeoutSeconds'];
		expect([setting.default, setting.minimum, setting.maximum]).toEqual([
			TUNNEL_CONNECT.defaultSeconds,
			TUNNEL_CONNECT.minSeconds,
			TUNNEL_CONNECT.maxSeconds
		]);
		for (const seconds of [setting.minimum, setting.default, setting.maximum])
			expect(normalizeTunnelConnectTimeoutMs(seconds)).toBe(seconds * MILLISECONDS_PER_SECOND);
	});

	it('keeps log defaults and inclusive bounds aligned with runtime', () => {
		const setting = settings['ungate.logs.maxEntries'];
		expect([setting.default, setting.minimum, setting.maximum]).toEqual([
			LOG_LIMITS.defaultEntries,
			LOG_LIMITS.minEntries,
			LOG_LIMITS.maxEntries
		]);
		for (const entries of [setting.minimum, setting.default, setting.maximum])
			expect(normalizeLogEntryLimit(entries)).toBe(entries);
	});

	it.each([undefined, null, '45', NaN, Infinity, 15.5, TUNNEL_CONNECT.minSeconds - 1, TUNNEL_CONNECT.maxSeconds + 1])(
		'rejects invalid tunnel timeout %s',
		(value) => {
			expect(normalizeTunnelConnectTimeoutMs(value)).toBe(TUNNEL_CONNECT.defaultSeconds * MILLISECONDS_PER_SECOND);
		}
	);

	it.each([undefined, null, '500', NaN, Infinity, 100.5, LOG_LIMITS.minEntries - 1, LOG_LIMITS.maxEntries + 1])(
		'rejects invalid log limit %s',
		(value) => {
			expect(normalizeLogEntryLimit(value)).toBe(LOG_LIMITS.defaultEntries);
		}
	);

	it('keeps executable selection machine-scoped and empty by default', () => {
		expect(settings['ungate.nodePath']).toMatchObject({ default: '', scope: 'machine', type: 'string' });
	});
});
