import * as cp from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	getAdminToken,
	LOOPBACK_HOST,
	MILLISECONDS_PER_SECOND,
	PRIVATE_DIR_MODE,
	PRIVATE_FILE_MODE,
	sleep,
	UNGATE_DIR,
	type ApiStatus as ServerStatus,
	type LogEntry
} from '@ungate/shared';
import { describeService, type RuntimeState } from '@ungate/shared/frontend';
import * as vscode from 'vscode';

import { apiArtifactDigest } from './api-artifact';
import { readApiHealth, assertCompatibleApi } from './local-api';
import { configuredNodePath } from './node-runtime-settings';
import { RuntimeStateStore } from './runtime-state';
import { config } from './runtime-state/config';
import { BetterSqlite3Installer } from './utils/better-sqlite3-installer';
import { CrossProcessLock } from './utils/cross-process-lock';
import { capAppendOnlyLog, LogFileReader } from './utils/log-file-reader';
import { ManagedProcess } from './utils/managed-process';
import { NodeResolver } from './utils/node-resolver';

interface ApiServerCallbacks {
	onLog(level: LogEntry['level'], message: string): void;
	onPortDetected(port: number): void;
	onStatusChange(status: ServerStatus): void;
	isLeaderWindow(): boolean;
	isExtensionHostActive(): boolean;
	getWindowId(): string;
}

export class ApiServer {
	private process: cp.ChildProcess | null = null;
	private healthCheckTimer: NodeJS.Timeout | null = null;
	private healthCheckInFlight = false;
	private stdoutBuffer = '';
	private logPath: string | null = null;
	private readonly logReader = new LogFileReader();
	private shutDownDeliberately = false;
	private lastStatus: ServerStatus | null = null;
	private port: number | null = null;
	private runtimePath = '';
	private noClientsSince: number | null = null;
	private addressInUsePort: number | null = null;
	private startPromise: Promise<void> | null = null;
	private restartInProgress = false;
	private healthFailures = 0;
	private attachedPid: number | null = null;
	private readonly expectedArtifactDigest: string | undefined;
	private logConnected = true;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly callbacks: ApiServerCallbacks
	) {
		this.expectedArtifactDigest = apiArtifactDigest(context);
	}

	async start(): Promise<void> {
		if (this.isAutoStartBlocked()) {
			return;
		}

		if (this.process) {
			return;
		}

		if (this.startPromise) {
			return this.startPromise;
		}

		this.startPromise = this.doStart();

		try {
			await this.startPromise;
		} finally {
			this.startPromise = null;
		}
	}

	isStartupInProgress(): boolean {
		return this.startPromise !== null || this.restartInProgress;
	}

	async restart(): Promise<void> {
		if (this.restartInProgress) return;
		if (this.startPromise) await this.startPromise.catch(() => {});
		this.restartInProgress = true;
		let release: (() => void) | undefined;
		try {
			release = await CrossProcessLock.acquire('api-start.lock', config.locks.startupTimeoutMs);
			const existingPort = this.port ?? RuntimeStateStore.read().api.port;
			if (existingPort) {
				const health = await readApiHealth(existingPort).catch(() => null);
				if (health) {
					const state = describeService(health, this.expectedArtifactDigest);
					if (state.status === 'incompatible' && !state.canUpdate) throw new Error(state.message!);
				}
			}
			await this.stopLocked();
			this.port = null;
			await RuntimeStateStore.resetApiForRestart();
			await this.startLocked();
		} finally {
			release?.();
			this.restartInProgress = false;
		}
	}

	/** Release window resources; keep the shared service alive for reloads and other windows. */
	detach(): void {
		this.stopHealthCheck();
	}

	async stop(): Promise<void> {
		const release = await CrossProcessLock.acquire('api-start.lock', config.locks.startupTimeoutMs);
		try {
			await this.stopLocked();
		} finally {
			release();
		}
	}

	private async stopLocked(): Promise<void> {
		this.stopHealthCheck();
		this.shutDownDeliberately = true;
		const port = this.port ?? RuntimeStateStore.read().api.port;
		const healthy = port ? await this.checkPortHealth(port) : false;
		if (port && healthy) {
			const response = await fetch(`http://${LOOPBACK_HOST}:${port}/admin/shutdown`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${getAdminToken()}` },
				signal: AbortSignal.timeout(config.apiServer.shutdownRequestTimeoutMs)
			});
			if (!response.ok) throw new Error(`Cannot stop shared API: HTTP ${response.status}`);
			const deadline = Date.now() + config.apiServer.shutdownTimeoutMs;
			while (true) {
				const alive = await this.isPortListening(port);
				if (!alive) break;
				if (Date.now() > deadline) {
					await this.stopAuthenticatedApiProcess(port);
					break;
				}
				await sleep(config.apiServer.pollIntervalMs);
			}
		} else {
			const savedPid = RuntimeStateStore.read().api.pid;
			if (!this.process && savedPid && ManagedProcess.isAlive(savedPid))
				throw new Error('API process is alive but cannot be authenticated. Check its PID before stopping it.');
			this.process?.kill();
		}
		this.process = null;
		this.port = null;
		this.lastStatus = 'stopped';
		this.attachedPid = null;
		await this.writeRuntimeState('stopped', null);
		this.rotateLogs();
	}

	getPort(): number | null {
		return this.port;
	}

	getExpectedArtifactDigest(): string | undefined {
		return this.expectedArtifactDigest;
	}

	syncLeaderHealthMonitor(isLeader: boolean): void {
		if (!isLeader) {
			this.stopHealthCheck();

			return;
		}

		const hasRuntimeTarget = this.process !== null || this.port !== null || this.startPromise !== null;

		if (hasRuntimeTarget && !this.healthCheckTimer) {
			this.startHealthCheck();
		}
	}

	private async doStart(): Promise<void> {
		const release = await CrossProcessLock.acquire('api-start.lock', config.locks.startupTimeoutMs);
		try {
			await this.startLocked();
		} finally {
			release();
		}
	}

	private async startLocked(): Promise<void> {
		if (this.isAutoStartBlocked()) {
			return;
		}

		const runtimeState = RuntimeStateStore.read();
		this.attachLog(runtimeState.api.logPath);
		const existingPort = runtimeState.api.port;

		if (existingPort) {
			const isAlive = await this.checkPortHealth(existingPort);

			if (isAlive) {
				this.port = existingPort;
				this.callbacks.onPortDetected(existingPort);
				try {
					await assertCompatibleApi(existingPort, { expectedArtifactDigest: this.expectedArtifactDigest });
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					await this.recordApiFailure(message);
					throw error;
				}
				this.callbacks.onLog('info', `[process] attached to api pid=${this.attachedPid ?? 'unknown'} port=${existingPort}`);
				await this.setStatus('running');
				this.startHealthCheck();

				return;
			}
		}

		if (runtimeState.api.pid && ManagedProcess.isAlive(runtimeState.api.pid)) {
			const message =
				'Saved Ungate API process is alive but unhealthy. Use Restart API after checking its PID; no duplicate was started.';
			await this.recordApiFailure(message);
			throw new Error(message);
		}
		await this.setStatus('starting');

		try {
			await this.ensureNativeDeps();
			this.shutDownDeliberately = false;
			this.spawn();
			const deadline = Date.now() + config.apiServer.startupTimeoutMs;
			while (true) {
				this.pollLogs();
				const healthy = this.port ? await this.checkPortHealth(this.port) : false;
				if (healthy) break;
				if (!this.process || Date.now() > deadline)
					throw new Error(
						`Ungate API did not become ready within ${config.apiServer.startupTimeoutMs / MILLISECONDS_PER_SECOND} seconds.`
					);
				await sleep(config.apiServer.pollIntervalMs);
			}
			if (this.port) await assertCompatibleApi(this.port, { expectedArtifactDigest: this.expectedArtifactDigest });
			await this.setStatus('running');
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);

			await this.recordApiFailure(message);
			throw err;
		}
	}

	private isAutoStartBlocked(): boolean {
		if (this.restartInProgress) {
			return false;
		}

		return RuntimeStateStore.isApiStartSuppressed();
	}

	private async recordApiFailure(message: string): Promise<void> {
		this.lastStatus = 'error';
		this.callbacks.onLog('error', `[startup] ${message}`);
		await RuntimeStateStore.suppressApiAutoStart(message);
		this.callbacks.onStatusChange('error');
	}

	private spawn(): void {
		if (!this.callbacks.isLeaderWindow() || !this.callbacks.isExtensionHostActive()) {
			return;
		}

		this.ensureBaseDir();
		const cwd = this.getServerCwd();
		this.stdoutBuffer = '';
		const logPath = path.join(config.baseDir, `api-${randomUUID()}.log`);
		const logFd = fs.openSync(logPath, 'ax', PRIVATE_FILE_MODE);
		this.attachLog(logPath);

		const isDev = this.context.extensionMode === vscode.ExtensionMode.Development;
		const runtime =
			this.runtimePath || NodeResolver.resolve(configuredNodePath(), (message) => this.callbacks.onLog('info', message));
		this.runtimePath = runtime;

		const env: NodeJS.ProcessEnv = {
			...process.env,
			UNGATE_ADMIN_TOKEN: getAdminToken(),
			UNGATE_BETTER_SQLITE3_NATIVE_BINDING: BetterSqlite3Installer.resolveBindingPath(cwd, runtime),
			...(isDev ? { DB_PATH: path.join(os.homedir(), UNGATE_DIR, 'data-dev.db') } : { DRIZZLE_PATH: path.join(cwd, 'drizzle') })
		};

		const nodeArgs = isDev ? ['-r', 'source-map-support/register', 'dist/main.js'] : ['bundle/main.cjs'];

		this.callbacks.onLog('info', `[process] starting api via ${runtime}`);

		try {
			this.process = cp.spawn(runtime, nodeArgs, {
				cwd,
				env,
				windowsHide: true,
				stdio: ['ignore', logFd, logFd],
				detached: true
			});
		} finally {
			fs.closeSync(logFd);
		}
		this.process.unref();
		void this.writeRuntimeState('starting', null).catch(() => {});

		const child = this.process;
		this.process.on('exit', (code, signal) => {
			if (this.process === child) this.onExit(code, signal);
		});
		this.process.on('error', (err) => {
			void this.onSpawnProcessError(err).catch(() => {});
		});

		this.startHealthCheck();
	}

	private onStdout(data: Buffer): void {
		const text = data.toString();
		this.stdoutBuffer = (this.stdoutBuffer + text).slice(-config.apiServer.stdoutBufferBytes);

		for (const line of text.split('\n').filter((l) => l.trim())) {
			if (line.includes('EADDRINUSE')) {
				const addressMatch = /port:\s*(\d+)/.exec(this.stdoutBuffer);
				if (addressMatch) this.addressInUsePort = parseInt(addressMatch[1], 10);
			}
			this.callbacks.onLog(this.parseLogLevel(line), line);
		}

		const match = /localhost:(\d+)/.exec(this.stdoutBuffer);

		if (match) {
			const port = parseInt(match[1], 10);

			if (port !== this.port) {
				this.port = port;
				this.callbacks.onPortDetected(port);
			}
		}
	}

	private onExit(code: number | null, signal: NodeJS.Signals | null): void {
		this.process = null;
		this.noClientsSince = null;

		let level: LogEntry['level'];

		if (code === 0) {
			level = 'info';
		} else {
			level = 'error';
		}

		this.callbacks.onLog(level, `[process] exit code=${code} signal=${signal}`);

		if (this.shutDownDeliberately) {
			this.shutDownDeliberately = false;

			return;
		}

		if (code === 0) {
			this.lastStatus = 'stopped';
			void sleep(config.apiServer.restartDelayMs).then(async () => {
				if (!this.shouldRespawn()) {
					return;
				}

				await this.start();
			});

			return;
		}

		if (this.addressInUsePort) {
			const addressInUsePort = this.addressInUsePort;
			this.addressInUsePort = null;
			void this.tryAttachToRunningPort(addressInUsePort).catch(() => {});

			return;
		}

		const message = `[process] exit code=${code} signal=${signal}`;

		void this.recordApiFailure(message).catch(() => {});
	}

	private shouldRespawn(): boolean {
		if (!this.restartInProgress && this.isAutoStartBlocked()) {
			return false;
		}

		return this.callbacks.isLeaderWindow() && this.callbacks.isExtensionHostActive();
	}

	private async tryAttachToRunningPort(port: number): Promise<void> {
		const isAlive = await this.checkPortHealth(port);

		if (!isAlive) {
			await this.recordApiFailure(`[process] port ${port} is not healthy`);

			return;
		}

		this.port = port;
		this.callbacks.onPortDetected(port);
		await assertCompatibleApi(port, { expectedArtifactDigest: this.expectedArtifactDigest });
		await this.setStatus('running');
		this.startHealthCheck();
	}

	private async onSpawnProcessError(err: Error): Promise<void> {
		this.callbacks.onLog('error', `[process] error: ${err.message}`);
		await this.recordApiFailure(err.message);
	}

	private startHealthCheck(): void {
		this.stopHealthCheck();

		this.healthCheckTimer = setInterval(() => {
			if (this.healthCheckInFlight) return;
			this.healthCheckInFlight = true;
			void this.runHealthCheckCycle()
				.catch(() => {})
				.finally(() => {
					this.healthCheckInFlight = false;
				});
		}, config.apiServer.healthCheckIntervalMs);
	}

	private async runHealthCheckCycle(): Promise<void> {
		this.pollLogs();
		if (!this.callbacks.isLeaderWindow()) {
			return;
		}

		const runtimeState = RuntimeStateStore.read();
		const hasLiveClientsOnDisk = RuntimeStateStore.hasLiveClients(runtimeState);
		const extensionHostAlive = this.callbacks.isExtensionHostActive();
		const treatAsLiveClients = hasLiveClientsOnDisk || extensionHostAlive;
		const hasLeaderWindow = this.callbacks.isLeaderWindow();

		if (!treatAsLiveClients && this.lastStatus === 'running') {
			this.noClientsSince ??= Date.now();

			if (Date.now() - this.noClientsSince >= config.apiServer.noClientsGracePeriodMs) {
				this.callbacks.onLog('info', '[process] no live windows, stopping api');
				await this.stop();

				return;
			}
		} else {
			this.noClientsSince = null;
		}

		if (treatAsLiveClients && this.lastStatus === 'running' && !hasLeaderWindow) {
			return;
		}

		if (!this.port) {
			return;
		}

		try {
			try {
				await assertCompatibleApi(this.port, { expectedArtifactDigest: this.expectedArtifactDigest });
				this.healthFailures = 0;
				const wasDown = this.lastStatus !== 'running';

				await this.setStatus('running');

				if (wasDown) {
					this.callbacks.onPortDetected(this.port);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				await this.handleHealthFailure(`[process] health check failed: ${message}`);
			}
		} catch {
			await this.handleHealthFailure('[process] health check failed');
		}
	}

	private async handleHealthFailure(message: string): Promise<void> {
		if (++this.healthFailures < config.apiServer.healthFailureThreshold) return;
		const pid = RuntimeStateStore.read().api.pid;
		if (pid && !ManagedProcess.isAlive(pid)) {
			this.port = null;
			this.process = null;
			this.lastStatus = 'stopped';
			await RuntimeStateStore.resetApiForRestart();

			return;
		}
		await this.recordApiFailure(message);
	}

	private stopHealthCheck(): void {
		if (this.healthCheckTimer) {
			clearInterval(this.healthCheckTimer);
			this.healthCheckTimer = null;
		}
	}

	private async setStatus(status: ServerStatus): Promise<void> {
		this.lastStatus = status;
		await this.writeRuntimeState(status, null);
		this.callbacks.onStatusChange(status);
	}

	private async writeRuntimeState(status: ServerStatus, errorMessage: string | null): Promise<void> {
		const snapshot = RuntimeStateStore.read();
		if (this.anotherLiveWindowOwnsApi(snapshot) || this.apiRecordMatches(snapshot, status, errorMessage)) return;

		await RuntimeStateStore.mutate((current) => {
			if (this.anotherLiveWindowOwnsApi(current) || this.apiRecordMatches(current, status, errorMessage)) return current;

			let pid: number | null = this.attachedPid ?? current.api.pid;

			if (this.process?.pid) {
				pid = this.process.pid;
			}

			current.api.pid = status === 'stopped' ? null : pid;
			current.api.port = this.port;
			current.api.logPath = status === 'stopped' ? undefined : (this.logPath ?? current.api.logPath);
			if (status === 'stopped') current.api.logHealth = { status: 'available', logPath: null, message: null };
			else if (current.api.logPath !== current.api.logHealth?.logPath)
				current.api.logHealth = { status: 'available', logPath: current.api.logPath ?? null, message: null };
			current.api.status = status;
			current.api.lastSeenAt = Date.now();
			current.api.lastError = errorMessage;
			if (status === 'running') current.api.startSuppressed = false;

			if (status === 'starting' || status === 'running') {
				current.api.ownerWindowId = this.callbacks.getWindowId();
			} else if (status === 'stopped' || status === 'error') {
				current.api.ownerWindowId = null;
			}

			return current;
		});
	}

	/** A healthy check repeats the same API record. Rewriting it only to bump lastSeenAt updates the data directory. */
	private apiRecordMatches(state: RuntimeState, status: ServerStatus, errorMessage: string | null): boolean {
		const api = state.api;
		let pid: number | null = this.attachedPid ?? api.pid;
		if (this.process?.pid) pid = this.process.pid;
		const owner =
			status === 'starting' || status === 'running'
				? this.callbacks.getWindowId()
				: status === 'stopped' || status === 'error'
					? null
					: api.ownerWindowId;

		return (
			api.pid === (status === 'stopped' ? null : pid) &&
			api.port === this.port &&
			api.logPath === (status === 'stopped' ? undefined : (this.logPath ?? api.logPath)) &&
			api.status === status &&
			api.lastError === errorMessage &&
			api.ownerWindowId === owner &&
			api.startSuppressed === (status === 'running' ? false : api.startSuppressed)
		);
	}

	private anotherLiveWindowOwnsApi(state: RuntimeState): boolean {
		const owner = state.api.ownerWindowId;

		return !!owner && owner !== this.callbacks.getWindowId() && RuntimeStateStore.getLiveClientIds(state).includes(owner);
	}

	private async checkPortHealth(port: number): Promise<boolean> {
		try {
			const health = await readApiHealth(port, AbortSignal.timeout(config.apiServer.portHealthRequestTimeoutMs));
			this.attachedPid = health.pid;

			return true;
		} catch {
			return false;
		}
	}

	private async isPortListening(port: number): Promise<boolean> {
		try {
			await fetch(`http://${LOOPBACK_HOST}:${port}/health`, {
				signal: AbortSignal.timeout(config.apiServer.portHealthRequestTimeoutMs)
			});

			return true;
		} catch {
			return false;
		}
	}

	private async stopAuthenticatedApiProcess(port: number): Promise<void> {
		const health = await readApiHealth(port, AbortSignal.timeout(config.apiServer.portHealthRequestTimeoutMs));
		const pid = health.pid;
		this.callbacks.onLog('warn', `[process] graceful shutdown timed out; terminating authenticated api pid=${pid}`);
		this.signalProcess(pid, 'SIGTERM');
		const forceAt = Date.now() + config.apiServer.terminationGraceMs;
		const deadline = Date.now() + config.apiServer.terminationTimeoutMs;
		let forced = false;
		let listening = await this.isPortListening(port);
		while (listening) {
			if (!forced && Date.now() >= forceAt) {
				const current = await readApiHealth(port, AbortSignal.timeout(config.apiServer.portHealthRequestTimeoutMs));
				if (current.pid !== pid) throw new Error('API PID changed during shutdown; refusing to terminate its replacement.');
				this.signalProcess(pid, 'SIGKILL');
				forced = true;
			}
			if (Date.now() >= deadline) throw new Error('API shutdown timed out; no replacement started.');
			await sleep(config.apiServer.pollIntervalMs);
			listening = await this.isPortListening(port);
		}
	}

	private signalProcess(pid: number, signal: NodeJS.Signals): void {
		try {
			process.kill(pid, signal);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
		}
	}

	private getServerCwd(): string {
		if (this.context.extensionMode === vscode.ExtensionMode.Development) {
			return path.join(this.context.extensionPath, '..', 'api');
		}

		return path.join(this.context.extensionPath, 'bundled', 'api');
	}

	private parseLogLevel(line: string): LogEntry['level'] {
		const lower = line.toLowerCase();

		if (lower.includes('error') || lower.includes('fatal')) {
			return 'error';
		}

		if (lower.includes('warn')) {
			return 'warn';
		}

		return 'info';
	}

	private attachLog(logPath: string | undefined): void {
		if (!logPath || this.logPath === logPath) return;
		this.logPath = logPath;
		this.stdoutBuffer = '';
		this.setLogConnection(fs.existsSync(logPath));
	}

	private pollLogs(): void {
		if (!this.logPath) return;
		if (!fs.existsSync(this.logPath)) {
			this.setLogConnection(false);

			return;
		}
		this.setLogConnection(true);
		const lines = this.logReader.read(this.logPath);
		if (lines.length) this.onStdout(Buffer.from(`${lines.join('\n')}\n`));
		capAppendOnlyLog(this.logPath);
	}

	private setLogConnection(connected: boolean): void {
		if (this.logConnected === connected) return;
		this.logConnected = connected;
		if (!connected)
			this.callbacks.onLog(
				'warn',
				'[process] API log stream disconnected. Restart the shared API to restore diagnostic logging.'
			);
		const observedPath = this.logPath;
		const observedPid = this.attachedPid ?? this.process?.pid ?? null;
		void RuntimeStateStore.mutate((current) => {
			if (current.api.logPath !== observedPath || (observedPid !== null && current.api.pid !== observedPid)) return current;
			current.api.logHealth = {
				status: connected ? 'available' : 'unavailable',
				logPath: observedPath,
				message: connected
					? null
					: 'The API is running, but new diagnostic messages cannot be displayed. Restart the shared API to restore logging.'
			};

			return current;
		}).catch(() => {});
	}

	private rotateLogs(): void {
		this.ensureBaseDir();
		const active = new Set([this.logPath, RuntimeStateStore.read().api.logPath].filter((value): value is string => !!value));
		const logs = fs
			.readdirSync(config.baseDir)
			.filter((name) => name.startsWith('api-') && name.endsWith('.log'))
			.map((name) => path.join(config.baseDir, name))
			.filter((file) => !active.has(file))
			.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
		for (const file of logs.slice(config.apiServer.retainedProcessLogs)) fs.rmSync(file, { force: true });
	}

	private ensureBaseDir(): void {
		fs.mkdirSync(config.baseDir, { recursive: true, mode: PRIVATE_DIR_MODE });
		if (process.platform !== 'win32') fs.chmodSync(config.baseDir, PRIVATE_DIR_MODE);
	}

	private async ensureNativeDeps(): Promise<void> {
		const apiDir = this.getServerCwd();
		const runtime = NodeResolver.resolve(configuredNodePath(), (message) => this.callbacks.onLog('info', message));
		this.runtimePath = runtime;

		await BetterSqlite3Installer.ensureInstalled(apiDir, runtime, {
			onLog: (level, message) => {
				this.callbacks.onLog(level, message);
			}
		});
	}
}
