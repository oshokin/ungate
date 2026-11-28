import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NgrokTokenStore, type NgrokSecretStorage } from '../../src/ngrok-token-store';
import { config } from '../../src/runtime-state/config';
import { RuntimeStateDefaults } from '../../src/runtime-state/default-state';
import { TunnelManager } from '../../src/tunnel-manager';

import type { LogEntry, RuntimeState } from '@ungate/shared/frontend';

const mocks = vi.hoisted(() => ({
	state: undefined as RuntimeState | undefined,
	alive: false,
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
		matches: (_pid: number, executable: string) => mocks.alive && executable === '/test/ngrok',
		isAlive: () => mocks.alive
	}
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

function secrets(token?: string): NgrokSecretStorage {
	return {
		get: () => Promise.resolve(token),
		store: () => Promise.resolve()
	};
}

beforeEach(() => {
	temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ungate-ngrok-'));
	config.baseDir = temporary;
	mocks.state = RuntimeStateDefaults.create();
	mocks.state.tunnelProvider = 'ngrok';
	mocks.alive = false;
	mocks.spawn.mockReset().mockImplementation((_binary: string, args: string[]) => {
		mocks.alive = true;
		const logPath = args[args.indexOf('--log') + 1];
		fs.writeFileSync(logPath, '{"url":"https://stable.ngrok-free.app","msg":"started tunnel"}\n');
		const child = Object.assign(new EventEmitter(), { pid: 4242, unref: vi.fn() });
		queueMicrotask(() => child.emit('spawn'));

		return child;
	});
});

afterEach(() => {
	config.baseDir = original;
	fs.rmSync(temporary, { recursive: true, force: true });
});

describe('ngrok tunnel', () => {
	it('journals health transitions with timestamps, without stable probe spam or raw errors', async () => {
		const journal = vi.fn<(entry: LogEntry) => void>();
		const manager = new TunnelManager('window-a', () => true, vi.fn(), journal);
		const identity = { pid: 4242, startedAt: 100, url: 'https://stable.ngrok-free.app' };
		Object.assign(mocks.state!.tunnel, { ...identity, status: 'running', publicStatus: 'reachable' });
		const probe = manager as unknown as {
			commitPublicProbe(target: typeof identity, error: string | null): Promise<void>;
		};
		for (let index = 0; index < 5; index++) await probe.commitPublicProbe(identity, 'network failure secret=never-log');
		await probe.commitPublicProbe(identity, null);
		await probe.commitPublicProbe(identity, null);
		expect(journal.mock.calls.map(([entry]) => entry.message)).toEqual([
			'Public tunnel health: reachable → checking (health check failed).',
			'Public tunnel health: checking → unreachable (health check failed).',
			'Public tunnel health: unreachable → reachable (health check succeeded).'
		]);
		expect(journal.mock.calls.every(([entry]) => Number.isFinite(entry.timestamp))).toBe(true);
		expect(JSON.stringify(journal.mock.calls)).not.toContain('never-log');
	});

	it('drops routine ngrok records before the journal callback without changing raw process logs', () => {
		const appendToJournal = vi.fn<(entry: LogEntry) => void>();
		const manager = new TunnelManager('window-a', () => true, vi.fn(), appendToJournal);
		const routine = {
			t: '2026-11-22T14:59:30+0300',
			lvl: 'info',
			obj: 'join',
			msg: 'join connections',
			id: 'sanitized-id',
			l: { IP: '127.0.0.1', Port: 47821, Zone: '' },
			r: { IP: '192.0.2.1', Port: 46970, Zone: '' }
		};
		const retained = [
			{ ...routine, lvl: 'warn' },
			{ ...routine, lvl: 'error' },
			{ ...routine, err: 'connection refused' },
			...['started tunnel', 'session established', 'session reconnecting', 'received stop request'].map((msg) => ({
				...routine,
				msg
			}))
		];
		const logPath = path.join(temporary, 'tunnel-ingestion.log');
		const raw = [routine, ...retained].map((entry) => JSON.stringify(entry)).join('\n') + '\n';
		fs.writeFileSync(logPath, raw);
		mocks.state!.tunnel.logPath = logPath;
		// Exercise the actual receive boundary without starting a process or monitor.
		(manager as unknown as { pollLogs(): void }).pollLogs();
		expect(appendToJournal).toHaveBeenCalledTimes(retained.length);
		expect(appendToJournal.mock.calls.map(([entry]) => [entry.level, entry.message])).toEqual([
			['warn', 'join connections'],
			['error', 'join connections'],
			['info', 'join connections · error: connection refused'],
			...['started tunnel', 'session established', 'session reconnecting', 'received stop request'].map((message) => [
				'info',
				message
			])
		]);
		expect(fs.readFileSync(logPath, 'utf8')).toBe(raw);
		(manager as unknown as { pollLogs(): void }).pollLogs();
		expect(appendToJournal).toHaveBeenCalledTimes(retained.length);
	});

	it('refuses to start without an authtoken', async () => {
		const manager = new TunnelManager('window-a', () => true, vi.fn(), vi.fn(), new NgrokTokenStore(secrets()));
		await expect(manager.start(47821)).rejects.toThrow('authtoken');
		expect(mocks.spawn).not.toHaveBeenCalled();
		expect(manager.getState().status).toBe('error');
	});

	it('starts ngrok against loopback and keeps the token out of the command line', async () => {
		const manager = new TunnelManager('window-a', () => true, vi.fn(), vi.fn(), new NgrokTokenStore(secrets('secret-token')));
		await manager.start(47821);
		expect(mocks.spawn).toHaveBeenCalledWith(
			'/test/ngrok',
			['http', 'http://127.0.0.1:47821', '--log', expect.stringMatching(/tunnel-.*\.log$/), '--log-format', 'json'],
			expect.objectContaining({
				detached: true,
				stdio: 'ignore',
				env: expect.objectContaining({ NGROK_AUTHTOKEN: 'secret-token' })
			})
		);
		const args = mocks.spawn.mock.calls[0][1] as string[];
		expect(args.join(' ')).not.toContain('secret-token');
		expect(manager.getState()).toMatchObject({ status: 'running', url: 'https://stable.ngrok-free.app' });
	});
});
