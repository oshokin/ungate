import {
	describeService,
	getAdminToken,
	isTunnelProtocol,
	type ApiHealth,
	type AppSettings,
	type TunnelProtocol
} from '@ungate/shared';

import { config } from './runtime-state/config';

/** Identity checks do not trust the PID stored on disk or any arbitrary listener. */
export async function readApiHealth(port: number, signal?: AbortSignal): Promise<ApiHealth> {
	const request = (path: string, authenticated = false) =>
		fetch(`http://127.0.0.1:${port}${path}`, {
			headers: authenticated ? { Authorization: `Bearer ${getAdminToken()}` } : undefined,
			signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(config.apiServer.portHealthRequestTimeoutMs)])
				: AbortSignal.timeout(config.apiServer.portHealthRequestTimeoutMs),
			redirect: 'error'
		});
	let response = await request('/health');
	if (!response.ok) throw new Error(`API health: HTTP ${response.status}`);
	let raw: unknown = await response.json();
	if (
		raw &&
		typeof raw === 'object' &&
		(raw as Record<string, unknown>).service === 'ungate' &&
		!Number.isInteger((raw as Record<string, unknown>).pid)
	) {
		response = await request('/admin/health', true);
		if (!response.ok) throw new Error(`API health: HTTP ${response.status}`);
		raw = await response.json();
	}
	if (!raw || typeof raw !== 'object') throw new Error('Unknown service on the Ungate port');
	const health = raw as Record<string, unknown>;
	if (health.service !== 'ungate' || !Number.isInteger(health.pid) || Number(health.pid) <= 0)
		throw new Error('Unknown service on the Ungate port');

	return {
		service: 'ungate',
		pid: Number(health.pid),
		version: typeof health.version === 'string' ? health.version : null,
		protocolVersion: typeof health.protocolVersion === 'number' ? health.protocolVersion : null
	};
}

export async function readTunnelProtocol(port: number): Promise<TunnelProtocol> {
	const raw = await readAdminJson<unknown>(port, '/settings');
	const protocol = raw && typeof raw === 'object' ? (raw as { tunnelProtocol?: unknown }).tunnelProtocol : null;
	if (!isTunnelProtocol(protocol)) throw new Error('Saved tunnel protocol is invalid.');

	return protocol;
}

async function readAdminJson<T>(port: number, path: string): Promise<T> {
	const response = await fetch(`http://127.0.0.1:${port}${path}`, {
		headers: { Authorization: `Bearer ${getAdminToken()}` },
		redirect: 'error',
		signal: AbortSignal.timeout(config.apiServer.adminRequestTimeoutMs)
	});
	if (!response.ok) throw new Error(`Cannot read ${path}: HTTP ${response.status}`);
	const raw: unknown = await response.json();
	const value = raw as T;

	return value;
}

export function readAppSettings(port: number): Promise<AppSettings> {
	return readAdminJson<AppSettings>(port, '/settings');
}

export async function assertCompatibleApi(port: number, signal?: AbortSignal): Promise<void> {
	const health = await readApiHealth(port, signal);
	const state = describeService(health);
	if (state.status !== 'ready') throw new Error(state.message ?? 'Incompatible Ungate API');
}
