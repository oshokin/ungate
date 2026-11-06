import { afterEach, describe, expect, it, vi } from 'vitest';

import { getConfig } from 'src/config';

describe('config', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('uses env port over settings', () => {
		vi.stubEnv('PORT', '7777');

		const cfg = getConfig({
			port: 1234,
			apiKey: 'abc',
			quiet: true,
			extraInstruction: '',
			claudeCliVersionMode: 'stable',
			claudeCliVersionCustom: null,
			tunnelProtocol: 'http2',
			models: []
		});

		expect(cfg).toEqual({ port: 7777, apiKey: 'abc', quietMode: true });
	});

	it('falls back to settings when env is absent', () => {
		vi.stubEnv('PORT', undefined);

		const cfg = getConfig({
			port: 3000,
			apiKey: null,
			quiet: false,
			extraInstruction: null,
			claudeCliVersionMode: 'stable',
			claudeCliVersionCustom: null,
			tunnelProtocol: 'http2',
			models: []
		});

		expect(cfg).toEqual({ port: 3000, apiKey: undefined, quietMode: false });
	});

	it('preserves environment-only ephemeral port allocation', () => {
		vi.stubEnv('PORT', '0');
		expect(getConfig({ port: 4123 } as Parameters<typeof getConfig>[0]).port).toBe(0);
	});

	it.each(['abc', '', '3000junk', '1.5', '-1', '65536', ' 3000', '1e3'])('rejects invalid env port %j', (port) => {
		vi.stubEnv('PORT', port);

		expect(() => getConfig({
			port: 4123,
			apiKey: null,
			quiet: false,
			extraInstruction: null,
			claudeCliVersionMode: 'stable',
			claudeCliVersionCustom: null,
			tunnelProtocol: 'http2',
			models: []
		})).toThrow('PORT must be an integer');
	});
});
