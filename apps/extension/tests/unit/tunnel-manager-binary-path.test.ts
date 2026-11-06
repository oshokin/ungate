import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { DEFAULT_API_PORT, LOOPBACK_HOST, LOG_LIMITS, QUICK_TUNNEL_CONFIG, QUICK_TUNNEL_CONFIG_NAME } from '@ungate/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { config } from '../../src/runtime-state/config';
import { RuntimeStateDefaults } from '../../src/runtime-state/default-state';
import { getCloudflaredBinPath, TunnelManager } from '../../src/tunnel-manager';

import type { RuntimeState } from '@ungate/shared/frontend';

const mocks = vi.hoisted(() => ({
	state: undefined as RuntimeState | undefined,
	alive: false,
	installed: false,
	install: vi.fn(),
	spawn: vi.fn(),
	resolve4: vi.fn(),
	httpsRequest: vi.fn()
}));
vi.mock('../../src/runtime-state', () => ({
	RuntimeStateStore: {
		read: () => mocks.state,
		mutate: (fn: (state: RuntimeState) => RuntimeState) => {
			if (!mocks.state) throw new Error('Runtime state was not initialized.');
			mocks.state = fn(mocks.state);

			return Promise.resolve(mocks.state);
		}
	}
}));
vi.mock('../../src/utils/managed-process', () => ({
	getCloudflaredBinPath: () => '/test/cloudflared',
	ManagedProcess: { matches: () => mocks.alive, isAlive: () => mocks.alive }
}));
vi.mock('../../src/utils/cloudflared-installer', () => ({
	CLOUDFLARED_VERSION: 'pinned',
	CloudflaredInstaller: {
		isPinnedInstall: () => mocks.installed,
		install: mocks.install
	}
}));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:dns/promises', () => ({
	Resolver: class {
		setServers() {}
		resolve4 = mocks.resolve4;
	}
}));
vi.mock('node:https', () => ({ request: mocks.httpsRequest }));
vi.mock('vscode', () => ({ workspace: { getConfiguration: () => ({ inspect: () => ({}) }) } }));

const original = config.baseDir;
let temporary: string;
let manager: TunnelManager;
beforeEach(() => {
	temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ungate-tunnel-'));
	config.baseDir = temporary;
	mocks.state = RuntimeStateDefaults.create();
	mocks.alive = false;
	mocks.installed = false;
	mocks.install.mockReset().mockImplementation(() => {
		mocks.installed = true;

		return Promise.resolve();
	});
	mocks.spawn.mockReset().mockImplementation((_binary: string, args: string[]) => {
		mocks.alive = true;
		fs.writeFileSync(
			args[args.indexOf('--logfile') + 1],
			`https://${mocks.spawn.mock.calls.length === 1 ? 'one' : 'two'}.trycloudflare.com\nRegistered tunnel connection\n`
		);
		const child = Object.assign(new EventEmitter(), { pid: 12345, unref: vi.fn() });
		queueMicrotask(() => child.emit('spawn'));

		return child;
	});
	mocks.resolve4.mockReset().mockRejectedValue(new Error('DNS fallback unavailable'));
	mocks.httpsRequest.mockReset();
	manager = new TunnelManager('window-a', () => true, vi.fn(), vi.fn());
});
afterEach(() => {
	vi.unstubAllGlobals();
	manager.syncMonitor(false);
	config.baseDir = original;
	vi.restoreAllMocks();
	fs.rmSync(temporary, { recursive: true, force: true });
});

describe('detached tunnel lifecycle', () => {
	it('preserves public health fields when a state update omits them', async () => {
		Object.assign(mocks.state!.tunnel, { publicStatus: 'reachable', publicCheckedAt: 123, publicError: 'saved' });
		await (manager as unknown as { setState(state: unknown): Promise<void> }).setState({
			status: 'running',
			url: 'https://one.trycloudflare.com',
			error: null
		});
		expect(manager.getState()).toMatchObject({ publicStatus: 'reachable', publicCheckedAt: 123, publicError: 'saved' });
	});

	it.each(['declared', 'streamed'])('bounds %s DNS fallback health responses', async (kind) => {
		mocks.alive = true;
		Object.assign(mocks.state!.tunnel, {
			status: 'running',
			url: 'https://one.trycloudflare.com',
			pid: 12345,
			startedAt: Date.now(),
			publicStatus: 'checking',
			publicCheckedAt: null,
			publicError: null
		});
		const dnsError = Object.assign(new Error('DNS failed'), { code: 'ENOTFOUND' });
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed', { cause: dnsError })));
		mocks.resolve4.mockResolvedValue(['104.16.230.132']);
		const response = Object.assign(new EventEmitter(), {
			headers: kind === 'declared' ? { 'content-length': '65537' } : {},
			statusCode: 200,
			destroy: vi.fn()
		});
		mocks.httpsRequest.mockImplementation((_options, callback) => {
			const request = Object.assign(new EventEmitter(), { destroy: vi.fn(), end: vi.fn() });
			request.end.mockImplementation(() => {
				(callback as (response: EventEmitter) => void)(response);
				if (kind === 'streamed') response.emit('data', Buffer.alloc(65537));
			});

			return request;
		});
		await (manager as unknown as { probePublicHealth(force: boolean): Promise<void> }).probePublicHealth(true);
		expect(response.destroy).toHaveBeenCalled();
		expect(manager.getState().publicError).toContain('65536-byte');
		vi.unstubAllGlobals();
	});
	it('installs a verified binary, uses a loopback origin and detached file-backed logs', async () => {
		await manager.start(DEFAULT_API_PORT);
		expect(mocks.install).toHaveBeenCalledWith(getCloudflaredBinPath());
		expect(mocks.spawn).toHaveBeenCalledWith(
			getCloudflaredBinPath(),
			expect.arrayContaining([`http://${LOOPBACK_HOST}:${DEFAULT_API_PORT}`, '--protocol', 'http2']),
			expect.objectContaining({ detached: true, stdio: 'ignore' })
		);
		const args = mocks.spawn.mock.calls[0][1] as string[];
		const configPath = args[args.indexOf('--config') + 1];
		expect(configPath).toBe(path.join(temporary, QUICK_TUNNEL_CONFIG_NAME));
		expect(fs.readFileSync(configPath, 'utf8')).toBe(QUICK_TUNNEL_CONFIG);
		expect(manager.getState()).toEqual({
			status: 'running',
			url: 'https://one.trycloudflare.com',
			error: null,
			publicStatus: 'checking',
			publicCheckedAt: null,
			publicError: null,
			startedAt: expect.any(Number)
		});
	});

	it('starts cloudflared with the saved protocol', async () => {
		await manager.start(DEFAULT_API_PORT, 'quic');
		expect(mocks.spawn).toHaveBeenCalledWith(
			getCloudflaredBinPath(),
			expect.arrayContaining(['--protocol', 'quic']),
			expect.objectContaining({ detached: true })
		);
		expect((mocks.state as { tunnel: { protocol?: string } }).tunnel.protocol).toBe('quic');
	});

	it('reuses a live tunnel in another window, including two concurrent starts', async () => {
		await Promise.all([manager.start(DEFAULT_API_PORT), manager.start(DEFAULT_API_PORT)]);
		const another = new TunnelManager('window-b', () => true, vi.fn(), vi.fn());
		await another.start(DEFAULT_API_PORT);
		expect(mocks.spawn).toHaveBeenCalledTimes(1);
		expect(another.getState().url).toBe('https://one.trycloudflare.com');
	});

	it('does not spawn when binary verification fails', async () => {
		mocks.install.mockRejectedValue(new Error('Checksum mismatch'));
		await expect(manager.start(DEFAULT_API_PORT)).rejects.toThrow('Checksum mismatch');
		expect(mocks.spawn).not.toHaveBeenCalled();
		expect(manager.getState().status).toBe('error');
	});

	it('stops the old process before spawning a replacement', async () => {
		await manager.start(DEFAULT_API_PORT);
		const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
			mocks.alive = false;

			return true;
		});
		await manager.restart(DEFAULT_API_PORT);
		expect(kill).toHaveBeenCalledWith(12345, 'SIGTERM');
		expect(mocks.spawn).toHaveBeenCalledTimes(2);
		expect(manager.getState().url).toBe('https://two.trycloudflare.com');
		const logPaths = mocks.spawn.mock.calls.map((call: unknown[]) => {
			const args = call[1] as string[];

			return args[args.indexOf('--logfile') + 1];
		});
		expect(logPaths[0]).not.toBe(logPaths[1]);
	});

	it('kills a verified tunnel that ignores graceful shutdown and clears a dead tunnel', async () => {
		await manager.start(DEFAULT_API_PORT);
		const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
			if (signal === 'SIGKILL') mocks.alive = false;

			return true;
		});
		await manager.restart(DEFAULT_API_PORT);
		expect(kill.mock.calls.map((call) => call[1])).toEqual(['SIGTERM', 'SIGKILL']);
		expect(manager.getState().url).toBe('https://two.trycloudflare.com');

		mocks.alive = false;
		await manager.reconcile();
		expect(manager.getState()).toMatchObject({
			status: 'stopped',
			url: null,
			error: 'The tunnel process stopped. Start it again and copy the new URL into Cursor.'
		});
	});

	it('keeps a live restarted tunnel running through transient public probe failures', async () => {
		mocks.alive = true;
		(mocks.state as { tunnel: Record<string, unknown> }).tunnel = {
			status: 'running',
			url: 'https://one.trycloudflare.com',
			pid: 12345,
			logPath: path.join(temporary, 'tunnel.log'),
			startedAt: Date.now(),
			lastSeenAt: Date.now(),
			lastError: null,
			ownerWindowId: 'window-a',
			publicStatus: 'checking',
			publicCheckedAt: null,
			publicError: null
		};
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('DNS is still propagating')));
		const probe = (
			manager as unknown as {
				probePublicHealth(force: boolean): Promise<void>;
			}
		).probePublicHealth.bind(manager);

		await probe(true);
		expect(manager.getState()).toMatchObject({ status: 'running', publicStatus: 'checking' });
		await probe(true);
		expect(manager.getState()).toMatchObject({ status: 'running', publicStatus: 'checking' });
		await probe(true);
		expect(manager.getState()).toMatchObject({ status: 'running', publicStatus: 'unreachable' });
	});

	it('marks the tunnel unreachable when public DNS has no record for its hostname', async () => {
		mocks.alive = true;
		(mocks.state as { tunnel: Record<string, unknown> }).tunnel = {
			status: 'running',
			url: 'https://one.trycloudflare.com',
			pid: 12345,
			logPath: path.join(temporary, 'tunnel.log'),
			startedAt: Date.now(),
			lastSeenAt: Date.now(),
			lastError: null,
			ownerWindowId: 'window-a',
			publicStatus: 'checking',
			publicCheckedAt: null,
			publicError: null
		};
		const dnsError = Object.assign(new Error('getaddrinfo ENOTFOUND one.trycloudflare.com'), {
			code: 'ENOTFOUND'
		});
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed', { cause: dnsError })));
		mocks.resolve4.mockRejectedValue(Object.assign(new Error('queryA ENOTFOUND one.trycloudflare.com'), { code: 'ENOTFOUND' }));
		const probe = (
			manager as unknown as {
				probePublicHealth(force: boolean): Promise<void>;
			}
		).probePublicHealth.bind(manager);

		await probe(true);
		expect(manager.getState()).toMatchObject({
			status: 'running',
			publicStatus: 'checking',
			publicError: 'Tunnel address does not resolve. Restart the tunnel.'
		});
		await probe(true);
		expect(manager.getState().publicStatus).toBe('checking');
		await probe(true);
		expect(manager.getState()).toMatchObject({
			status: 'running',
			publicStatus: 'unreachable',
			publicError: 'Tunnel address does not resolve. Restart the tunnel.'
		});
	});

	it('verifies a quick tunnel through public DNS when the local resolver has a negative cache entry', async () => {
		mocks.alive = true;
		(mocks.state as { tunnel: Record<string, unknown> }).tunnel = {
			status: 'running',
			url: 'https://one.trycloudflare.com',
			pid: 12345,
			logPath: path.join(temporary, 'tunnel.log'),
			startedAt: Date.now(),
			lastSeenAt: Date.now(),
			lastError: null,
			ownerWindowId: 'window-a',
			publicStatus: 'checking',
			publicCheckedAt: null,
			publicError: null
		};
		const dnsError = Object.assign(new Error('getaddrinfo ENOTFOUND one.trycloudflare.com'), {
			code: 'ENOTFOUND'
		});
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed', { cause: dnsError })));
		mocks.resolve4.mockResolvedValue(['104.16.230.132']);
		mocks.httpsRequest.mockImplementation((_options, callback) => {
			const response = Object.assign(new EventEmitter(), { headers: {}, destroy: vi.fn(), statusCode: 200 });
			response.statusCode = 200;
			const request = new EventEmitter() as EventEmitter & {
				end: () => void;
				destroy: (error?: Error) => void;
			};
			request.end = vi.fn(() => {
				(callback as (response: EventEmitter) => void)(response);
				response.emit('data', Buffer.from(JSON.stringify({ status: 'ok', service: 'ungate' })));
				response.emit('end');
			});
			request.destroy = vi.fn();

			return request;
		});
		const probe = (
			manager as unknown as {
				probePublicHealth(force: boolean): Promise<void>;
			}
		).probePublicHealth.bind(manager);

		await probe(true);
		expect(manager.getState()).toMatchObject({ status: 'running', publicStatus: 'reachable', publicError: null });
		const checkedAt = mocks.state?.tunnel.publicCheckedAt;
		await probe(true);
		expect(mocks.state?.tunnel.publicCheckedAt).toBe(checkedAt);
		expect(mocks.httpsRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				hostname: '104.16.230.132',
				servername: 'one.trycloudflare.com',
				headers: { host: 'one.trycloudflare.com' }
			}),
			expect.any(Function)
		);
	});

	it('caps the live tunnel log while polling and keeps only the newest inactive logs', async () => {
		const active = path.join(temporary, 'tunnel-active.log');
		fs.writeFileSync(active, 'x'.repeat(LOG_LIMITS.maxFileBytes));
		mocks.state!.tunnel.logPath = active;
		manager.syncMonitor(true);
		await vi.waitFor(() => expect(fs.statSync(active).size).toBe(0));
		manager.syncMonitor(false);

		const stale = Array.from({ length: config.apiServer.retainedProcessLogs + 1 }, (_, index) => {
			const file = path.join(temporary, `tunnel-old-${index}.log`);
			fs.writeFileSync(file, 'old');
			const time = new Date(1_700_000_000_000 + index * 1000);
			fs.utimesSync(file, time, time);

			return file;
		});
		await manager.stop();
		expect(fs.existsSync(active)).toBe(true);
		expect(stale.slice(0, 2).every((file) => !fs.existsSync(file))).toBe(true);
		expect(stale.slice(2).every((file) => fs.existsSync(file))).toBe(true);
	});
});
