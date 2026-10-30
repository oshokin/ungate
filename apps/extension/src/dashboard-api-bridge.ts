import { dashboardRequestSchema, DASHBOARD_TRANSPORT, getAdminToken, sleep, type DashboardResponse } from '@ungate/shared';

import { assertCompatibleApi } from './local-api';

/** HTTP belongs to the local extension host; webviews communicate only by messages. */
export class DashboardApiBridge {
	private readonly controllers = new Set<AbortController>();
	private disposed = false;

	constructor(
		private readonly getPort: () => number | null,
		private readonly send: (message: DashboardResponse) => void
	) {}

	async handle(message: unknown): Promise<void> {
		const parsed = dashboardRequestSchema.safeParse(message);
		if (!parsed.success || this.disposed) return;
		const { id, method, path, body } = parsed.data;
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
			if (path !== '/health') await assertCompatibleApi(port, signal);
			const response = await fetch(`http://127.0.0.1:${port}${path}`, {
				method,
				body: encoded,
				signal,
				redirect: 'error',
				headers: { Authorization: `Bearer ${getAdminToken()}`, ...(encoded ? { 'Content-Type': 'application/json' } : {}) }
			});
			const result: unknown = await response.json();
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
