import { describe, expect, it } from 'vitest';

import { parseCloudflaredLogLine } from '../../src/utils/cloudflared-log';

describe('parseCloudflaredLogLine', () => {
	it('uses the cloudflared event time and removes raw JSON noise', () => {
		const entry = parseCloudflaredLogLine(
			JSON.stringify({
				level: 'info',
				time: '2026-11-04T08:54:55Z',
				message: 'Registered tunnel connection',
				location: 'arn09',
				protocol: 'http2',
				connection: 'secret-connector-id'
			})
		);

		expect(entry).toEqual({
			timestamp: Date.parse('2026-11-04T08:54:55Z'),
			level: 'info',
			message: 'Registered tunnel connection · location: arn09 · protocol: http2'
		});
		expect(entry.message).not.toContain('2026-11-04');
		expect(entry.message).not.toContain('secret-connector-id');
	});

	it('keeps useful errors and falls back for non-JSON lines', () => {
		expect(
			parseCloudflaredLogLine(
				JSON.stringify({
					level: 'error',
					message: 'Serve tunnel error',
					error: 'connection with edge closed'
				}),
				1
			)
		).toEqual({
			timestamp: 1,
			level: 'error',
			message: 'Serve tunnel error · error: connection with edge closed'
		});
		expect(parseCloudflaredLogLine('plain log', 2)).toEqual({ timestamp: 2, level: 'info', message: 'plain log' });
	});
});
