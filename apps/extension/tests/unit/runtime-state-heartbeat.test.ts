import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { config } from '../../src/runtime-state/config';
import { RuntimeStateStore } from '../../src/runtime-state/runtime-state-store';

describe('window heartbeat persistence', () => {
	let directory: string;
	let previousBaseDir: string;
	let previousPaths: typeof config.paths;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), 'ungate-heartbeat-'));
		previousBaseDir = config.baseDir;
		previousPaths = { ...config.paths };
		config.baseDir = directory;
		config.paths = {
			stateFilePath: join(directory, 'runtime-state.json'),
			lockPath: join(directory, 'runtime-state.lock'),
			logDir: join(directory, 'logs')
		};
	});

	afterEach(() => {
		config.baseDir = previousBaseDir;
		config.paths = previousPaths;
		rmSync(directory, { recursive: true, force: true });
	});

	it('does not rewrite state while this window is still fresh and no client expired', async () => {
		await RuntimeStateStore.touchClient('window');
		const before = readFileSync(config.paths.stateFilePath, 'utf8');
		await RuntimeStateStore.touchClient('window');
		expect(readFileSync(config.paths.stateFilePath, 'utf8')).toBe(before);
	});

	it('rewrites state once the stored heartbeat reaches half the liveness window', async () => {
		await RuntimeStateStore.touchClient('window');
		const raw = JSON.parse(readFileSync(config.paths.stateFilePath, 'utf8')) as {
			clients: Record<string, { lastSeenAt: number }>;
		};
		raw.clients.window.lastSeenAt = Date.now() - config.runtimeState.staleClientMs / 2;
		writeFileSync(config.paths.stateFilePath, JSON.stringify(raw));
		await RuntimeStateStore.touchClient('window');
		const next = JSON.parse(readFileSync(config.paths.stateFilePath, 'utf8')) as {
			clients: Record<string, { lastSeenAt: number }>;
		};
		expect(next.clients.window.lastSeenAt).toBeGreaterThan(raw.clients.window.lastSeenAt);
	});

	it('removes a stale window even when this window does not need a new heartbeat', async () => {
		await RuntimeStateStore.touchClient('window');
		const raw = JSON.parse(readFileSync(config.paths.stateFilePath, 'utf8')) as {
			clients: Record<string, { lastSeenAt: number }>;
		};
		raw.clients.other = { lastSeenAt: Date.now() - config.runtimeState.staleClientMs - 1 };
		writeFileSync(config.paths.stateFilePath, JSON.stringify(raw));
		await RuntimeStateStore.touchClient('window');
		const next = JSON.parse(readFileSync(config.paths.stateFilePath, 'utf8')) as {
			clients: Record<string, { lastSeenAt: number } | undefined>;
		};
		expect(next.clients.other).toBeUndefined();
		expect(next.clients.window?.lastSeenAt).toBe(raw.clients.window.lastSeenAt);
	});
});
