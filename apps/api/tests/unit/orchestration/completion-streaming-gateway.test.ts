import { describe, expect, it, vi } from 'vitest';

import { CompletionStreamingGateway } from 'src/orchestration/openai';

describe('CompletionStreamingGateway', () => {
	it('copyUpstreamHeaders forwards headers but skips content-encoding', () => {
		const header = vi.fn();
		const reply = { header };
		const res = new Response(null, {
			status: 200,
			headers: {
				'content-type': 'text/plain',
				'content-encoding': 'gzip',
				'x-custom': '1'
			}
		});

		CompletionStreamingGateway.copyUpstreamHeaders(reply as never, res);

		const keys = header.mock.calls.map((c) => String(c[0]).toLowerCase());

		expect(keys).toContain('content-type');
		expect(keys).toContain('x-custom');
		expect(keys).not.toContain('content-encoding');
	});

	it('drops framing and hop-by-hop headers after stream transformation', () => {
		const header = vi.fn();
		const reply = { header };
		const res = new Response(null, {
			headers: {
				'content-type': 'text/event-stream',
				'content-length': '123',
				'transfer-encoding': 'chunked',
				connection: 'keep-alive',
				trailer: 'x-checksum',
				'x-request-id': 'upstream'
			}
		});

		CompletionStreamingGateway.copyUpstreamHeaders(reply as never, res, true);
		const keys = header.mock.calls.map((call) => String(call[0]).toLowerCase());

		expect(keys).toContain('content-type');
		expect(keys).toContain('x-request-id');
		expect(keys).not.toContain('content-length');
		expect(keys).not.toContain('transfer-encoding');
		expect(keys).not.toContain('connection');
		expect(keys).not.toContain('trailer');
	});
});
