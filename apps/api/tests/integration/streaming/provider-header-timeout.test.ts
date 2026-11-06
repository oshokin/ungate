import { afterEach, describe, expect, it, vi } from 'vitest';

import { providerHeaderTimeoutFromEnv } from '@ungate/shared';

import { fetchWithHeaderTimeout } from '../../../src/security/outbound-request';

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe('provider header timeout environment', () => {
	it.each([undefined, '', ' ', '-1', '0', '4999', '120001', 'Infinity', 'NaN', '2147483648', '5000.5', '1e4'])(
		'defaults invalid milliseconds %s',
		(value) => expect(providerHeaderTimeoutFromEnv(value)).toBe(30000)
	);
	it.each(['5000', '30000', '120000', '5001'])('accepts bounded integer milliseconds %s', (value) => {
		expect(providerHeaderTimeoutFromEnv(value)).toBe(Number(value));
	});
	it.each(['5000', '120000', '-1', 'Infinity'])('uses the validated deadline for a generation POST (%s)', async (value) => {
		vi.stubEnv('UPSTREAM_HEADER_TIMEOUT_MS', value);
		const timer = vi.spyOn(globalThis, 'setTimeout');
		const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
		await fetchWithHeaderTimeout('https://example.com', { method: 'POST', body: '{}' }, undefined, undefined, transport);
		expect(timer).toHaveBeenCalledWith(expect.any(Function), providerHeaderTimeoutFromEnv(value));
		expect(transport).toHaveBeenCalledTimes(1);
	});
});
