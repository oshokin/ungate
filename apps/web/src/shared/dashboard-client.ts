import { DASHBOARD_TRANSPORT } from '@ungate/shared/frontend';

import { postExtensionMessage } from './vscode';

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class DashboardClient {
	private static readonly pending = new Map<string, Pending>();
	static {
		window.addEventListener('message', (event: MessageEvent<unknown>) => {
			const message = event.data;
			if (
				!message ||
				typeof message !== 'object' ||
				!('type' in message) ||
				message.type !== 'api-response' ||
				!('id' in message) ||
				typeof message.id !== 'string'
			)
				return;
			const operation = this.pending.get(message.id);
			if (!operation) return;
			this.pending.delete(message.id);
			clearTimeout(operation.timer);
			const result = message as { status?: number; body?: unknown; error?: string };
			if (typeof result.status === 'number' && result.status >= 200 && result.status < 300) operation.resolve(result.body);
			else {
				const body = result.body as { error?: unknown } | undefined;
				const detail = typeof body?.error === 'string' ? body.error : result.error;
				operation.reject(new Error(detail ?? `Ungate API returned HTTP ${result.status ?? 'unknown'}. Open Logs for details.`));
			}
		});
	}

	static request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
		const id = crypto.randomUUID();

		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error('The dashboard could not contact Ungate. Reload the panel or open Logs.'));
			}, DASHBOARD_TRANSPORT.clientTimeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			if (!postExtensionMessage({ type: 'api-request', id, method, path, ...(body === undefined ? {} : { body }) })) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(new Error('Open the Ungate dashboard inside Cursor.'));
			}
		}) as Promise<T>;
	}
}
