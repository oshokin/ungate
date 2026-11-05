import { describe, expect, it } from 'vitest';

import { classifyAnthropicRouteError } from 'src/routes/anthropic';

describe('classifyAnthropicRouteError', () => {
	it('maps upstream timeouts to 504', () => {
		const error = Object.assign(new Error('headers timeout'), { code: 'UND_ERR_HEADERS_TIMEOUT' });

		expect(classifyAnthropicRouteError(error)).toEqual({
			status: 504,
			message: 'Upstream provider request timed out.'
		});
	});

	it('maps nested network failures to 502', () => {
		const error = new TypeError('fetch failed', {
			cause: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })
		});

		expect(classifyAnthropicRouteError(error)).toEqual({
			status: 502,
			message: 'Upstream provider request failed.'
		});
	});

	it('hides unexpected internal errors behind a 500', () => {
		expect(classifyAnthropicRouteError(new Error('sensitive internal detail'))).toEqual({
			status: 500,
			message: 'Internal gateway error.'
		});
	});
});
