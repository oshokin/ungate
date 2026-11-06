import { ANTHROPIC_API_VERSION } from '@ungate/shared';
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

		result['anthropic-version'] ??= ANTHROPIC_API_VERSION;

		return result;
	}

	public static logRequestDetails(headers: IncomingHttpHeaders, url: string, method: string, endpoint: string): void {
		// Log presence only: even normally benign header values can contain secrets.
		const safeHeaders = ['content-type', 'anthropic-version', 'anthropic-beta'];
		logger.log(
			`Request metadata: ${JSON.stringify({
				method: ['GET', 'POST', 'HEAD', 'OPTIONS'].includes(method) ? method : 'other',
				headersPresent: safeHeaders.filter((key) => headers[key] !== undefined)
			})}`
		);
		void url;
		void endpoint;
	}
}
