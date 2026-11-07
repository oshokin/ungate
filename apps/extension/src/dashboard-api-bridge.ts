import {
	dashboardRequestSchema,
	DASHBOARD_TRANSPORT,
	describeService,
	getAdminToken,
	LOOPBACK_HOST,
	sleep,
	type DashboardResponse,
	type ServiceState
} from '@ungate/shared';

import { readApiHealth } from './local-api';

import type { UsageController } from './usage-controller';

/** HTTP belongs to the local extension host; webviews communicate only by messages. */
export class DashboardApiBridge {
	private readonly controllers = new Set<AbortController>();
	private disposed = false;

	constructor(
		private readonly getPort: () => number | null,
		private readonly send: (message: DashboardResponse) => void,
		private readonly expectedArtifactDigest?: string,
		private readonly usage?: UsageController,
		private readonly onServiceState?: (state: ServiceState) => void,
		private readonly getExpectedArtifactDigest?: () => string | undefined
	) {}

	async handle(message: unknown): Promise<void> {
		const parsed = dashboardRequestSchema.safeParse(message);
		if (!parsed.success || this.disposed) return;
		const { id, method, path, body } = parsed.data;
		if (this.usage && path.startsWith('/usage')) {
			try {
				if (path === '/usage/preferences' && method === 'POST') {
					const patch = body as Record<string, unknown>;
					const keys = ['autoRefresh', 'intervalSeconds', 'widgets.claude', 'widgets.openai', 'widgets.minimax'];
					if (
						!patch ||
						typeof patch !== 'object' ||
						Object.entries(patch).some(
							([key, value]) =>
								!keys.includes(key) ||
								(key === 'intervalSeconds'
									? !Number.isInteger(value) || Number(value) < 15 || Number(value) > 3600
									: typeof value !== 'boolean')
						)
					)
						throw new Error('Invalid usage preferences');
					await this.usage.savePreferences(patch);
				}
				const state = path === '/usage/preferences' ? null : await this.usage.load(method === 'POST');
				if (state?.error) throw new Error(state.error);
				const result = path === '/usage/preferences' ? this.usage.state.preferences : state?.data;
				this.send({ type: 'api-response', id, status: 200, body: result });
			} catch (error) {
				this.send({ type: 'api-response', id, status: 503, error: error instanceof Error ? error.message : String(error) });
			}

			return;
		}
		if (this.controllers.size >= DASHBOARD_TRANSPORT.maxConcurrentRequests) {
			this.send({ type: 'api-response', id, status: 429, error: 'Too many dashboard operations. Retry shortly.' });

			return;
		}
		const controller = new AbortController();
		this.controllers.add(controller);
		const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(DASHBOARD_TRANSPORT.requestTimeoutMs)]);
		try {
			const encoded = method === 'POST' ? JSON.stringify(body ?? {}) : undefined;
			if (encoded && Buffer.byteLength(encoded) > DASHBOARD_TRANSPORT.maxRequestBytes)
				throw new Error('Dashboard request is too large');
			let port = this.getPort();
			while (!port) {
				await sleep(DASHBOARD_TRANSPORT.portPollIntervalMs, signal);
				port = this.getPort();
			}
			if (path !== '/health') {
				const state = describeService(
					await readApiHealth(port, signal),
					this.getExpectedArtifactDigest ? this.getExpectedArtifactDigest() : this.expectedArtifactDigest
				);
				this.onServiceState?.(state);
				// The saved key is unchanged by a same-release rebuild. Reading it must not wait for the restart.
				const savedKeyRead = method === 'GET' && path === '/settings' && state.restartRequired === true;
				if (state.status !== 'ready' && !savedKeyRead) throw new Error(state.message ?? 'Incompatible Ungate API');
			}
			const response = await fetch(`http://${LOOPBACK_HOST}:${port}${path}`, {
				method,
				body: encoded,
				signal,
				redirect: 'error',
				headers: { Authorization: `Bearer ${getAdminToken()}`, ...(encoded ? { 'Content-Type': 'application/json' } : {}) }
			});
			const result: unknown = await response.json();
			if (method === 'POST' && path.startsWith('/auth/')) this.usage?.invalidate();
			if (!this.disposed) this.send({ type: 'api-response', id, status: response.status, body: result });
		} catch (error) {
			if (!this.disposed)
				this.send({
					type: 'api-response',
					id,
					status: 503,
					error: signal.aborted
						? 'Ungate API did not respond in time. Open Logs and retry.'
						: `Unable to reach the local Ungate API (${method} ${path}). ${error instanceof Error ? error.message : 'Request failed'}`
				});
		} finally {
			this.controllers.delete(controller);
		}
	}

	dispose(): void {
		this.disposed = true;
		for (const controller of this.controllers) controller.abort();
		this.controllers.clear();
	}
}
