import { describe, expect, it } from 'vitest';

import { isRoutineNgrokConnection, parseCloudflaredLogLine } from '../../src/utils/cloudflared-log';

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
		expect(parseCloudflaredLogLine(JSON.stringify({ lvl: 'info', msg: 'started tunnel' }), 3).message).toBe('started tunnel');
	});

	it('reads the ngrok message from msg', () => {
		const entry = parseCloudflaredLogLine(
			JSON.stringify({
				lvl: 'warn',
				t: '2026-11-21T09:00:00Z',
				msg: 'session closed',
				err: 'dial tcp: i/o timeout'
			}),
			50
		);

		expect(entry).toEqual({
			message: 'session closed · error: dial tcp: i/o timeout',
			timestamp: Date.parse('2026-11-21T09:00:00Z'),
			level: 'warn'
		});
	});

	it('preserves ngrok errors and falls back for invalid timestamps', () => {
		expect(
			parseCloudflaredLogLine(JSON.stringify({ lvl: 'error', t: 'invalid', msg: 'session failed', err: 'denied' }), 50)
		).toEqual({ timestamp: 50, level: 'error', message: 'session failed · error: denied' });
	});

	it('filters only error-free informational ngrok join events', () => {
		// Sanitized shape from the newest tunnel log; endpoint metadata is not journal content.
		const event = {
			t: '2026-11-22T14:59:30+0300',
			lvl: 'info',
			obj: 'join',
			msg: 'join connections',
			id: 'sanitized-id',
			l: { IP: '127.0.0.1', Port: 47821, Zone: '' },
			r: { IP: '192.0.2.1', Port: 46970, Zone: '' }
		};
		const raw = JSON.stringify(event);
		expect(isRoutineNgrokConnection(JSON.stringify(event))).toBe(true);
		expect(JSON.stringify(event)).toBe(raw);
		for (const override of [
			{ lvl: 'warn' },
			{ lvl: 'error' },
			{ err: 'failed' },
			{ error: 'failed' },
			{ obj: 'tunnels' },
			{ msg: 'session established' },
			{ lvl: 'debug' }
		])
			expect(isRoutineNgrokConnection(JSON.stringify({ ...event, ...override }))).toBe(false);
		expect(isRoutineNgrokConnection('join connections')).toBe(false);
		for (const msg of ['started tunnel', 'session established', 'session reconnecting', 'received stop request']) {
			expect(isRoutineNgrokConnection(JSON.stringify({ ...event, msg }))).toBe(false);
		}
	});
});
