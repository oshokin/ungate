import { z } from 'zod';

export const runtimeApiStatusSchema = z.enum(['starting', 'running', 'stopped', 'error']);
export const runtimeTunnelStatusSchema = z.enum(['starting', 'running', 'installing', 'stopped', 'error']);
export const tunnelPublicStatusSchema = z.enum(['unchecked', 'checking', 'reachable', 'unreachable']);
export const runtimeLogLevelSchema = z.enum(['info', 'warn', 'error']);

export const runtimeClientEntrySchema = z.object({
	lastSeenAt: z.number()
});

export const runtimeApiStateSchema = z.object({
	pid: z.number().nullable(),
	port: z.number().nullable(),
	logPath: z.string().optional(),
	status: runtimeApiStatusSchema,
	lastSeenAt: z.number(),
	lastError: z.string().nullable(),
	ownerWindowId: z.string().nullable(),
	startSuppressed: z.boolean().optional()
});

export const runtimeTunnelStateSchema = z.object({
	pid: z.number().int().positive().optional(),
	port: z.number().int().positive().optional(),
	logPath: z.string().optional(),
	protocol: z.enum(['http2', 'quic', 'auto']).optional(),
	startedAt: z.number().optional(),
	status: runtimeTunnelStatusSchema,
	url: z.string().nullable(),
	publicStatus: tunnelPublicStatusSchema.optional(),
	publicCheckedAt: z.number().nullable().optional(),
	publicError: z.string().nullable().optional(),
	lastSeenAt: z.number(),
	lastError: z.string().nullable(),
	ownerWindowId: z.string().nullable()
});

export const runtimeKeyFixStateSchema = z.object({
	enabled: z.boolean()
});

export const runtimeStateSchema = z.object({
	api: runtimeApiStateSchema,
	tunnel: runtimeTunnelStateSchema,
	keyFix: runtimeKeyFixStateSchema,
	clients: z.record(z.string(), runtimeClientEntrySchema)
});
