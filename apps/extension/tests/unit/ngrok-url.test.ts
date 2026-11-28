import { describe, expect, it } from 'vitest';

import { NgrokUrl } from '../../src/ngrok-url';

describe('NgrokUrl', () => {
	it('reads only the launched tunnel address from its started record', () => {
		expect(NgrokUrl.read('{"url":"https://ungate.ngrok-free.app/","msg":"started tunnel"}')).toBe(
			'https://ungate.ngrok-free.app'
		);
		expect(NgrokUrl.read('tunnel https://example.ngrok.io ready')).toBeNull();
		expect(NgrokUrl.read('{"msg":"no url yet"}')).toBeNull();
		expect(NgrokUrl.read('http://example.ngrok.io')).toBeNull();
	});

	it.each([
		{ msg: 'update available', url: 'https://ngrok.com/download' },
		{ msg: 'authentication failed', url: 'https://dashboard.ngrok.com' },
		{ msg: 'started tunnel', url: 'http://example.ngrok.io' },
		{ msg: 'started tunnel', url: 'https://user:password@example.ngrok.io' },
		{ msg: 'started tunnel', url: 'https://example.ngrok.io/path' },
		{ msg: 'started tunnel', url: 'https://example.ngrok.io?token=secret' }
	])('rejects unrelated or non-origin addresses: $msg', (record) => {
		expect(NgrokUrl.read(JSON.stringify(record))).toBeNull();
	});
});
