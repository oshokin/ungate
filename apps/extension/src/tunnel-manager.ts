import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as path from 'node:path';

import { isTunnelProtocol, sleep, type TunnelProtocol } from '@ungate/shared';

import { RuntimeStateStore } from './runtime-state';
import { config } from './runtime-state/config';
import { CLOUDFLARED_VERSION, CloudflaredInstaller } from './utils/cloudflared-installer';
import { CrossProcessLock } from './utils/cross-process-lock';
import { getCloudflaredBinPath, ManagedProcess } from './utils/managed-process';

export { getCloudflaredBinPath } from './utils/managed-process';

import type { LogEntry, TunnelState } from '@ungate/shared/frontend';

const TUNNEL_STOP_GRACE_MS = 2000;
const TUNNEL_STOP_DEADLINE_MS = 10000;
const PUBLIC_PROBE_INTERVAL_MS = 5000;
const PUBLIC_PROBE_TIMEOUT_MS = 3000;
const PUBLIC_PROBE_FAILURE_THRESHOLD = 3;
const TRANSIENT_DNS_ERRORS = new Set(['EAI_AGAIN', 'ENOTFOUND']);

function errorCode(error: unknown): string | null {
	let current = error;
	for (let depth = 0; current && depth < 3; depth += 1) {
		if (typeof current !== 'object') return null;
		const candidate = current as { cause?: unknown; code?: unknown };
		if (typeof candidate.code === 'string') return candidate.code;
		current = candidate.cause;
	}

	return null;
}

function errorMessage(error: unknown): string {
	const code = errorCode(error);
	const message = error instanceof Error ? error.message : String(error);

	return code ? `${message} (${code})` : message;
}

async function fetchQuickTunnelHealth(url: string): Promise<unknown> {
	const target = new URL('/health', url);
	if (!target.hostname.endsWith('.trycloudflare.com'))
		throw new Error('Public health DNS fallback is not allowed for this host.');
	const resolver = new Resolver();
	resolver.setServers(['1.1.1.1', '8.8.8.8']);
	const [address] = await resolver.resolve4(target.hostname);
	if (!address) throw new Error('Public health DNS fallback returned no address.');

	return await new Promise((resolve, reject) => {
		const request = https.request(
			{
				hostname: address,
				port: 443,
				path: target.pathname,
				method: 'GET',
				servername: target.hostname,
				headers: { host: target.hostname },
				timeout: PUBLIC_PROBE_TIMEOUT_MS
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on('data', (chunk: Buffer) => chunks.push(chunk));
				response.on('end', () => {
					if (response.statusCode !== 200) {
						reject(new Error(`Public health returned HTTP ${response.statusCode ?? 'unknown'}.`));

						return;
					}
					try {
						resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
					} catch (error) {
						reject(error instanceof Error ? error : new Error(String(error)));
					}
				});
			}
		);
		request.on('timeout', () => request.destroy(new Error('Public health DNS fallback timed out.')));
		request.on('error', reject);
		request.end();
	});
}

function isValidPublicHealth(raw: unknown): boolean {
	return (
		!!raw &&
		typeof raw === 'object' &&
		(raw as { service?: unknown }).service === 'ungate' &&
		(raw as { status?: unknown }).status === 'ok'
	);
}

export class TunnelManager {
	private monitor: NodeJS.Timeout | null = null;
	private monitorInFlight = false;
	private logOffset = 0;
	private observedLogPath: string | null = null;
	private lastPublicProbeAt = 0;
	private publicProbeInFlight = false;
	private publicProbeIdentity: string | null = null;
	private consecutivePublicProbeFailures = 0;

	constructor(
		private readonly windowId: string,
		private readonly isExtensionHostActive: () => boolean,
		private readonly onStateChange: (state: TunnelState) => void,
		private readonly onLog: (entry: LogEntry) => void
	) {}

	getState(): TunnelState {
		const state = RuntimeStateStore.read().tunnel;

		return {
			status: state.status,
			url: state.url,
			error: state.lastError,
			publicStatus: state.publicStatus ?? 'unchecked',
			publicCheckedAt: state.publicCheckedAt ?? null,
			publicError: state.publicError ?? null,
			startedAt: state.startedAt ?? null
		};
	}

	async start(port: number, protocol: TunnelProtocol = 'http2'): Promise<void> {
		const release = await CrossProcessLock.acquire('tunnel.lock', 120000);
		try {
			await this.startLocked(port, protocol);
		} finally {
			release();
		}
	}

	async stop(): Promise<void> {
		const release = await CrossProcessLock.acquire('tunnel.lock', 120000);
		try {
			await this.stopLocked();
		} finally {
			release();
		}
	}

	async restart(port: number, protocol: TunnelProtocol = 'http2'): Promise<void> {
		const release = await CrossProcessLock.acquire('tunnel.lock', 120000);
		try {
			await this.stopLocked();
			await this.startLocked(port, protocol);
		} finally {
			release();
		}
	}

	/** Attach to the existing process; no parent window needs to remain open. */
	syncMonitor(isLeader: boolean): void {
		if (!isLeader || !this.isExtensionHostActive()) {
			if (this.monitor) clearInterval(this.monitor);
			this.monitor = null;

			return;
		}
		this.monitor ??= setInterval(() => {
			void this.runMonitorCycle();
		}, 1000);
		void this.runMonitorCycle();
	}

	/** Drop a displayed tunnel whose process has exited or no longer matches its launch. */
	async reconcile(): Promise<void> {
		const current = RuntimeStateStore.read().tunnel;
		if (current.status !== 'running' && current.status !== 'starting') return;
		const executable = getCloudflaredBinPath();
		const pid = current.pid;
		if (pid && ManagedProcess.matches(pid, executable, current.logPath)) {
			await this.probePublicHealth();

			return;
		}
		const identityChanged = !!pid && ManagedProcess.isAlive(pid);
		await RuntimeStateStore.mutate((state) => {
			if (state.tunnel.pid !== pid || (state.tunnel.status !== 'running' && state.tunnel.status !== 'starting')) return state;
			if (pid && ManagedProcess.matches(pid, executable, state.tunnel.logPath)) return state;
			state.tunnel = {
				status: identityChanged ? 'error' : 'stopped',
				url: null,
				publicStatus: 'unchecked',
				publicCheckedAt: null,
				publicError: null,
				lastError: identityChanged
					? 'Tunnel process identity changed. No tunnel is running.'
					: 'The tunnel process stopped. Start it again and copy the new URL into Cursor.',
				lastSeenAt: Date.now(),
				ownerWindowId: null
			};

			return state;
		});
		this.onStateChange(this.getState());
	}

	private async startLocked(port: number, protocol: TunnelProtocol): Promise<void> {
		if (!isTunnelProtocol(protocol)) throw new Error('Tunnel protocol must be http2, quic, or auto.');
		const previous = RuntimeStateStore.read().tunnel;
		if (ManagedProcess.matches(previous.pid, getCloudflaredBinPath(), previous.logPath)) {
			if (previous.port === port && previous.url && (previous.protocol ?? 'http2') === protocol) {
				await this.setState({ status: 'running', url: previous.url, error: null });

				return;
			}
			await this.stopLocked();
		} else if (previous.pid && ManagedProcess.isAlive(previous.pid)) {
			throw new Error(
				'Saved tunnel PID belongs to an unverified process. No process was stopped and no duplicate tunnel was started.'
			);
		}
		await this.setState({ status: 'installing', url: null, error: null });
		const binary = getCloudflaredBinPath();
		let spawned: { pid: number; logPath: string } | null = null;
		try {
			if (!CloudflaredInstaller.isPinnedInstall(binary)) {
				this.log(`Downloading cloudflared ${CLOUDFLARED_VERSION}...`);
				await CloudflaredInstaller.install(binary);
			}
			const logPath = path.join(config.baseDir, `tunnel-${randomUUID()}.log`);
			fs.writeFileSync(logPath, '', { mode: 0o600, flag: 'wx' });
			const child = spawn(
				binary,
				[
					'tunnel',
					'--url',
					`http://127.0.0.1:${port}`,
					'--config',
					process.platform === 'win32' ? 'NUL' : '/dev/null',
					'--no-autoupdate',
					'--edge-ip-version',
					'4',
					'--protocol',
					protocol,
					'--logfile',
					logPath
				],
				{ detached: true, stdio: 'ignore', windowsHide: true }
			);
			await new Promise<void>((resolve, reject) => {
				child.once('spawn', resolve);
				child.once('error', reject);
			});
			if (!child.pid) throw new Error('cloudflared did not report a process ID.');
			spawned = { pid: child.pid, logPath };
			child.unref();
			await RuntimeStateStore.mutate((current) => {
				current.tunnel = {
					...current.tunnel,
					pid: child.pid,
					logPath,
					port,
					protocol,
					startedAt: Date.now(),
					ownerWindowId: this.windowId,
					status: 'starting',
					url: null,
					publicStatus: 'unchecked',
					publicCheckedAt: null,
					publicError: null,
					lastError: null,
					lastSeenAt: Date.now()
				};

				return current;
			});
			const deadline = Date.now() + 45000;
			while (Date.now() < deadline) {
				const log = fs.readFileSync(logPath, 'utf8');
				const url = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(log)?.[0];
				if (url && log.includes('Registered tunnel connection')) {
					await this.setState({
						status: 'running',
						url,
						error: null,
						publicStatus: 'checking',
						publicCheckedAt: null,
						publicError: null
					});
					this.syncMonitor(true);
					void this.probePublicHealth(true);

					return;
				}
				if (!child.pid || !ManagedProcess.matches(child.pid, binary, logPath))
					throw new Error('cloudflared exited before connecting. See tunnel logs.');
				await sleep(200);
			}
			throw new Error('Tunnel did not connect within 45 seconds. Check VPN/firewall access to TCP port 7844.');
		} catch (error) {
			this.pollLogs();
			const message = error instanceof Error ? error.message : String(error);
			if (spawned && ManagedProcess.matches(spawned.pid, binary, spawned.logPath)) {
				await this.stopVerifiedProcess(spawned.pid, spawned.logPath);
			}
			await RuntimeStateStore.mutate((current) => {
				const stillAlive = spawned ? ManagedProcess.isAlive(spawned.pid) : false;
				current.tunnel = {
					status: 'error',
					url: null,
					publicStatus: 'unchecked',
					publicCheckedAt: null,
					publicError: null,
					lastError: stillAlive ? `${message} The process remains alive and requires manual verification.` : message,
					lastSeenAt: Date.now(),
					ownerWindowId: null,
					...(stillAlive && spawned ? { pid: spawned.pid, logPath: spawned.logPath, port, protocol } : {})
				};

				return current;
			});
			this.onStateChange(this.getState());
			throw error;
		}
	}

	private async stopLocked(): Promise<void> {
		const state = RuntimeStateStore.read().tunnel;
		if (state.pid && ManagedProcess.isAlive(state.pid)) {
			if (!ManagedProcess.matches(state.pid, getCloudflaredBinPath(), state.logPath))
				throw new Error('Tunnel process identity changed. Refusing to stop an unrelated process.');
			await this.stopVerifiedProcess(state.pid, state.logPath);
		}
		await RuntimeStateStore.mutate((current) => {
			current.tunnel = {
				status: 'stopped',
				url: null,
				publicStatus: 'unchecked',
				publicCheckedAt: null,
				publicError: null,
				lastError: null,
				lastSeenAt: Date.now(),
				ownerWindowId: null
			};

			return current;
		});
		this.rotateLogs();
		this.onStateChange(this.getState());
	}

	private async setState(state: TunnelState): Promise<void> {
		await RuntimeStateStore.mutate((current) => {
			Object.assign(current.tunnel, {
				status: state.status,
				url: state.url,
				lastError: state.error,
				publicStatus: state.publicStatus,
				publicCheckedAt: state.publicCheckedAt,
				publicError: state.publicError,
				lastSeenAt: Date.now(),
				ownerWindowId: this.windowId
			});

			return current;
		});
		this.onStateChange(state);
	}

	private async stopVerifiedProcess(pid: number, logPath: string | undefined): Promise<void> {
		const executable = getCloudflaredBinPath();
		const verified = (): boolean => ManagedProcess.matches(pid, executable, logPath);
		this.signal(pid, 'SIGTERM');
		const forceAt = Date.now() + TUNNEL_STOP_GRACE_MS;
		const deadline = Date.now() + TUNNEL_STOP_DEADLINE_MS;
		let forced = false;
		while (verified()) {
			if (!forced && Date.now() >= forceAt) {
				this.signal(pid, 'SIGKILL');
				forced = true;
			}
			if (Date.now() > deadline) throw new Error('Tunnel did not stop. No replacement started.');
			await sleep(100);
		}
	}

	private signal(pid: number, signal: NodeJS.Signals): void {
		try {
			process.kill(pid, signal);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
		}
	}

	private async runMonitorCycle(): Promise<void> {
		if (this.monitorInFlight) return;
		this.monitorInFlight = true;
		try {
			await this.reconcile();
			this.pollLogs();
		} finally {
			this.monitorInFlight = false;
		}
	}

	private pollLogs(): void {
		const logPath = RuntimeStateStore.read().tunnel.logPath;
		if (!logPath) return;
		if (this.observedLogPath !== logPath) {
			this.observedLogPath = logPath;
			this.logOffset = 0;
		}
		try {
			const size = fs.statSync(logPath).size;
			const start = Math.max(this.logOffset, size - 65536);
			const bytes = Buffer.alloc(Math.max(0, size - start));
			const fd = fs.openSync(logPath, 'r');
			try {
				fs.readSync(fd, bytes, 0, bytes.length, start);
			} finally {
				fs.closeSync(fd);
			}
			this.logOffset = size;
			for (const line of bytes
				.toString('utf8')
				.split('\n')
				.filter((line) => line.trim()))
				this.log(line);
		} catch {
			/* Process has not created its log yet. */
		}
	}

	private async probePublicHealth(force = false): Promise<void> {
		const now = Date.now();
		if (this.publicProbeInFlight || (!force && now - this.lastPublicProbeAt < PUBLIC_PROBE_INTERVAL_MS)) return;
		const tunnel = RuntimeStateStore.read().tunnel;
		if (tunnel.status !== 'running' || !tunnel.url || !tunnel.pid || !tunnel.startedAt) return;
		const identity = { pid: tunnel.pid, startedAt: tunnel.startedAt, url: tunnel.url };
		const identityKey = `${identity.pid}:${identity.startedAt}:${identity.url}`;
		if (this.publicProbeIdentity !== identityKey) {
			this.publicProbeIdentity = identityKey;
			this.consecutivePublicProbeFailures = 0;
		}
		this.publicProbeInFlight = true;
		this.lastPublicProbeAt = now;
		try {
			const response = await fetch(`${identity.url}/health`, {
				redirect: 'error',
				signal: AbortSignal.timeout(PUBLIC_PROBE_TIMEOUT_MS)
			});
			const raw: unknown = response.ok ? await response.json() : null;
			await this.commitPublicProbe(identity, isValidPublicHealth(raw) ? null : `Public health returned HTTP ${response.status}.`);
		} catch (error) {
			const code = errorCode(error);
			if (code && TRANSIENT_DNS_ERRORS.has(code)) {
				try {
					const raw = await fetchQuickTunnelHealth(identity.url);
					await this.commitPublicProbe(identity, isValidPublicHealth(raw) ? null : 'Public health returned an invalid response.');
				} catch (fallbackError) {
					await this.commitPublicProbe(identity, errorMessage(fallbackError), false);
				}
			} else await this.commitPublicProbe(identity, errorMessage(error));
		} finally {
			this.publicProbeInFlight = false;
		}
	}

	private async commitPublicProbe(
		identity: { pid: number; startedAt: number; url: string },
		error: string | null,
		countFailure = true
	): Promise<void> {
		if (error && countFailure) this.consecutivePublicProbeFailures += 1;
		else this.consecutivePublicProbeFailures = 0;
		const publicStatus =
			error && countFailure && this.consecutivePublicProbeFailures >= PUBLIC_PROBE_FAILURE_THRESHOLD
				? 'unreachable'
				: error
					? 'checking'
					: 'reachable';
		let changed = false;
		await RuntimeStateStore.mutate((current) => {
			if (
				current.tunnel.pid !== identity.pid ||
				current.tunnel.startedAt !== identity.startedAt ||
				current.tunnel.url !== identity.url ||
				current.tunnel.status !== 'running'
			)
				return current;
			changed = current.tunnel.publicStatus !== publicStatus || current.tunnel.publicError !== error;
			current.tunnel.publicStatus = publicStatus;
			current.tunnel.publicCheckedAt = Date.now();
			current.tunnel.publicError = error;

			return current;
		});
		if (changed) this.onStateChange(this.getState());
	}

	private log(message: string): void {
		this.onLog({ timestamp: Date.now(), level: 'info', message });
	}

	private rotateLogs(): void {
		const active = RuntimeStateStore.read().tunnel.logPath;
		const logs = fs
			.readdirSync(config.baseDir)
			.filter((name) => name.startsWith('tunnel-') && name.endsWith('.log'))
			.map((name) => path.join(config.baseDir, name))
			.filter((file) => file !== active)
			.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
		for (const file of logs.slice(5)) fs.rmSync(file, { force: true });
	}
}
