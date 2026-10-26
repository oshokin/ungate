import { z } from 'zod';

const readPaths = [
	'/health',
	'/settings',
	'/usage',
	'/auth/claude/status',
	'/auth/openai/start',
	'/auth/openai/status',
	'/auth/minimax/status'
];
const writePaths = [
	'/settings',
	'/usage/refresh',
	'/models/discover',
	'/auth/claude/start',
	'/auth/claude/complete',
	'/auth/claude/logout',
	'/auth/openai/logout',
	'/auth/minimax/login',
	'/auth/minimax/base-url',
	'/auth/minimax/logout'
];

/** A closed capability list: no arbitrary URLs, headers, shutdown or model requests. */
export const dashboardRequestSchema = z
	.object({
		type: z.literal('api-request'),
		id: z.string().min(1).max(100),
		method: z.enum(['GET', 'POST']),
		path: z.string(),
		body: z.unknown().optional()
	})
	.strict()
	.refine((value) => (value.method === 'GET' ? readPaths : writePaths).includes(value.path), 'Unsupported dashboard operation');

export type DashboardRequest = z.infer<typeof dashboardRequestSchema>;
export interface DashboardResponse {
	type: 'api-response';
	id: string;
	status: number;
	body?: unknown;
	error?: string;
}
