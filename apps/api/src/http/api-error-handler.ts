import { MAX_CHAT_MESSAGES } from 'src/schemas/proxy-requests';
import { logger } from 'src/utils/logger';

import type { FastifyInstance } from 'fastify';

interface ValidationIssue {
	instancePath?: string;
	keyword?: string;
	message?: string;
}

/** Plain-language reply when one request carries more chat messages than Ungate accepts. */
export function chatMessageLimitMessage(issues: ValidationIssue[], body: unknown): string | undefined {
	const overLimit = issues.some((issue) => issue.keyword === 'maxItems' && issue.instancePath === '/messages');
	if (!overLimit) return undefined;

	const count = messageCount(body);
	const advice = 'Start a new chat; this one is unchanged.';
	if (count === undefined) {
		return `Chat exceeds the ${MAX_CHAT_MESSAGES}-message limit. ${advice}`;
	}

	return `Chat has ${count} messages (limit ${MAX_CHAT_MESSAGES}). ${advice}`;
}

function messageCount(body: unknown): number | undefined {
	if (typeof body !== 'object' || body === null || !('messages' in body)) return undefined;
	const messages = body.messages;

	return Array.isArray(messages) ? messages.length : undefined;
}

function validationSummary(issues: ValidationIssue[]): string {
	return issues
		.slice(0, 3)
		.map((issue) => `${issue.instancePath ?? '/'} ${issue.keyword ?? ''} ${issue.message ?? ''}`.trim())
		.join('; ');
}

/** Maps proxy failures to OpenAI-shaped errors. Schema jargon stays in the log. */
export function registerApiErrorHandler(app: FastifyInstance): void {
	app.setErrorHandler((error, request, reply) => {
		const apiError = error as {
			validation?: ValidationIssue[];
			code?: string;
			statusCode?: number;
		};
		if (apiError.validation) {
			const summary = validationSummary(apiError.validation);
			logger.error(`Request validation failed: ${summary.length > 0 ? summary : 'unknown schema constraint'}`);
			const message =
				chatMessageLimitMessage(apiError.validation, request.body) ??
				(summary ? `Request validation failed: ${summary}` : 'Request validation failed');

			return reply.code(400).send({
				error: { message, type: 'invalid_request_error', code: 'invalid_request' }
			});
		}
		if (apiError.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
			return reply.code(413).send({
				error: { message: 'Request body too large', type: 'invalid_request_error', code: 'request_too_large' }
			});
		}
		logger.error('Unhandled API error');

		return reply.code(apiError.statusCode && apiError.statusCode < 500 ? apiError.statusCode : 500).send({
			error: { message: 'Request failed', type: 'api_error' }
		});
	});
}
