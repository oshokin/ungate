import { describe, expect, it } from 'vitest';

import { CloudflaredProcess } from '../../src/runtime-state/cloudflared-process';

describe('cloudflared origin arguments', () => {
	it.each(['--url http://127.0.0.1:47821', '--url=http://127.0.0.1:47821', '--url\0http://127.0.0.1:47821'])(
		'matches exact origin in %s',
		(args) => {
			const command = `cloudflared tunnel ${args} --logfile unique.log`;
			expect(CloudflaredProcess.servesApiPort(command, 47821)).toBe(true);
			expect(CloudflaredProcess.servesApiPort(command, 4782)).toBe(false);
			expect(CloudflaredProcess.servesApiPort(command, null)).toBe(true);
		}
	);
	it.each([
		'--url http://127.0.0.1:47821/path',
		'--other http://127.0.0.1:47821',
		'--url http://127.0.0.1:47821.evil',
		'--url http://localhost:47821'
	])('rejects unrelated argument %s', (args) => {
		expect(CloudflaredProcess.servesApiPort(`cloudflared tunnel ${args}`, 47821)).toBe(false);
	});
});
