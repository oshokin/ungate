import { describeService, type DashboardAction } from '@ungate/shared/frontend';

import { readApiHealth, readTunnelProtocol } from './local-api';
import { RuntimeStateStore } from './runtime-state';
import { config } from './runtime-state/config';
import { CrossProcessLock } from './utils/cross-process-lock';

import type { ApiServer } from './api-server';
import type { TunnelManager } from './tunnel-manager';

export class SharedServiceController {
	constructor(
		private readonly api: ApiServer,
		private readonly tunnel: TunnelManager,
		private readonly windowId: string,
		private readonly isActive: () => boolean
	) {}

	/** Execute in the requesting window so an old leader cannot relaunch its old bundle. */
	async run(action: DashboardAction): Promise<void> {
		const release = await CrossProcessLock.acquire('commands.lock', config.locks.commandsTimeoutMs);
		try {
			if (!this.isActive()) throw new Error('This Ungate window has closed.');
			if (action === 'restart-services') {
				const existingPort = RuntimeStateStore.read().api.port;
				if (existingPort) {
					// A failed probe is not evidence that a process is ours: ApiServer.stop re-authenticates it.
					const health = await readApiHealth(existingPort).catch(() => null);
					if (health) {
						const state = describeService(health);
						if (state.status === 'incompatible' && !state.canUpdate) throw new Error(state.message!);
					}
				}
			}
			await RuntimeStateStore.touchClient(this.windowId);
			await RuntimeStateStore.mutate((state) => {
				state.api.ownerWindowId = this.windowId;

				return state;
			});
			if (action === 'stop-services') {
				// Suppress auto-start before stopping either service, including other windows.
				await RuntimeStateStore.mutate((state) => {
					state.api.startSuppressed = true;

					return state;
				});
				await this.tunnel.stop();
				await this.api.stop();

				return;
			}
			if (action === 'stop-tunnel') {
				await this.tunnel.stop();

				return;
			}
			if (action === 'restart-services') {
				const previous = RuntimeStateStore.read();
				await this.api.restart();
				const port = this.api.getPort();
				// A same-port, same-protocol API upgrade does not restart cloudflared or replace its URL.
				if (port && previous.tunnel.status === 'running') {
					const protocol = await readTunnelProtocol(port);
					if (previous.tunnel.port !== port || (previous.tunnel.protocol ?? 'http2') !== protocol)
						await this.tunnel.restart(port, protocol);
				}

				return;
			}
			if (action === 'start-tunnel' || action === 'restart-tunnel') {
				const state = RuntimeStateStore.read();
				if (state.api.startSuppressed || !state.api.port) await this.api.restart();
				else await this.api.start();
				const port = this.api.getPort() ?? RuntimeStateStore.read().api.port;
				if (!port) throw new Error('Ungate API is not ready.');
				const snapshot = await readApiHealth(port);
				const health = describeService(snapshot);
				if (health.status !== 'ready') throw new Error(health.message!);
				const protocol = await readTunnelProtocol(port);
				if (action === 'restart-tunnel') await this.tunnel.restart(port, protocol);
				else await this.tunnel.start(port, protocol);

				return;
			}
			throw new Error('Unknown service action');
		} finally {
			release();
		}
	}
}
