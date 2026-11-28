import { describe, expect, it } from 'vitest';

import { ngrokFailure, redactNgrokToken } from '../../src/ngrok-failure';
import { NgrokUrl } from '../../src/ngrok-url';

describe('ngrok output safeguards', () => {
	it.each(['eror', 'crit', 'error'])('extracts actionable %s failures', (lvl) => {
		expect(
			ngrokFailure([JSON.stringify({ lvl, err: 'authentication failed\nhttps://dashboard.ngrok.com\nERR_NGROK_105' })])
		).toBe('ngrok: authentication failed (ERR_NGROK_105)');
	});
	it('joins stderr reason and code while ignoring help links', () => {
		expect(ngrokFailure(['ERROR: authentication failed', 'ERROR: https://dashboard.ngrok.com', 'ERROR: ERR_NGROK_4018'])).toBe(
			'ngrok: authentication failed (ERR_NGROK_4018)'
		);
		expect(ngrokFailure([JSON.stringify({ lvl: 'warn', err: 'update failed' })])).toBeNull();
	});
	it.each(['https://dashboard.ngrok.com', 'https://ngrok.com', 'https://update.ngrok-agent.com'])(
		'rejects help origin %s',
		(url) => {
			expect(NgrokUrl.read(JSON.stringify({ msg: 'started tunnel', url }))).toBeNull();
		}
	);
	it.each(['eror', 'crit', 'error'])('rejects failed start records at %s', (lvl) => {
		expect(NgrokUrl.read(JSON.stringify({ msg: 'started tunnel', lvl, url: 'https://stable.ngrok-free.app' }))).toBeNull();
	});
	it('redacts exact credentials and credential fields', () => {
		expect(redactNgrokToken('bad secret-token NGROK_AUTHTOKEN=other', 'secret-token')).toBe(
			'bad [redacted] NGROK_AUTHTOKEN=[redacted]'
		);
	});
});
