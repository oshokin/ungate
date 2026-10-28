import * as os from 'node:os';
import * as path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
	spawnSyncMock,
	execFileMock,
	existsSyncMock,
	readFileSyncMock,
	realpathSyncMock,
	isApiStartSuppressedMock,
	runtimeReadMock,
	suppressApiAutoStartMock
} = vi.hoisted(() => ({
	spawnSyncMock: vi.fn(),
	execFileMock: vi.fn(),
	existsSyncMock: vi.fn(),
	readFileSyncMock: vi.fn(),
	realpathSyncMock: vi.fn((target: unknown) => String(target)),
	isApiStartSuppressedMock: vi.fn(),
	runtimeReadMock: vi.fn(),
	suppressApiAutoStartMock: vi.fn()
}));

vi.mock('node:child_process', () => ({
	execFile: execFileMock,
	spawnSync: spawnSyncMock
}));
vi.mock('node:fs', () => ({
	existsSync: existsSyncMock,
	readFileSync: readFileSyncMock,
	realpathSync: realpathSyncMock
}));
vi.mock('../../src/runtime-state', () => ({
	RuntimeStateStore: {
		isApiStartSuppressed: isApiStartSuppressedMock,
		read: runtimeReadMock,
		suppressApiAutoStart: suppressApiAutoStartMock
	}
}));

import { BetterSqlite3Installer } from '../../src/utils/better-sqlite3-installer';

type ExecFileCallback = (error: Error | null, result: { stdout: string; stderr: string }) => void;

describe('BetterSqlite3Installer', () => {
	const apiDir = path.join(os.tmpdir(), 'ungate-api');

	beforeEach(() => {
		spawnSyncMock.mockReset();
		spawnSyncMock.mockReturnValue({
			status: 0,
			stdout: JSON.stringify({ platform: 'linux', arch: 'x64', isMusl: false }),
			stderr: ''
		});
		execFileMock.mockReset();
		execFileMock.mockImplementation((_file, _args, _options, callback: ExecFileCallback) => {
			callback(null, { stdout: '', stderr: '' });
		});
		existsSyncMock.mockReset();
		existsSyncMock.mockReturnValue(true);
		readFileSyncMock.mockReset();
		readFileSyncMock.mockReturnValue(JSON.stringify({ version: '13.0.3' }));
		realpathSyncMock.mockClear();
		isApiStartSuppressedMock.mockReset();
		isApiStartSuppressedMock.mockReturnValue(false);
		runtimeReadMock.mockReset();
		suppressApiAutoStartMock.mockReset();
		suppressApiAutoStartMock.mockResolvedValue(undefined);
	});

	it('selects the bundled glibc prebuild for the resolved runtime', () => {
		expect(BetterSqlite3Installer.resolveBindingPath(apiDir, process.execPath)).toBe(
			path.join(apiDir, 'node_modules', 'better-sqlite3', 'prebuilds', 'linux-x64.node')
		);
	});

	it('selects the bundled musl prebuild', () => {
		spawnSyncMock.mockReturnValue({
			status: 0,
			stdout: JSON.stringify({ platform: 'linux', arch: 'arm64', isMusl: true }),
			stderr: ''
		});

		expect(BetterSqlite3Installer.resolveBindingPath(apiDir, process.execPath)).toBe(
			path.join(apiDir, 'node_modules', 'better-sqlite3', 'prebuilds', 'linuxmusl-arm64.node')
		);
	});

	it('fails closed for an unsupported platform tuple', () => {
		spawnSyncMock.mockReturnValue({
			status: 0,
			stdout: JSON.stringify({ platform: 'freebsd', arch: 'x64', isMusl: false }),
			stderr: ''
		});

		expect(() => BetterSqlite3Installer.resolveBindingPath(apiDir, process.execPath)).toThrow(
			'has no bundled prebuild for freebsd-x64'
		);
	});

	it('loads the bundled prebuild without downloading or compiling', async () => {
		const onLog = vi.fn();

		await BetterSqlite3Installer.ensureInstalled(apiDir, process.execPath, { onLog });

		expect(execFileMock).toHaveBeenCalledTimes(1);
		const execArgs = execFileMock.mock.calls[0]?.[1] as string[] | undefined;
		const expectedBinding = path.join(apiDir, 'node_modules', 'better-sqlite3', 'prebuilds', 'linux-x64.node');

		expect(execArgs?.[1]).toContain(JSON.stringify(expectedBinding));
		expect(onLog).toHaveBeenCalledWith('info', '[native] better-sqlite3 13.0.3 bundled prebuild is ready');
	});

	it('rejects a package version that does not match the bundled runtime contract', async () => {
		readFileSyncMock.mockReturnValue(JSON.stringify({ version: '13.0.2' }));

		await expect(BetterSqlite3Installer.ensureInstalled(apiDir, process.execPath, { onLog: vi.fn() })).rejects.toThrow(
			'Expected better-sqlite3 13.0.3, but the bundle contains 13.0.2'
		);
	});

	it('suppresses API auto-start when the bundled prebuild cannot load', async () => {
		execFileMock.mockImplementation((_file, _args, _options, callback: ExecFileCallback) => {
			const error = Object.assign(new Error('load failed'), { stderr: 'invalid ELF header' });
			callback(error, { stdout: '', stderr: 'invalid ELF header' });
		});

		await expect(BetterSqlite3Installer.ensureInstalled(apiDir, process.execPath, { onLog: vi.fn() })).rejects.toThrow(
			'bundled prebuild failed to load'
		);
		expect(suppressApiAutoStartMock).toHaveBeenCalledTimes(1);
	});

	it('does not retry after a shared native failure was recorded', async () => {
		isApiStartSuppressedMock.mockReturnValue(true);
		runtimeReadMock.mockReturnValue({ api: { lastError: '[native] previous failure' } });

		await expect(BetterSqlite3Installer.ensureInstalled(apiDir, process.execPath, { onLog: vi.fn() })).rejects.toThrow(
			'[native] previous failure'
		);
		expect(execFileMock).not.toHaveBeenCalled();
	});
});
