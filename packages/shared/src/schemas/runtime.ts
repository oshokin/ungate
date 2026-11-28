import { z } from 'zod';

export const runtimeApiStatusSchema = z.enum(['starting', 'running', 'stopped', 'error']);
export const runtimeTunnelStatusSchema = z.enum(['starting', 'running', 'installing', 'stopped', 'error']);
export const tunnelPublicStatusSchema = z.enum(['unchecked', 'checking', 'reachable', 'unreachable']);
export const runtimeLogLevelSchema = z.enum(['info', 'warn', 'error']);

export const runtimeClientEntrySchema = z.object({
	lastSeenAt: z.number()
});

export const runtimeApiLogHealthSchema = z.object({
	status: z.enum(['available', 'unavailable']),
	logPath: z.string().nullable(),
	message: z.string().nullable()
});

export const runtimeApiStateSchema = z.object({
	pid: z.number().nullable(),
	port: z.number().nullable(),
	logPath: z.string().optional(),
	status: runtimeApiStatusSchema,
	lastSeenAt: z.number(),
	lastError: z.string().nullable(),
	ownerWindowId: z.string().nullable(),
	startSuppressed: z.boolean().optional(),
	logHealth: runtimeApiLogHealthSchema.optional()
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

/** `quick` is the Cloudflare quick tunnel. `ngrok` keeps one account domain across restarts. */
export const TUNNEL_PROVIDERS = ['quick', 'ngrok'] as const;

export const runtimeTunnelProviderSchema = z.enum(TUNNEL_PROVIDERS);

export const runtimeStateSchema = z.object({
	api: runtimeApiStateSchema,
	tunnel: runtimeTunnelStateSchema,
	keyFix: runtimeKeyFixStateSchema,
	// State files written before ngrok existed have no provider; quick keeps their rotating URL.
	tunnelProvider: runtimeTunnelProviderSchema.default('quick'),
	clients: z.record(z.string(), runtimeClientEntrySchema)
});
