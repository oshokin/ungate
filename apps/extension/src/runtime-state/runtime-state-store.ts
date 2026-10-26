import { getCloudflaredBinPath, ManagedProcess } from '../utils/managed-process';

import { config } from './config';
import { RuntimeStateFileStore } from './file-store';
import { RuntimeStateNormalizer } from './normalizer';

import type { RuntimeCommand, RuntimeState } from '@ungate/shared/frontend';

export class RuntimeStateStore {
	public static read(): RuntimeState {
		return RuntimeStateFileStore.read();
	}

	public static write(next: RuntimeState): void {
		RuntimeStateFileStore.write(next);
	}

	public static mutate(mutator: (current: RuntimeState) => RuntimeState): Promise<RuntimeState> {
		return RuntimeStateFileStore.mutate(mutator);
	}

	public static async touchClient(windowId: string): Promise<RuntimeState> {
		return await this.mutate((current) => {
			const now = Date.now();
			const clients = RuntimeStateNormalizer.filterLiveClients(current.clients, now);
			const previous = clients[windowId];

			if (!previous || now - previous.lastSeenAt >= config.runtimeState.heartbeatThrottleMs) {
				clients[windowId] = { lastSeenAt: now };
			}

			current.clients = clients;

			return current;
		});
	}

	public static async removeClient(windowId: string): Promise<RuntimeState> {
		return await this.mutate((current) => {
			const clients = { ...current.clients };
			delete clients[windowId];
			current.clients = clients;

			return current;
		});
	}

	public static getLiveClientIds(state: RuntimeState, now = Date.now()): string[] {
		return Object.entries(state.clients)
			.filter(([, entry]) => now - entry.lastSeenAt <= config.runtimeState.staleClientMs)
			.map(([id]) => id);
	}

	public static hasLiveClients(state: RuntimeState, now = Date.now()): boolean {
		return this.getLiveClientIds(state, now).length > 0;
	}

	public static getLeaderWindowId(state: RuntimeState, now = Date.now()): string | null {
		const live = this.getLiveClientIds(state, now).sort();
		// Opening another window must not preempt a healthy owner.
		if (state.api.ownerWindowId && live.includes(state.api.ownerWindowId)) return state.api.ownerWindowId;

		if (live.length === 0) {
			return null;
		}

		return live[0];
	}

	public static async reconcileOrphanedTunnel(state: RuntimeState = this.read()): Promise<RuntimeState> {
		if (!this.isOrphanedTunnel(state)) {
			return state;
		}

		return await this.mutate((current) => {
			if (!this.isOrphanedTunnel(current)) {
				return current;
			}

			const now = Date.now();
			if (ManagedProcess.matches(current.tunnel.pid, getCloudflaredBinPath(), current.tunnel.logPath)) {
				// Process ownership outlives the window. Preserve its URL across host restarts.
				current.tunnel.ownerWindowId = this.getLeaderWindowId(current);

				return current;
			}
			if (current.tunnel.pid && ManagedProcess.isAlive(current.tunnel.pid)) {
				current.tunnel.status = 'error';
				current.tunnel.lastError = 'Tunnel process identity could not be verified. No process was stopped.';

				return current;
			}
			current.tunnel.pid = undefined;
			current.tunnel.logPath = undefined;
			current.tunnel.port = undefined;
			current.tunnel.startedAt = undefined;
			current.tunnel.status = 'stopped';
			current.tunnel.url = null;
			current.tunnel.publicStatus = 'unchecked';
			current.tunnel.publicCheckedAt = null;
			current.tunnel.publicError = null;
			current.tunnel.lastError = null;
			current.tunnel.ownerWindowId = null;
			current.tunnel.lastSeenAt = now;

			return current;
		});
	}

	public static getFilePath(): string {
		return RuntimeStateFileStore.getFilePath();
	}

	public static async enqueueCommand(command: RuntimeCommand): Promise<RuntimeState> {
		return await this.mutate((current) => {
			current.commands.push(command);

			return current;
		});
	}

	public static peekCommand(): RuntimeCommand | null {
		const state = this.read();

		if (state.commands.length === 0) {
			return null;
		}

		return state.commands[0];
	}

	public static async removeCommand(commandId: string): Promise<RuntimeState> {
		return await this.mutate((current) => {
			current.commands = current.commands.filter((command) => command.id !== commandId);

			return current;
		});
	}

	public static isApiStartSuppressed(state: RuntimeState = this.read()): boolean {
		return state.api.startSuppressed === true;
	}

	public static async prepareApiForBootstrap(): Promise<RuntimeState> {
		let current = this.read();
		if (current.keyFix.enabled)
			current = await this.mutate((state) => {
				state.keyFix.enabled = false;

				return state;
			});
		if (current.api.status === 'stopped' && current.api.startSuppressed) return current;

		const portHealthy = current.api.port !== null ? await this.isApiPortHealthy(current.api.port) : false;

		if (portHealthy) {
			return await this.mutate((state) => {
				state.api.startSuppressed = false;

				return state;
			});
		}

		return await this.mutate((state) => {
			const now = Date.now();
			if (state.api.port !== current.api.port || state.api.lastSeenAt !== current.api.lastSeenAt) return state;
			if (
				state.api.status === 'starting' &&
				now - state.api.lastSeenAt < 120000 &&
				state.api.ownerWindowId &&
				this.getLiveClientIds(state).includes(state.api.ownerWindowId)
			)
				return state;

			if (state.api.pid && ManagedProcess.isAlive(state.api.pid)) return state;
			state.api.startSuppressed = false;
			state.api.status = 'stopped';
			state.api.ownerWindowId = null;
			state.api.pid = null;
			state.api.port = null;
			state.api.lastSeenAt = now;

			return state;
		});
	}

	public static async suppressApiAutoStart(message: string): Promise<void> {
		await this.mutate((current) => {
			const now = Date.now();

			current.api.status = 'error';
			current.api.lastError = message;
			current.api.startSuppressed = true;
			current.api.ownerWindowId = null;
			current.api.lastSeenAt = now;

			return current;
		});
	}

	public static async resetApiForRestart(): Promise<void> {
		await this.mutate((current) => {
			const now = Date.now();

			current.api.status = 'stopped';
			current.api.lastError = null;
			current.api.startSuppressed = false;
			current.api.ownerWindowId = null;
			current.api.pid = null;
			current.api.port = null;
			current.api.lastSeenAt = now;

			return current;
		});
	}

	private static isActiveTunnel(state: RuntimeState): boolean {
		const status = state.tunnel.status;

		return status === 'running' || status === 'starting' || status === 'installing';
	}

	private static isOrphanedTunnel(state: RuntimeState, now = Date.now()): boolean {
		if (!this.isActiveTunnel(state)) {
			return false;
		}

		const ownerId = state.tunnel.ownerWindowId;

		return ownerId === null || !this.getLiveClientIds(state, now).includes(ownerId);
	}

	private static async isApiPortHealthy(port: number): Promise<boolean> {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/health`, {
				signal: AbortSignal.timeout(config.apiServer.portHealthRequestTimeoutMs)
			});

			if (!response.ok) return false;
			const raw: unknown = await response.json();
			const health = raw as { service?: string };

			return health.service === 'ungate';
		} catch {
			return false;
		}
	}
}
