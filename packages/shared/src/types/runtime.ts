import type {
	runtimeApiStateSchema,
	runtimeApiStatusSchema,
	runtimeClientEntrySchema,
	runtimeLogLevelSchema,
	runtimeStateSchema,
	runtimeTunnelStateSchema,
	runtimeTunnelStatusSchema
} from '../schemas/runtime';
import type { z } from 'zod';

export type ApiStatus = z.infer<typeof runtimeApiStatusSchema>;
export type TunnelStatus = z.infer<typeof runtimeTunnelStatusSchema>;
export type LogLevel = z.infer<typeof runtimeLogLevelSchema>;
export type RuntimeClientEntry = z.infer<typeof runtimeClientEntrySchema>;
export type RuntimeApiState = z.infer<typeof runtimeApiStateSchema>;
export type RuntimeTunnelState = z.infer<typeof runtimeTunnelStateSchema>;
export type RuntimeState = z.infer<typeof runtimeStateSchema>;
