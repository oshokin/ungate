import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
	manager.syncMonitor(false);
	config.baseDir = original;
	vi.restoreAllMocks();
	fs.rmSync(temporary, { recursive: true, force: true });
});

describe('detached tunnel lifecycle', () => {
	it('installs a verified binary, uses a loopback origin and detached file-backed logs', async () => {
		await manager.start(47821);
		expect(mocks.install).toHaveBeenCalledWith(getCloudflaredBinPath());
		expect(mocks.spawn).toHaveBeenCalledWith(
			getCloudflaredBinPath(),
			expect.arrayContaining(['http://127.0.0.1:47821', '--protocol', 'http2']),
			expect.objectContaining({ detached: true, stdio: 'ignore' })
		);
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
		await manager.start(47821, 'quic');
		expect(mocks.spawn).toHaveBeenCalledWith(
			getCloudflaredBinPath(),
			expect.arrayContaining(['--protocol', 'quic']),
			expect.objectContaining({ detached: true })
		);
		expect((mocks.state as { tunnel: { protocol?: string } }).tunnel.protocol).toBe('quic');
	});

	it('reuses a live tunnel in another window, including two concurrent starts', async () => {
		await Promise.all([manager.start(47821), manager.start(47821)]);
		const another = new TunnelManager('window-b', () => true, vi.fn(), vi.fn());
		await another.start(47821);
		expect(mocks.spawn).toHaveBeenCalledTimes(1);
		expect(another.getState().url).toBe('https://one.trycloudflare.com');
	});

	it('does not spawn when binary verification fails', async () => {
		mocks.install.mockRejectedValue(new Error('Checksum mismatch'));
		await expect(manager.start(47821)).rejects.toThrow('Checksum mismatch');
		expect(mocks.spawn).not.toHaveBeenCalled();
		expect(manager.getState().status).toBe('error');
	});

	it('stops the old process before spawning a replacement', async () => {
		await manager.start(47821);
		const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
			mocks.alive = false;

			return true;
		});
		await manager.restart(47821);
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
		await manager.start(47821);
		const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
			if (signal === 'SIGKILL') mocks.alive = false;

			return true;
		});
		await manager.restart(47821);
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

	it('keeps a registered tunnel connecting while the local resolver negatively caches its hostname', async () => {
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
		const probe = (
			manager as unknown as {
				probePublicHealth(force: boolean): Promise<void>;
			}
		).probePublicHealth.bind(manager);

		await probe(true);
		await probe(true);
		await probe(true);
		expect(manager.getState()).toMatchObject({
			status: 'running',
			publicStatus: 'checking',
			publicError: 'DNS fallback unavailable'
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
			const response = new EventEmitter() as EventEmitter & { statusCode: number };
			response.statusCode = 200;
			const request = new EventEmitter() as EventEmitter & {
				end: () => void;
				destroy: (error?: Error) => void;
			};
			request.end = vi.fn(() => {
				(callback as (response: EventEmitter) => void)(response);
				response.emit('data', Buffer.from(JSON.stringify({ service: 'ungate', version: '1.7.14', protocolVersion: 3 })));
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
		expect(mocks.httpsRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				hostname: '104.16.230.132',
				servername: 'one.trycloudflare.com',
				headers: { host: 'one.trycloudflare.com' }
			}),
			expect.any(Function)
		);
	});
});
