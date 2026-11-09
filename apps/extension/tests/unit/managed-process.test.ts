import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ManagedProcess } from '../../src/utils/managed-process';
import { PROCESS_PROBE_TIMEOUT_MS } from '../../src/utils/process-limits';

const bridge = vi.hoisted(() => ({
	readFileSync: vi.fn<(...args: unknown[]) => unknown>(),
	realpathSync: vi.fn<(...args: unknown[]) => unknown>(),
	execFileSync: vi.fn<(...args: unknown[]) => unknown>(),
	useMock: false
}));

vi.mock('node:fs', async () => {
	const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
	const readFileSync = ((...args: unknown[]) =>
		bridge.useMock
			? bridge.readFileSync(...args)
			: actual.readFileSync(...(args as [string, BufferEncoding]))) as typeof actual.readFileSync;
	const realpathSync = ((...args: unknown[]) =>
		bridge.useMock ? bridge.realpathSync(...args) : actual.realpathSync(args[0] as string)) as typeof actual.realpathSync;

	return { ...actual, readFileSync, realpathSync };
});
vi.mock('node:child_process', async () => {
	const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
	const execFileSync = ((...args: unknown[]) =>
		bridge.useMock
			? bridge.execFileSync(...args)
			: actual.execFileSync(...(args as Parameters<typeof actual.execFileSync>))) as typeof actual.execFileSync;

	return { ...actual, execFileSync };
});

const originalPlatform = process.platform;
const pid = 4242;

function setPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, 'platform', { value: platform });
}

afterEach(() => {
	setPlatform(originalPlatform);
	bridge.useMock = false;
	bridge.readFileSync.mockReset();
	bridge.realpathSync.mockReset();
	bridge.execFileSync.mockReset();
	vi.unstubAllEnvs();
});

describe('ManagedProcess.ownsUngateApi', () => {
	it('recognizes the API entry on unix, macos, and windows paths', () => {
		expect(ManagedProcess.ownsUngateApi(['node', 'bundle/main.cjs'], '/opt/ungate/bundled/api')).toBe(true);
		expect(ManagedProcess.ownsUngateApi(['node', '/Users/dev/ungate/apps/api/dist/main.js'], '/Users/dev/ungate/apps/api')).toBe(
			true
		);
		expect(
			ManagedProcess.ownsUngateApi(
				['node.exe', 'C:\\Users\\dev\\.ungate\\bundled\\api\\bundle\\main.cjs'],
				'C:\\Users\\dev\\.ungate\\bundled\\api'
			)
		).toBe(true);
		expect(ManagedProcess.ownsUngateApi(['node.exe', 'dist\\main.js'], 'D:\\src\\apps\\api\\')).toBe(true);
	});

	it('rejects chrome and any other reused pid on unix, macos, and windows', () => {
		expect(
			ManagedProcess.ownsUngateApi(
				['/opt/google/chrome/chrome', '--type=utility', '--utility-sub-type=network.mojom.NetworkService'],
				'/opt/google/chrome'
			)
		).toBe(false);
		expect(
			ManagedProcess.ownsUngateApi(
				[
					'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
					'--type=utility',
					'--utility-sub-type=network.mojom.NetworkService'
				],
				'/Applications/Google Chrome.app'
			)
		).toBe(false);
		expect(
			ManagedProcess.ownsUngateApi(
				[
					'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
					'--type=utility',
					'--utility-sub-type=network.mojom.NetworkService'
				],
				'C:\\Program Files\\Google\\Chrome\\Application'
			)
		).toBe(false);
		expect(ManagedProcess.ownsUngateApi(['node', 'bundle/main.cjs'], '/tmp/other-app')).toBe(false);
		expect(ManagedProcess.ownsUngateApi(['node.exe', 'bundle\\main.cjs'], 'C:\\other-app')).toBe(false);
	});
});

describe('ManagedProcess.isUngateApi', () => {
	it('reads /proc on linux', () => {
		setPlatform('linux');
		bridge.useMock = true;
		bridge.readFileSync.mockReturnValue(['/opt/google/chrome/chrome', '--type=utility'].join('\0'));
		bridge.realpathSync.mockReturnValue('/opt/google/chrome');

		expect(ManagedProcess.isUngateApi(pid)).toBe(false);

		bridge.readFileSync.mockReturnValue(['node', '/opt/ungate/bundled/api/bundle/main.cjs'].join('\0'));
		bridge.realpathSync.mockReturnValue('/opt/ungate/bundled/api');

		expect(ManagedProcess.isUngateApi(pid)).toBe(true);
		expect(bridge.readFileSync).toHaveBeenCalledWith(`/proc/${pid}/cmdline`, 'utf8');
		expect(bridge.realpathSync).toHaveBeenCalledWith(`/proc/${pid}/cwd`);
		expect(bridge.execFileSync).not.toHaveBeenCalled();
	});

	it('reads ps on macos', () => {
		setPlatform('darwin');
		bridge.useMock = true;
		bridge.execFileSync.mockReturnValue(
			'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=utility --utility-sub-type=network.mojom.NetworkService\n'
		);

		expect(ManagedProcess.isUngateApi(pid)).toBe(false);

		bridge.execFileSync.mockReturnValue('/usr/local/bin/node /Users/dev/ungate/apps/api/dist/main.js\n');

		expect(ManagedProcess.isUngateApi(pid)).toBe(true);
		expect(bridge.execFileSync).toHaveBeenCalledWith('ps', ['-p', String(pid), '-o', 'command='], {
			encoding: 'utf8',
			timeout: PROCESS_PROBE_TIMEOUT_MS
		});
	});

	it('reads Win32_Process on windows', () => {
		setPlatform('win32');
		vi.stubEnv('SystemRoot', 'C:\\Windows');
		bridge.useMock = true;
		bridge.execFileSync.mockReturnValue(
			JSON.stringify({
				CommandLine:
					'"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --type=utility --utility-sub-type=network.mojom.NetworkService'
			})
		);

		expect(ManagedProcess.isUngateApi(pid)).toBe(false);

		bridge.execFileSync.mockReturnValue(
			JSON.stringify({ CommandLine: '"C:\\Program Files\\nodejs\\node.exe" bundle\\main.cjs' })
		);

		expect(ManagedProcess.isUngateApi(pid)).toBe(true);
		expect(bridge.execFileSync).toHaveBeenCalledWith(
			path.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
			[
				'-NoProfile',
				'-NonInteractive',
				'-Command',
				`Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object CommandLine | ConvertTo-Json -Compress`
			],
			{ encoding: 'utf8', timeout: PROCESS_PROBE_TIMEOUT_MS, windowsHide: true }
		);
	});

	it('returns false when the platform probe fails', () => {
		setPlatform('darwin');
		bridge.useMock = true;
		bridge.execFileSync.mockImplementation(() => {
			throw new Error('ps failed');
		});

		expect(ManagedProcess.isUngateApi(pid)).toBe(false);
	});

	it('does not treat this test process or an invalid pid as the Ungate API', () => {
		expect(ManagedProcess.isUngateApi(process.pid)).toBe(false);
		expect(ManagedProcess.isUngateApi(0)).toBe(false);
		expect(ManagedProcess.isUngateApi(null)).toBe(false);
	});
});
