import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as path from 'node:path';

import {
	isTunnelProtocol,
	LOOPBACK_HOST,
	MILLISECONDS_PER_SECOND,
	PRIVATE_FILE_MODE,
	QUICK_TUNNEL_CONFIG,
	QUICK_TUNNEL_CONFIG_NAME,
	sleep,
	type TunnelProtocol
} from '@ungate/shared';

import { tunnelConnectTimeoutMs } from './dashboard-settings';
import { ngrokFailure, redactNgrokToken } from './ngrok-failure';
import { NgrokTokenStore, UnavailableNgrokSecrets } from './ngrok-token-store';
import { NgrokUrl } from './ngrok-url';
import { RuntimeStateStore } from './runtime-state';
import { config } from './runtime-state/config';
import { CLOUDFLARED_VERSION, CloudflaredInstaller } from './utils/cloudflared-installer';
import { isRoutineNgrokConnection, parseCloudflaredLogLine } from './utils/cloudflared-log';
import { CrossProcessLock } from './utils/cross-process-lock';
import { capAppendOnlyLog, LogFileReader } from './utils/log-file-reader';
import { getCloudflaredBinPath, ManagedProcess } from './utils/managed-process';
import { getNgrokBinPath, NGROK_VERSION, NgrokInstaller } from './utils/ngrok-installer';

export { getCloudflaredBinPath } from './utils/managed-process';

import type { LogEntry, TunnelState } from '@ungate/shared/frontend';

/** SIGTERM grace before the tunnel process is killed. */
const TUNNEL_STOP_GRACE_MS = 2000;
/** Final wait for cloudflared to exit after stop is requested. */
const TUNNEL_STOP_DEADLINE_MS = 10000;
/** How often the public tunnel URL is probed after connect. */
const PUBLIC_PROBE_INTERVAL_MS = 5000;
/** One public probe must finish within this time. */
const PUBLIC_PROBE_TIMEOUT_MS = 3000;
const PUBLIC_HEALTH_MAX_BYTES = 64 * 1024;
/** Consecutive probe failures before the tunnel is reported down. */
const PUBLIC_PROBE_FAILURE_THRESHOLD = 3;
/** HTTPS port used when a public probe connects to a resolved address. */
const HTTPS_PORT = 443;
/** Cloudflare quick-tunnel edge port named when a start times out. */
const CLOUDFLARE_EDGE_PORT = 7844;
/** Public resolvers tried after a local DNS failure. */
const PUBLIC_DNS_RESOLVERS = ['1.1.1.1', '8.8.8.8'] as const;
/** Local DNS failures. The public resolver gets the next attempt, and repeated misses count toward the tunnel being down. */
const TRANSIENT_DNS_ERRORS = new Set(['EAI_AGAIN', 'ENOTFOUND']);
/** Bound traversal of nested network errors, including cyclic causes. */
const MAX_ERROR_CAUSE_DEPTH = 3;

function errorCode(error: unknown): string | null {
	let current = error;
	for (let depth = 0; current && depth < MAX_ERROR_CAUSE_DEPTH; depth += 1) {
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

/** Node reports a failed IPv4 lookup as "queryA ENOTFOUND <host>". The status bar shows a plain sentence instead. */
function publicDnsFailureMessage(error: unknown): string {
	const code = errorCode(error);
	if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Tunnel address does not resolve. Restart the tunnel.';

	return errorMessage(error);
}

async function fetchQuickTunnelHealth(url: string): Promise<unknown> {
	const target = new URL('/health', url);
	if (!target.hostname.endsWith('.trycloudflare.com'))
		throw new Error('Public health DNS fallback is not allowed for this host.');
	const resolver = new Resolver();
	resolver.setServers([...PUBLIC_DNS_RESOLVERS]);
	const [address] = await resolver.resolve4(target.hostname);
	if (!address) throw new Error('Public health DNS fallback returned no address.');

	return await new Promise((resolve, reject) => {
		const request = https.request(
			{
				hostname: address,
				port: HTTPS_PORT,
				path: target.pathname,
				method: 'GET',
				servername: target.hostname,
				headers: { host: target.hostname },
				timeout: PUBLIC_PROBE_TIMEOUT_MS
			},
			(response) => {
				const chunks: Buffer[] = [];
				let received = 0;
				const tooLarge = (): void => {
					const error = new Error(`Public health response exceeds ${PUBLIC_HEALTH_MAX_BYTES}-byte size limit.`);
					reject(error);
					response.destroy();
					request.destroy(error);
				};
				response.on('error', reject);
				if (Number(response.headers['content-length']) > PUBLIC_HEALTH_MAX_BYTES) {
					tooLarge();

					return;
				}
				response.on('data', (chunk: Buffer) => {
					received += chunk.length;
					if (received > PUBLIC_HEALTH_MAX_BYTES) tooLarge();
					else chunks.push(chunk);
				});
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
	private generation = 0;
	private activeNgrokToken: string | null = null;
	private monitor: NodeJS.Timeout | null = null;
	private monitorInFlight = false;
	private readonly logReader = new LogFileReader();
	private lastPublicProbeAt = 0;
	private publicProbeInFlight = false;
	private publicProbeIdentity: string | null = null;
	private consecutivePublicProbeFailures = 0;

	constructor(
		private readonly windowId: string,
		private readonly isExtensionHostActive: () => boolean,
		private readonly onStateChange: (state: TunnelState) => void,
		private readonly onLog: (entry: LogEntry) => void,
		private readonly ngrokToken: NgrokTokenStore = new NgrokTokenStore(new UnavailableNgrokSecrets())
	) {}

	getState(): TunnelState {
		const state = RuntimeStateStore.read().tunnel;
		const executable = this.matchedExecutable(state.pid, state.logPath);

		return {
			status: state.status,
			provider: executable === getNgrokBinPath() ? 'ngrok' : executable === getCloudflaredBinPath() ? 'quick' : null,
			url: state.url,
			error: state.lastError,
			publicStatus: state.publicStatus ?? 'unchecked',
			publicCheckedAt: state.publicCheckedAt ?? null,
			publicError: state.publicError ?? null,
			startedAt: state.startedAt ?? null
		};
	}

	async start(port: number, protocol: TunnelProtocol = 'http2'): Promise<void> {
		const release = await CrossProcessLock.acquire('tunnel.lock', config.locks.startupTimeoutMs);
		try {
			await this.startLocked(port, protocol);
		} finally {
			release();
		}
	}

	/** Preference and replacement share the same cross-window lifecycle lock. */
	async selectProvider(
		provider: 'quick' | 'ngrok',
		confirm: () => Promise<boolean>,
		protocol: (port: number) => Promise<TunnelProtocol>,
		acknowledgeSelection: () => Promise<void> = async () => {}
	): Promise<void> {
		const release = await CrossProcessLock.acquire('tunnel.lock', config.locks.startupTimeoutMs);
		try {
			const before = structuredClone(RuntimeStateStore.read());
			if (before.tunnelProvider === provider) return;
			const live = ['running', 'starting', 'installing'].includes(before.tunnel.status);
			if (live) {
				const confirmed = await confirm();
				if (!confirmed) return;
			}
			const current = RuntimeStateStore.read();
			// Older windows may not honor this lock. Never replace a different launch
			// or resurrect a tunnel stopped while its confirmation was open.
			if (
				current.tunnelProvider !== before.tunnelProvider ||
				current.tunnel.pid !== before.tunnel.pid ||
				current.tunnel.logPath !== before.tunnel.logPath ||
				current.tunnel.status !== before.tunnel.status
			)
				return;
			if (live) await this.refuseNgrokWithoutToken(provider);
			await RuntimeStateStore.mutate((state) => {
				state.tunnelProvider = provider;

				return state;
			});
			await acknowledgeSelection();
			if (live && current.tunnel.port) {
				const selectedProtocol = await protocol(current.tunnel.port);
				const latest = RuntimeStateStore.read().tunnel;
				if (
					latest.pid !== before.tunnel.pid ||
					latest.logPath !== before.tunnel.logPath ||
					latest.status !== before.tunnel.status
				)
					return;
				await this.startLocked(current.tunnel.port, selectedProtocol, provider);
			}
		} finally {
			release();
		}
	}

	async stop(): Promise<void> {
		this.generation++;
		const release = await CrossProcessLock.acquire('tunnel.lock', config.locks.startupTimeoutMs);
		try {
			await this.stopLocked();
		} finally {
			release();
		}
	}

	async restart(port: number, protocol: TunnelProtocol = 'http2'): Promise<void> {
		this.generation++;
		const release = await CrossProcessLock.acquire('tunnel.lock', config.locks.startupTimeoutMs);
		try {
			const provider = RuntimeStateStore.read().tunnelProvider;
			await this.refuseNgrokWithoutToken(provider);
			await this.stopLocked();
			await this.startLocked(port, protocol, provider);
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
		}, config.tunnelManager.monitorIntervalMs);
		void this.runMonitorCycle();
	}

	/** Drop a displayed tunnel whose process has exited or no longer matches its launch. */
	async reconcile(): Promise<void> {
		const current = RuntimeStateStore.read().tunnel;
		if (current.status !== 'running' && current.status !== 'starting') return;
		const pid = current.pid;
		if (pid && this.matchedExecutable(pid, current.logPath)) {
			await this.probePublicHealth();

			return;
		}
		const identityChanged = !!pid && ManagedProcess.isAlive(pid);
		let failure: string | null = null;
		if (!identityChanged && current.logPath) {
			try {
				failure = ngrokFailure(fs.readFileSync(current.logPath, 'utf8').split('\n'));
				if (failure) failure = redactNgrokToken(failure, this.activeNgrokToken);
			} catch {
				/* A missing journal does not hide the stopped process. */
			}
		}
		await RuntimeStateStore.mutate((state) => {
			if (
				state.tunnel.pid !== pid ||
				state.tunnel.logPath !== current.logPath ||
				(state.tunnel.status !== 'running' && state.tunnel.status !== 'starting')
			)
				return state;
			if (pid && this.matchedExecutable(pid, state.tunnel.logPath)) return state;
			state.tunnel = {
				status: identityChanged || failure ? 'error' : 'stopped',
				url: null,
				publicStatus: 'unchecked',
				publicCheckedAt: null,
				publicError: null,
				lastError: identityChanged
					? 'Tunnel process identity changed. No tunnel is running.'
					: (failure ?? 'The tunnel process stopped. Start it again and copy the new URL into Cursor.'),
				lastSeenAt: Date.now(),
				ownerWindowId: null
			};

			return state;
		});
		this.onStateChange(this.getState());
	}

	private async startLocked(
		port: number,
		protocol: TunnelProtocol,
		provider: 'quick' | 'ngrok' = RuntimeStateStore.read().tunnelProvider === 'ngrok' ? 'ngrok' : 'quick'
	): Promise<void> {
		if (!isTunnelProtocol(protocol)) throw new Error('Tunnel protocol must be http2, quic, or auto.');
		const previous = RuntimeStateStore.read().tunnel;
		const wantedBin = provider === 'ngrok' ? getNgrokBinPath() : getCloudflaredBinPath();
		const otherBin = provider === 'ngrok' ? getCloudflaredBinPath() : getNgrokBinPath();
		if (ManagedProcess.matches(previous.pid, wantedBin, previous.logPath)) {
			const sameTunnel =
				previous.port === port &&
				previous.url &&
				(provider === 'ngrok' ||
					((previous.protocol ?? 'http2') === protocol &&
						ManagedProcess.matches(previous.pid, wantedBin, previous.logPath, port)));
			if (sameTunnel) {
				await this.setState({ status: 'running', url: previous.url, error: null });

				return;
			}
		} else if (
			previous.pid &&
			ManagedProcess.isAlive(previous.pid) &&
			!ManagedProcess.matches(previous.pid, otherBin, previous.logPath)
		) {
			throw new Error(
				'Saved tunnel PID belongs to an unverified process. No process was stopped and no duplicate tunnel was started.'
			);
		}
		await this.refuseNgrokWithoutToken(provider);
		if (
			ManagedProcess.matches(previous.pid, wantedBin, previous.logPath) ||
			ManagedProcess.matches(previous.pid, otherBin, previous.logPath)
		) {
			await this.stopLocked();
		}
		if (provider === 'ngrok') {
			await this.startNgrokLocked(port);

			return;
		}
		await this.setState({ status: 'installing', url: null, error: null });
		const generation = this.generation;
		const binary = getCloudflaredBinPath();
		let spawned: { pid: number; logPath: string } | null = null;
		try {
			if (!CloudflaredInstaller.isPinnedInstall(binary)) {
				this.log(`Downloading cloudflared ${CLOUDFLARED_VERSION}...`);
				await CloudflaredInstaller.install(binary);
			}
			if (generation !== this.generation) return;
			const logPath = path.join(config.baseDir, `tunnel-${randomUUID()}.log`);
			const configPath = path.join(config.baseDir, QUICK_TUNNEL_CONFIG_NAME);
			fs.writeFileSync(logPath, '', { mode: PRIVATE_FILE_MODE, flag: 'wx' });
			fs.writeFileSync(configPath, QUICK_TUNNEL_CONFIG, { mode: PRIVATE_FILE_MODE });
			const child = spawn(
				binary,
				[
					'tunnel',
					'--url',
					`http://${LOOPBACK_HOST}:${port}`,
					'--config',
					configPath,
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
			const timeoutMs = tunnelConnectTimeoutMs();
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				if (!child.pid || !ManagedProcess.matches(child.pid, binary, logPath))
					throw new Error('cloudflared exited before connecting. See tunnel logs.');
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
				await sleep(config.tunnelManager.startupPollIntervalMs);
			}
			throw new Error(
				`Tunnel did not connect within ${timeoutMs / MILLISECONDS_PER_SECOND} seconds. Check VPN/firewall access to TCP port ${CLOUDFLARE_EDGE_PORT}.`
			);
		} catch (error) {
			if (generation !== this.generation && !spawned) return;
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

	private async startNgrokLocked(port: number): Promise<void> {
		const generation = this.generation;
		const token = await this.ngrokToken.read();
		if (generation !== this.generation) return;
		if (!token) {
			const error = 'Add an ngrok authtoken before starting the stable tunnel.';
			await this.setState({ status: 'error', url: null, error });
			throw new Error(error);
		}
		await this.setState({ status: 'installing', url: null, error: null });
		this.activeNgrokToken = token;
		const binary = getNgrokBinPath();
		let spawned: { pid: number; logPath: string } | null = null;
		try {
			if (!NgrokInstaller.isPinnedInstall(binary)) {
				this.log(`Downloading ngrok ${NGROK_VERSION}...`);
				await NgrokInstaller.install(binary);
			}
			if (generation !== this.generation) return;
			const logPath = path.join(config.baseDir, `tunnel-${randomUUID()}.log`);
			fs.writeFileSync(logPath, '', { mode: PRIVATE_FILE_MODE, flag: 'wx' });
			// ngrok still writes plain ERROR lines to stderr in JSON mode. Keep
			// those in the launch journal without tying the process to this window.
			const stderr = fs.openSync(logPath, 'a');
			let child: ReturnType<typeof spawn>;
			try {
				child = spawn(binary, ['http', `http://${LOOPBACK_HOST}:${port}`, '--log', logPath, '--log-format', 'json'], {
					detached: true,
					stdio: ['ignore', 'ignore', stderr],
					windowsHide: true,
					env: { ...process.env, NGROK_AUTHTOKEN: token }
				});
			} finally {
				fs.closeSync(stderr);
			}
			await new Promise<void>((resolve, reject) => {
				child.once('spawn', resolve);
				child.once('error', reject);
			});
			if (!child.pid) throw new Error('ngrok did not report a process ID.');
			spawned = { pid: child.pid, logPath };
			child.unref();
			await RuntimeStateStore.mutate((current) => {
				current.tunnel = {
					...current.tunnel,
					pid: child.pid,
					logPath,
					port,
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
			const timeoutMs = tunnelConnectTimeoutMs();
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				const lines = fs.readFileSync(logPath, 'utf8').split('\n');
				// The journal publishes complete records only. A partial JSON record is
				// retried on the next poll, including a split UTF-8 code point.
				lines.pop();
				const failure = ngrokFailure(lines);
				if (!child.pid || !ManagedProcess.matches(child.pid, binary, logPath))
					throw new Error(failure ?? 'ngrok exited before connecting. See tunnel logs.');
				const url = lines.map((line) => NgrokUrl.read(line)).find((value) => value !== null);
				if (url) {
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
				await sleep(config.tunnelManager.startupPollIntervalMs);
			}
			throw new Error(
				ngrokFailure(fs.readFileSync(logPath, 'utf8').split('\n')) ??
					`ngrok did not connect within ${timeoutMs / MILLISECONDS_PER_SECOND} seconds.`
			);
		} catch (error) {
			if (generation !== this.generation && !spawned) return;
			this.pollLogs();
			const message = redactNgrokToken(error instanceof Error ? error.message : String(error), token);
			if (spawned && ManagedProcess.matches(spawned.pid, binary, spawned.logPath)) {
				await this.stopVerifiedProcess(spawned.pid, spawned.logPath, binary);
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
					...(stillAlive && spawned ? { pid: spawned.pid, logPath: spawned.logPath, port } : {})
				};

				return current;
			});
			this.onStateChange(this.getState());
			throw new Error(message);
		}
	}

	private async stopLocked(): Promise<void> {
		const state = RuntimeStateStore.read().tunnel;
		const executable = state.pid ? this.matchedExecutable(state.pid, state.logPath) : null;
		if (state.pid && ManagedProcess.isAlive(state.pid)) {
			if (!executable) throw new Error('Tunnel process identity changed. Refusing to stop an unrelated process.');
			await this.stopVerifiedProcess(state.pid, state.logPath, executable);
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
				...(state.publicStatus !== undefined ? { publicStatus: state.publicStatus } : {}),
				...(state.publicCheckedAt !== undefined ? { publicCheckedAt: state.publicCheckedAt } : {}),
				...(state.publicError !== undefined ? { publicError: state.publicError } : {}),
				lastSeenAt: Date.now(),
				ownerWindowId: this.windowId
			});

			return current;
		});
		this.onStateChange(this.getState());
	}

	/** A missing ngrok authtoken must fail before the live process is stopped. */
	private async refuseNgrokWithoutToken(provider = RuntimeStateStore.read().tunnelProvider): Promise<void> {
		if (provider !== 'ngrok') return;
		const token = await this.ngrokToken.read();
		if (token) return;
		const error = 'Add an ngrok authtoken before starting the stable tunnel.';
		const current = RuntimeStateStore.read().tunnel;
		if (!this.matchedExecutable(current.pid, current.logPath)) await this.setState({ status: 'error', url: null, error });
		throw new Error(error);
	}

	private matchedExecutable(pid: number | undefined, logPath: string | undefined): string | null {
		if (ManagedProcess.matches(pid, getCloudflaredBinPath(), logPath)) return getCloudflaredBinPath();
		if (ManagedProcess.matches(pid, getNgrokBinPath(), logPath)) return getNgrokBinPath();

		return null;
	}

	private async stopVerifiedProcess(
		pid: number,
		logPath: string | undefined,
		executable = getCloudflaredBinPath()
	): Promise<void> {
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
			await sleep(config.tunnelManager.stopPollIntervalMs);
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
		if (logPath)
			for (const line of this.logReader.read(logPath)) {
				if (!isRoutineNgrokConnection(line)) this.onLog(parseCloudflaredLogLine(redactNgrokToken(line, this.activeNgrokToken)));
			}
		if (logPath) capAppendOnlyLog(logPath);
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
			const cloudflareHost = new URL(identity.url).hostname.endsWith('.trycloudflare.com');
			if (code && TRANSIENT_DNS_ERRORS.has(code) && cloudflareHost) {
				try {
					const raw = await fetchQuickTunnelHealth(identity.url);
					await this.commitPublicProbe(identity, isValidPublicHealth(raw) ? null : 'Public health returned an invalid response.');
				} catch (fallbackError) {
					await this.commitPublicProbe(identity, publicDnsFailureMessage(fallbackError));
				}
			} else await this.commitPublicProbe(identity, errorMessage(error));
		} finally {
			this.publicProbeInFlight = false;
		}
	}

	private async commitPublicProbe(
		identity: { pid: number; startedAt: number; url: string },
		error: string | null
	): Promise<void> {
		if (error) this.consecutivePublicProbeFailures += 1;
		else this.consecutivePublicProbeFailures = 0;
		const publicStatus =
			error && this.consecutivePublicProbeFailures >= PUBLIC_PROBE_FAILURE_THRESHOLD
				? 'unreachable'
				: error
					? 'checking'
					: 'reachable';
		const current = RuntimeStateStore.read().tunnel;
		if (
			current.pid === identity.pid &&
			current.startedAt === identity.startedAt &&
			current.url === identity.url &&
			current.status === 'running' &&
			current.publicStatus === publicStatus &&
			current.publicError === error
		)
			return;

		let changed = false;
		let previousPublicStatus = current.publicStatus;
		await RuntimeStateStore.mutate((state) => {
			if (
				state.tunnel.pid !== identity.pid ||
				state.tunnel.startedAt !== identity.startedAt ||
				state.tunnel.url !== identity.url ||
				state.tunnel.status !== 'running' ||
				(state.tunnel.publicStatus === publicStatus && state.tunnel.publicError === error)
			)
				return state;
			changed = true;
			previousPublicStatus = state.tunnel.publicStatus;
			state.tunnel.publicStatus = publicStatus;
			state.tunnel.publicCheckedAt = Date.now();
			state.tunnel.publicError = error;

			return state;
		});
		if (changed) {
			// Do not include the URL or arbitrary network exception text in the journal.
			// Error changes still persist above, but stable status must not spam logs.
			if (previousPublicStatus !== publicStatus) {
				const reason = !error ? 'health check succeeded' : 'health check failed';
				this.log(`Public tunnel health: ${previousPublicStatus ?? 'unchecked'} → ${publicStatus} (${reason}).`);
			}
			this.onStateChange(this.getState());
		}
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
		for (const file of logs.slice(config.apiServer.retainedProcessLogs)) fs.rmSync(file, { force: true });
	}
}
