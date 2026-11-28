import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from 'vitest';

import { NgrokTokenStore, type NgrokSecretStorage } from '../../src/ngrok-token-store';
import { config } from '../../src/runtime-state/config';
import { RuntimeStateDefaults } from '../../src/runtime-state/default-state';
import { TunnelManager } from '../../src/tunnel-manager';
import { NgrokInstaller } from '../../src/utils/ngrok-installer';

import type { LogEntry, RuntimeState } from '@ungate/shared/frontend';

const CLOUDFLARED = '/test/cloudflared';
const NGROK = '/test/ngrok';

const mocks = vi.hoisted(() => ({
	state: undefined as RuntimeState | undefined,
	processes: new Map<number, string>(),
	foreign: new Set<number>(),
	spawn: vi.fn()
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
	ManagedProcess: {
		matches: (pid: number, executable: string) => mocks.processes.get(pid) === executable,
		isAlive: (pid: number) => mocks.processes.has(pid) || mocks.foreign.has(pid)
	}
}));
vi.mock('../../src/utils/cloudflared-installer', () => ({
	CLOUDFLARED_VERSION: 'pinned',
	CloudflaredInstaller: { isPinnedInstall: () => true, install: vi.fn() }
}));
vi.mock('../../src/utils/ngrok-installer', () => ({
	NGROK_VERSION: '3.39.13',
	getNgrokBinPath: () => '/test/ngrok',
	NgrokInstaller: { isPinnedInstall: () => true, install: vi.fn() }
}));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('vscode', () => ({ workspace: { getConfiguration: () => ({ inspect: () => ({}) }) } }));

const original = config.baseDir;
let temporary: string;
let kill: MockInstance;

function secrets(token?: string): NgrokSecretStorage {
	return { get: () => Promise.resolve(token), store: () => Promise.resolve() };
}

function manager(token?: string, onLog: Mock<(entry: LogEntry) => void> = vi.fn<(entry: LogEntry) => void>()): TunnelManager {
	return new TunnelManager('window-a', () => false, vi.fn(), onLog, new NgrokTokenStore(secrets(token)));
}

function live(pid: number, executable: string, url: string): void {
	mocks.processes.set(pid, executable);
	Object.assign(mocks.state!.tunnel, {
		status: 'running',
		pid,
		port: 47821,
		url,
		logPath: path.join(temporary, `tunnel-${pid}.log`),
		protocol: 'http2',
		startedAt: 1,
		lastError: null,
		ownerWindowId: 'window-a'
	});
}

beforeEach(() => {
	temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ungate-tunnel-select-'));
	config.baseDir = temporary;
	mocks.state = RuntimeStateDefaults.create();
	mocks.processes.clear();
	mocks.foreign.clear();
	kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
		mocks.processes.delete(Number(pid));

		return true;
	});
	mocks.spawn.mockReset().mockImplementation((binary: string, args: string[]) => {
		const flag = binary === NGROK ? '--log' : '--logfile';
		const logPath = args[args.indexOf(flag) + 1];
		const pid = binary === NGROK ? 7001 : 7002;
		mocks.processes.set(pid, binary);
		fs.writeFileSync(
			logPath,
			binary === NGROK
				? '{"lvl":"info","t":"2026-11-21T09:00:00Z","msg":"started tunnel","url":"https://stable.ngrok-free.app"}\n'
				: 'https://one.trycloudflare.com\nRegistered tunnel connection\n'
		);
		const child = Object.assign(new EventEmitter(), { pid, unref: vi.fn() });
		queueMicrotask(() => child.emit('spawn'));

		return child;
	});
});

afterEach(() => {
	kill.mockRestore();
	config.baseDir = original;
	fs.rmSync(temporary, { recursive: true, force: true });
});

describe('tunnel selection', () => {
	/* eslint-disable @typescript-eslint/require-await -- Promise-based lifecycle callbacks with synchronous race injection. */
	it('acknowledges persisted selection before deferred installation finishes', async () => {
		live(111, CLOUDFLARED, 'https://old.example');
		let finish!: () => void;
		let entered!: () => void;
		const installing = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const deferred = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const pinned = vi.spyOn(NgrokInstaller, 'isPinnedInstall').mockReturnValue(false);
		const install = vi.spyOn(NgrokInstaller, 'install').mockImplementation(async () => {
			entered();
			await deferred;

			return NGROK;
		});
		const acknowledge = vi.fn(async () => {
			expect(mocks.state!.tunnelProvider).toBe('ngrok');
			expect(install).not.toHaveBeenCalled();
		});
		const selected = manager('secret').selectProvider(
			'ngrok',
			async () => true,
			async () => 'http2',
			acknowledge
		);
		try {
			await installing;
			expect(acknowledge).toHaveBeenCalledOnce();
			expect(mocks.state!.tunnel.status).toBe('installing');
			expect(mocks.spawn).not.toHaveBeenCalled();
		} finally {
			finish();
			await selected;
			pinned.mockRestore();
			install.mockRestore();
		}
	});

	it('derives provider from the verified executable for legacy state, never from preference or URL', () => {
		mocks.state!.tunnelProvider = 'ngrok';
		live(111, CLOUDFLARED, 'https://misleading.ngrok-free.app');
		expect(manager().getState().provider).toBe('quick');
		mocks.processes.delete(111);
		expect(manager().getState().provider).toBeNull();
	});

	it('serializes opposite selections from two windows under the lifecycle lock', async () => {
		live(111, CLOUDFLARED, 'https://old.example');
		let allow!: (value: boolean) => void;
		let entered!: () => void;
		const enteredModal = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const confirmation = new Promise<boolean>((resolve) => {
			allow = resolve;
		});
		const first = manager('secret').selectProvider(
			'ngrok',
			() => {
				entered();

				return confirmation;
			},
			async () => 'http2'
		);
		await enteredModal;
		const secondConfirm = vi.fn().mockResolvedValue(true);
		const second = manager('secret').selectProvider('quick', secondConfirm, async () => 'http2');
		expect(secondConfirm).not.toHaveBeenCalled();
		expect(mocks.state!.tunnelProvider).toBe('quick');
		allow(true);
		await Promise.all([first, second]);
		expect(secondConfirm).toHaveBeenCalledOnce();
		expect(mocks.spawn.mock.calls.map((call) => call[0])).toEqual([NGROK, CLOUDFLARED]);
		expect(mocks.state!.tunnelProvider).toBe('quick');
		expect(manager().getState().provider).toBe('quick');
	});

	it.each(['quick', 'ngrok'] as const)('selects %s while stopped without launching', async (provider) => {
		mocks.state!.tunnelProvider = provider === 'quick' ? 'ngrok' : 'quick';
		const confirm = vi.fn();
		await manager().selectProvider(provider, confirm, async () => 'http2');
		expect(mocks.state!.tunnelProvider).toBe(provider);
		expect(confirm).not.toHaveBeenCalled();
		expect(mocks.spawn).not.toHaveBeenCalled();
	});

	it.each(['quick', 'ngrok'] as const)('does not replace a different launch after %s confirmation', async (provider) => {
		mocks.state!.tunnelProvider = provider === 'quick' ? 'ngrok' : 'quick';
		live(111, provider === 'quick' ? NGROK : CLOUDFLARED, 'https://old.example');
		await manager('secret').selectProvider(
			provider,
			() => {
				live(222, provider === 'quick' ? NGROK : CLOUDFLARED, 'https://new.example');

				return Promise.resolve(true);
			},
			() => Promise.resolve('http2')
		);
		expect(kill).not.toHaveBeenCalled();
		expect(mocks.spawn).not.toHaveBeenCalled();
		expect(mocks.state!.tunnel.pid).toBe(222);
	});

	it.each(['quick', 'ngrok'] as const)('preserves a live tunnel on cancelled %s selection', async (provider) => {
		mocks.state!.tunnelProvider = provider === 'quick' ? 'ngrok' : 'quick';
		live(111, provider === 'quick' ? NGROK : CLOUDFLARED, 'https://old.example');
		await manager('secret').selectProvider(
			provider,
			async () => false,
			async () => 'http2'
		);
		expect(mocks.state!.tunnelProvider).not.toBe(provider);
		expect(mocks.spawn).not.toHaveBeenCalled();
		expect(kill).not.toHaveBeenCalled();
	});

	it.each(['quick', 'ngrok'] as const)('does not resurrect a stopped tunnel during %s confirmation', async (provider) => {
		mocks.state!.tunnelProvider = provider === 'quick' ? 'ngrok' : 'quick';
		live(111, provider === 'quick' ? NGROK : CLOUDFLARED, 'https://old.example');
		await manager('secret').selectProvider(
			provider,
			async () => {
				mocks.state!.tunnel.status = 'stopped';

				return true;
			},
			async () => 'http2'
		);
		expect(mocks.spawn).not.toHaveBeenCalled();
		expect(kill).not.toHaveBeenCalled();
		expect(mocks.state!.tunnelProvider).not.toBe(provider);
	});

	it.each(['quick', 'ngrok'] as const)('launches explicit %s even if an old writer changes the preference', async (provider) => {
		mocks.state!.tunnelProvider = provider === 'quick' ? 'ngrok' : 'quick';
		live(111, provider === 'quick' ? NGROK : CLOUDFLARED, 'https://old.example');
		const tunnel = manager('secret');
		await tunnel.selectProvider(
			provider,
			async () => true,
			async () => {
				mocks.state!.tunnelProvider = provider === 'quick' ? 'ngrok' : 'quick';

				return 'http2';
			}
		);
		expect(mocks.spawn.mock.calls[0][0]).toBe(provider === 'quick' ? CLOUDFLARED : NGROK);
		expect(tunnel.getState().provider).toBe(provider);
	});

	it.each(['quick', 'ngrok'] as const)('reports actual provider when %s replacement fails before stopping', async (provider) => {
		const previous = provider === 'quick' ? 'ngrok' : 'quick';
		mocks.state!.tunnelProvider = previous;
		live(111, previous === 'quick' ? CLOUDFLARED : NGROK, 'https://old.example');
		const tunnel = manager('secret');
		await expect(
			tunnel.selectProvider(
				provider,
				async () => true,
				async () => {
					throw new Error('settings unavailable');
				}
			)
		).rejects.toThrow('settings unavailable');
		expect(mocks.state!.tunnelProvider).toBe(provider);
		expect(tunnel.getState()).toMatchObject({ provider: previous, status: 'running', url: 'https://old.example' });
		expect(kill).not.toHaveBeenCalled();
	});

	/* eslint-enable @typescript-eslint/require-await */
	it.each(['quick', 'ngrok'] as const)('rejects %s URLs when the launched process already exited', async (provider) => {
		mocks.state!.tunnelProvider = provider;
		const spawn = mocks.spawn.getMockImplementation()!;
		mocks.spawn.mockImplementation((...args: Parameters<typeof spawn>) => {
			const child = spawn(...args) as EventEmitter & { pid: number };
			mocks.processes.delete(child.pid);

			return child;
		});
		await expect(manager('secret').start(47821)).rejects.toThrow('exited before connecting');
		expect(mocks.state!.tunnel).toMatchObject({ status: 'error', url: null });
		expect(kill).not.toHaveBeenCalled();
	});

	it('adopts the running ngrok process instead of starting a second one', async () => {
		mocks.state!.tunnelProvider = 'ngrok';
		live(4242, NGROK, 'https://stable.ngrok-free.app');
		await manager('secret').start(47821);
		expect(mocks.spawn).not.toHaveBeenCalled();
		expect(kill).not.toHaveBeenCalled();
		expect(mocks.state!.tunnel).toMatchObject({ pid: 4242, url: 'https://stable.ngrok-free.app', status: 'running' });
	});

	it('stops a verified Cloudflare process before starting ngrok', async () => {
		mocks.state!.tunnelProvider = 'ngrok';
		live(111, CLOUDFLARED, 'https://one.trycloudflare.com');
		await manager('secret').start(47821);
		expect(kill).toHaveBeenCalledWith(111, 'SIGTERM');
		expect(mocks.spawn).toHaveBeenCalledTimes(1);
		expect(mocks.spawn).toHaveBeenCalledWith(NGROK, expect.any(Array), expect.any(Object));
		expect(mocks.state!.tunnel).toMatchObject({ pid: 7001, url: 'https://stable.ngrok-free.app', status: 'running' });
		expect(mocks.processes.has(111)).toBe(false);
	});

	it('stops a verified ngrok process before starting Cloudflare', async () => {
		mocks.state!.tunnelProvider = 'quick';
		live(222, NGROK, 'https://stable.ngrok-free.app');
		await manager('secret').start(47821);
		expect(kill).toHaveBeenCalledWith(222, 'SIGTERM');
		expect(mocks.spawn).toHaveBeenCalledTimes(1);
		expect(mocks.spawn).toHaveBeenCalledWith(CLOUDFLARED, expect.any(Array), expect.any(Object));
		expect(mocks.state!.tunnel).toMatchObject({ pid: 7002, url: 'https://one.trycloudflare.com', status: 'running' });
	});

	it('restarts Cloudflare when the saved tunnel uses another protocol', async () => {
		mocks.state!.tunnelProvider = 'quick';
		live(333, CLOUDFLARED, 'https://one.trycloudflare.com');
		mocks.state!.tunnel.protocol = 'http2';
		await manager().start(47821, 'quic');
		expect(kill).toHaveBeenCalledWith(333, 'SIGTERM');
		expect(mocks.spawn).toHaveBeenCalledTimes(1);
		expect(mocks.spawn.mock.calls[0][1]).toEqual(expect.arrayContaining(['--protocol', 'quic']));
	});

	it('refuses a second tunnel when the saved PID is not cloudflared or ngrok', async () => {
		mocks.foreign.add(999);
		Object.assign(mocks.state!.tunnel, {
			status: 'running',
			pid: 999,
			port: 47821,
			url: 'https://foreign.example',
			logPath: path.join(temporary, 'foreign.log')
		});
		await expect(manager('secret').start(47821)).rejects.toThrow('unverified process');
		expect(mocks.spawn).not.toHaveBeenCalled();
		expect(kill).not.toHaveBeenCalled();
		expect(mocks.state!.tunnel).toMatchObject({ pid: 999, url: 'https://foreign.example', status: 'running' });
	});

	it('refuses to stop an unverified process', async () => {
		mocks.foreign.add(999);
		Object.assign(mocks.state!.tunnel, { status: 'running', pid: 999, url: 'https://foreign.example' });
		await expect(manager().stop()).rejects.toThrow('unrelated process');
		await expect(manager().restart(47821)).rejects.toThrow('unrelated process');
		expect(mocks.spawn).not.toHaveBeenCalled();
		expect(kill).not.toHaveBeenCalled();
		expect(mocks.state!.tunnel.pid).toBe(999);
	});

	it('starts the selected tunnel when the saved PID is already dead', async () => {
		Object.assign(mocks.state!.tunnel, { status: 'error', pid: 5, url: 'https://old.trycloudflare.com', port: 47821 });
		await manager().start(47821);
		expect(kill).not.toHaveBeenCalled();
		expect(mocks.spawn).toHaveBeenCalledTimes(1);
		expect(mocks.state!.tunnel).toMatchObject({ pid: 7002, status: 'running' });
	});

	it('keeps the running Cloudflare process when ngrok has no authtoken', async () => {
		mocks.state!.tunnelProvider = 'ngrok';
		live(111, CLOUDFLARED, 'https://one.trycloudflare.com');
		const tunnel = manager();
		await expect(tunnel.start(47821)).rejects.toThrow('authtoken');
		await expect(tunnel.restart(47821)).rejects.toThrow('authtoken');
		expect(mocks.spawn).not.toHaveBeenCalled();
		expect(kill).not.toHaveBeenCalled();
		expect(mocks.state!.tunnel).toMatchObject({
			pid: 111,
			status: 'running',
			url: 'https://one.trycloudflare.com'
		});
	});

	it('publishes one complete ngrok log line and waits for an unfinished line', () => {
		const logPath = path.join(temporary, 'tunnel-ngrok.log');
		const onLog = vi.fn<(entry: LogEntry) => void>();
		const tunnel = manager(undefined, onLog);
		mocks.state!.tunnel.logPath = logPath;
		fs.writeFileSync(logPath, '{"lvl":"warn","msg":"session closed","err":"dial tcp: i/o timeout"}');
		(tunnel as unknown as { pollLogs(): void }).pollLogs();
		expect(onLog).not.toHaveBeenCalled();
		fs.appendFileSync(logPath, '\n{"msg":"client connected"}\n');
		(tunnel as unknown as { pollLogs(): void }).pollLogs();
		(tunnel as unknown as { pollLogs(): void }).pollLogs();
		expect(onLog).toHaveBeenCalledTimes(2);
		const messages = onLog.mock.calls.map((call) => call[0].message);
		expect(messages).toEqual(['session closed · error: dial tcp: i/o timeout', 'client connected']);
		expect(onLog.mock.calls[0][0].level).toBe('warn');
	});

	it('hides routine ngrok joins without rewriting the raw log or losing lifecycle and errors', () => {
		const logPath = path.join(temporary, 'tunnel-ngrok.log');
		const onLog = vi.fn<(entry: LogEntry) => void>();
		const tunnel = manager(undefined, onLog);
		mocks.state!.tunnel.logPath = logPath;
		const raw =
			[
				{ lvl: 'info', obj: 'join', msg: 'join connections' },
				{ lvl: 'info', obj: 'tunnels', msg: 'started tunnel' },
				{ lvl: 'error', obj: 'join', msg: 'join connections', err: 'failed' }
			]
				.map((entry) => JSON.stringify(entry))
				.join('\n') + '\n';
		fs.writeFileSync(logPath, raw);
		(tunnel as unknown as { pollLogs(): void }).pollLogs();
		expect(onLog.mock.calls.map(([entry]) => entry.message)).toEqual(['started tunnel', 'join connections · error: failed']);
		expect(onLog.mock.calls[1][0].level).toBe('error');
		expect(fs.readFileSync(logPath, 'utf8')).toBe(raw);
	});
});
