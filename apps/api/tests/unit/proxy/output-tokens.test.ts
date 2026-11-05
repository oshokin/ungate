import { describe, expect, it } from 'vitest';

import { resolveMaxOutputTokens } from 'src/proxy/output-tokens';

describe('resolveMaxOutputTokens', () => {
	it('uses the model cap when the client omits a limit', () => {
		expect(resolveMaxOutputTokens(undefined, 64_000, 4096)).toBe(64_000);
	});

	it('clamps a client limit to the model cap', () => {
		expect(resolveMaxOutputTokens(100_000, 64_000, 4096)).toBe(64_000);
	});

	it('keeps a smaller client limit', () => {
		expect(resolveMaxOutputTokens(2048, 64_000, 4096)).toBe(2048);
	});

	it('uses the provider fallback when the cap is unknown', () => {
		expect(resolveMaxOutputTokens(undefined, null, 4096)).toBe(4096);
	});
});
