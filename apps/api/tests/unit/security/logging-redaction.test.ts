import { describe, expect, it, vi } from 'vitest';

const logs = vi.hoisted(() => ({ log: vi.fn() }));
vi.mock('src/utils/logger', () => ({ logger: logs }));

import { HeadersExtractor } from 'src/handlers/headers-extractor';
import { ToolNormalizer } from 'src/tools/normalizer';

describe('request log data minimization', () => {
	it('does not log secret headers, query strings, referers or tool payloads', () => {
		logs.log.mockClear();
		HeadersExtractor.logRequestDetails({
			authorization: 'secret-auth', cookie: 'secret-cookie',
			'x-admin-token': 'secret-admin', referer: 'https://example.com/?secret-referer',
			'content-type': 'secret-content-type', 'anthropic-beta': 'secret-beta'
		}, '/v1/messages?secret-query', 'POST', 'secret-endpoint');
		ToolNormalizer.normalize({
			type: 'tool_use', id: 'secret-id', name: 'Read',
			input: { target_file: 'secret-path', command: 'secret-command' }
		});
		const output = JSON.stringify(logs.log.mock.calls);
		expect(output).not.toContain('secret-');
		expect(output).toContain('content-type');
		expect(output).toContain('Tool input normalized');
	});
});
