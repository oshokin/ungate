import * as cp from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { getAdminToken, sleep, type ApiStatus as ServerStatus, type LogEntry } from '@ungate/shared';
import { describeService } from '@ungate/shared/frontend';
import * as vscode from 'vscode';

import { readApiHealth, assertCompatibleApi } from './local-api';
import { RuntimeStateStore } from './runtime-state';
import { config } from './runtime-state/config';
import { BetterSqlite3Installer } from './utils/better-sqlite3-installer';
import { CrossProcessLock } from './utils/cross-process-lock';
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
	private logOffset = 0;
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

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly callbacks: ApiServerCallbacks
	) {}

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
			release = await CrossProcessLock.acquire('api-start.lock', 120000);
			const existingPort = this.port ?? RuntimeStateStore.read().api.port;
			if (existingPort) {
				const health = await readApiHealth(existingPort).catch(() => null);
				if (health) {
					const state = describeService(health);
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
		const release = await CrossProcessLock.acquire('api-start.lock', 120000);
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
			const response = await fetch(`http://127.0.0.1:${port}/admin/shutdown`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${getAdminToken()}` },
				signal: AbortSignal.timeout(5000)
			});
			if (!response.ok) throw new Error(`Cannot stop shared API: HTTP ${response.status}`);
			const deadline = Date.now() + 10000;
			while (true) {
				const alive = await this.isPortListening(port);
				if (!alive) break;
				if (Date.now() > deadline) {
					await this.stopAuthenticatedApiProcess(port);
					break;
				}
				await sleep(100);
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
		const release = await CrossProcessLock.acquire('api-start.lock', 120000);
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
					await assertCompatibleApi(existingPort);
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
			const deadline = Date.now() + 30000;
			while (true) {
				this.pollLogs();
				const healthy = this.port ? await this.checkPortHealth(this.port) : false;
				if (healthy) break;
				if (!this.process || Date.now() > deadline) throw new Error('Ungate API did not become ready within 30 seconds.');
				await sleep(100);
			}
			if (this.port) await assertCompatibleApi(this.port);
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
		await RuntimeStateStore.suppressApiAutoStart(message);
		this.callbacks.onStatusChange('error');
	}

	private spawn(): void {
		if (!this.callbacks.isLeaderWindow() || !this.callbacks.isExtensionHostActive()) {
			return;
		}

		const cwd = this.getServerCwd();
		this.stdoutBuffer = '';
		const logPath = path.join(config.baseDir, `api-${randomUUID()}.log`);
		const logFd = fs.openSync(logPath, 'ax', 0o600);
		this.attachLog(logPath);

		const isDev = this.context.extensionMode === vscode.ExtensionMode.Development;
		const runtime = this.runtimePath || this.resolveRuntimePath(NodeResolver.resolve(process.env.UNGATE_NODE_BIN));
		this.runtimePath = runtime;

		const env: NodeJS.ProcessEnv = {
			...process.env,
			UNGATE_ADMIN_TOKEN: getAdminToken(),
			UNGATE_BETTER_SQLITE3_NATIVE_BINDING: BetterSqlite3Installer.resolveBindingPath(cwd, runtime),
			...(isDev ? { DB_PATH: path.join(os.homedir(), '.ungate', 'data-dev.db') } : { DRIZZLE_PATH: path.join(cwd, 'drizzle') })
		};

		const nodeArgs = isDev ? ['-r', 'source-map-support/register', 'dist/main.js'] : ['bundle/main.cjs'];

		this.callbacks.onLog('info', `[process] starting api via ${runtime}`);

		try {
			this.process = cp.spawn(runtime, nodeArgs, { cwd, env, stdio: ['ignore', logFd, logFd], detached: true });
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
		this.stdoutBuffer = (this.stdoutBuffer + text).slice(-8192);

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
		await assertCompatibleApi(port);
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
				await assertCompatibleApi(this.port);
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
		if (++this.healthFailures < 3) return;
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
		await RuntimeStateStore.mutate((current) => {
			if (
				current.api.ownerWindowId &&
				current.api.ownerWindowId !== this.callbacks.getWindowId() &&
				RuntimeStateStore.getLiveClientIds(current).includes(current.api.ownerWindowId)
			) {
				return current;
			}

			const now = Date.now();
			let pid: number | null = this.attachedPid ?? current.api.pid;

			if (this.process?.pid) {
				pid = this.process.pid;
			}

			current.api.pid = status === 'stopped' ? null : pid;
			current.api.port = this.port;
			current.api.logPath = status === 'stopped' ? undefined : (this.logPath ?? current.api.logPath);
			current.api.status = status;
			current.api.lastSeenAt = now;
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
			await fetch(`http://127.0.0.1:${port}/health`, {
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
		const forceAt = Date.now() + 2000;
		const deadline = Date.now() + 5000;
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
			await sleep(100);
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
		this.logOffset = 0;
		this.stdoutBuffer = '';
	}

	private pollLogs(): void {
		if (!this.logPath) return;
		try {
			const size = fs.statSync(this.logPath).size;
			const start = Math.max(this.logOffset, size - 65536);
			const bytes = Buffer.alloc(Math.max(0, size - start));
			const fd = fs.openSync(this.logPath, 'r');
			try {
				fs.readSync(fd, bytes, 0, bytes.length, start);
			} finally {
				fs.closeSync(fd);
			}
			this.logOffset = size;
			if (bytes.length) this.onStdout(bytes);
		} catch {
			/* The process may not have written its log yet. */
		}
	}

	private rotateLogs(): void {
		const active = this.logPath;
		const logs = fs
			.readdirSync(config.baseDir)
			.filter((name) => name.startsWith('api-') && name.endsWith('.log'))
			.map((name) => path.join(config.baseDir, name))
			.filter((file) => file !== active)
			.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
		for (const file of logs.slice(5)) fs.rmSync(file, { force: true });
	}

	private async ensureNativeDeps(): Promise<void> {
		const apiDir = this.getServerCwd();
		const runtime = this.resolveRuntimePath(NodeResolver.resolve(process.env.UNGATE_NODE_BIN));
		this.runtimePath = runtime;

		await BetterSqlite3Installer.ensureInstalled(apiDir, runtime, {
			onLog: (level, message) => {
				this.callbacks.onLog(level, message);
			}
		});
	}

	private resolveRuntimePath(runtime: string): string {
		const inspected = cp.spawnSync(runtime, ['-p', 'process.execPath'], { encoding: 'utf8' });

		if (inspected.error || inspected.status !== 0) {
			return runtime;
		}

		const absolutePath = inspected.stdout.trim();

		if (!absolutePath) {
			return runtime;
		}

		return absolutePath;
	}
}
