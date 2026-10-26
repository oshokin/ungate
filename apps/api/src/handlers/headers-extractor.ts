import { logger } from 'src/utils/logger';

import type { IncomingHttpHeaders } from 'node:http';

export class HeadersExtractor {
	public static extractAnthropicHeaders(headers: IncomingHttpHeaders): Record<string, string> {
		const result: Record<string, string> = {};
		const passthrough = ['anthropic-version', 'anthropic-beta'];

		for (const key of passthrough) {
			const value = headers[key];

			if (value) {
				result[key] = Array.isArray(value) ? value.join(', ') : value;
			}
		}

		result['anthropic-version'] ??= '2023-06-01';

		return result;
	}

	public static logRequestDetails(headers: IncomingHttpHeaders, url: string, method: string, endpoint: string): void {
		const parsedUrl = new URL(url, 'http://localhost');
		const get = (key: string) => {
			const v = headers[key];

			return Array.isArray(v) ? v.join(', ') : (v ?? 'none');
		};

		logger.log(`\n📥 [${endpoint}] Request Details:`);
		logger.log(`   User-Agent: ${get('user-agent')}`);
		logger.log(`   Origin: ${get('origin')}`);
		logger.log(`   Referer: ${get('referer')}`);
		logger.log(`   CF-Ray: ${get('cf-ray')}`);
		logger.log(`   CF-Connecting-IP: ${get('cf-connecting-ip')} (Cursor backend server)`);
		logger.log(`   X-Forwarded-For: ${get('x-forwarded-for')}`);
		logger.log(`   X-Real-IP: ${get('x-real-ip')}`);
		logger.log(`   Anthropic-Beta: ${get('anthropic-beta')}`);
		logger.log(`   URL: ${parsedUrl.pathname}${parsedUrl.search}`);
		logger.log(`   Method: ${method}`);

		const allHeaders: Record<string, string> = {};

		for (const [key, value] of Object.entries(headers)) {
			const lowerKey = key.toLowerCase();

			if (lowerKey === 'authorization' || lowerKey === 'x-api-key') {
				allHeaders[key] = '[redacted]';
			} else {
				allHeaders[key] = Array.isArray(value) ? value.join(', ') : (value ?? '');
			}
		}

		logger.log(`   All Headers: ${JSON.stringify(allHeaders, null, 2)}`);
	}
}
