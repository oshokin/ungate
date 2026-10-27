import { runtimeStateSchema, type RuntimeClientEntry, type RuntimeState } from '@ungate/shared/frontend';
import { z } from 'zod';

import { config } from './config';
import { RuntimeStateDefaults } from './default-state';

export class RuntimeStateNormalizer {
	public static normalize(raw: Partial<RuntimeState>): RuntimeState {
		const next = RuntimeStateDefaults.create();
		const now = Date.now();
		const stateSchema = runtimeStateSchema as z.ZodType<Partial<RuntimeState>>;
		const parsed = stateSchema.safeParse(raw);
		if (!parsed.success) throw new Error(`Invalid runtime state: ${z.prettifyError(parsed.error)}`);

		if (parsed.data.api) {
			next.api = {
				...next.api,
				...parsed.data.api,
				startSuppressed: parsed.data.api.startSuppressed === true
			};
		}

		if (parsed.data.tunnel) {
			next.tunnel = {
				...next.tunnel,
				...parsed.data.tunnel
			};
		}

		if (parsed.data.keyFix) {
			next.keyFix = {
				...next.keyFix,
				...parsed.data.keyFix
			};
		}

		if (typeof next.api.lastSeenAt !== 'number') {
			next.api.lastSeenAt = now;
		}

		if (typeof next.tunnel.lastSeenAt !== 'number') {
			next.tunnel.lastSeenAt = now;
		}

		if (raw.clients && typeof raw.clients === 'object') {
			next.clients = this.filterLiveClients(raw.clients, now);
		}

		// Legacy command/commands fields are intentionally discarded.

		return next;
	}

	public static filterLiveClients(clients: Record<string, RuntimeClientEntry>, now: number): Record<string, RuntimeClientEntry> {
		const next: Record<string, RuntimeClientEntry> = {};

		for (const [windowId, client] of Object.entries(clients)) {
			if (!client || typeof client.lastSeenAt !== 'number') {
				continue;
			}

			if (now - client.lastSeenAt <= config.runtimeState.staleClientMs) {
				next[windowId] = { lastSeenAt: client.lastSeenAt };
			}
		}

		return next;
	}
}
