import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NodeResolver } from '../../src/utils/node-resolver';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), exists: vi.fn(), read: vi.fn() }));
vi.mock('node:child_process', () => ({ spawnSync: mocks.spawn }));
vi.mock('node:fs', () => ({ existsSync: mocks.exists, readdirSync: mocks.read }));
vi.mock('node:os', () => ({ homedir: () => (process.platform === 'win32' ? 'C:\\Users\\test' : '/home/test') }));
const originalPlatform = process.platform;
const originalExec = process.execPath;
function report(execPath = '/usr/bin/node', extra: Record<string, unknown> = {}) {
	return {
		status: 0,
		stdout: JSON.stringify({
			version: '24.22.1',
			napi: 10,
			abi: '137',
			platform: process.platform,
			arch: 'x64',
			execPath,
			...extra
		}),
		stderr: ''
	};
}
function windows() {
	Object.defineProperty(process, 'platform', { value: 'win32' });
	Object.defineProperty(process, 'execPath', { value: 'C:\\Cursor\\Cursor.exe' });
}
beforeEach(() => {
	vi.resetAllMocks();
	Object.defineProperty(process, 'platform', { value: 'linux' });
	Object.defineProperty(process, 'execPath', { value: '/opt/cursor/cursor' });
	for (const key of [
		'PATH',
		'Path',
		'NVM_HOME',
		'NVM_SYMLINK',
		'NVM_DIR',
		'ASDF_DATA_DIR',
		'FNM_DIR',
		'FNM_MULTISHELL_PATH',
		'ProgramFiles',
		'PROGRAMFILES',
		'ProgramW6432',
		'APPDATA',
		'LOCALAPPDATA',
		'VOLTA_HOME'
	])
		vi.stubEnv(key, '');
	mocks.spawn.mockReturnValue({
		status: 1,
		stdout: '',
		stderr: '',
		error: Object.assign(new Error('missing'), { code: 'ENOENT' })
	});
	mocks.exists.mockReturnValue(false);
	mocks.read.mockReturnValue([]);
});
afterEach(() => {
	vi.unstubAllEnvs();
	Object.defineProperty(process, 'platform', { value: originalPlatform });
	Object.defineProperty(process, 'execPath', { value: originalExec });
});

describe('standalone Node discovery', () => {
	it('returns a canonical executable instead of keeping a version-manager shim', () => {
		mocks.spawn.mockReturnValue(report('/opt/node/bin/node'));
		expect(NodeResolver.resolve('"/home/test/.volta/bin/node"')).toBe('/opt/node/bin/node');
	});
	it('accepts a new module ABI when the Node-API contract is compatible', () => {
		mocks.spawn.mockReturnValue(report('/opt/node/bin/node', { version: '26.1.0', abi: '999', napi: 10 }));
		expect(NodeResolver.resolve('/opt/node/bin/node')).toBe('/opt/node/bin/node');
	});
	it('rejects old Node-API even when its module ABI used to be allowlisted', () => {
		mocks.spawn.mockReturnValue(report('/opt/node/bin/node', { version: '22.13.0', napi: 9, abi: '127' }));
		const log = vi.fn();
		expect(() => NodeResolver.resolve('/opt/node/bin/node', log)).toThrow('configured Node.js');
		expect(log.mock.calls.flat().join(' ')).toContain('Node-API 10');
	});
	it('does not silently bypass an invalid explicit override', () => {
		mocks.spawn.mockReturnValue(report('/opt/node/bin/node', { version: '20.18.0' }));
		expect(() => NodeResolver.resolve('/custom/node')).toThrow('configured Node.js');
		expect(mocks.spawn).toHaveBeenCalledTimes(1);
	});
	it('finds standard Windows installation even with stale PATH and differently cased environment keys', () => {
		windows();
		vi.stubEnv('ProgramFiles', undefined);
		vi.stubEnv('PROGRAMFILES', 'C:\\Program Files');
		const node = 'C:\\Program Files\\nodejs\\node.exe';
		mocks.exists.mockImplementation((p) => p === node);
		mocks.spawn.mockImplementation((p) =>
			p === node ? report(node) : { error: Object.assign(new Error(), { code: 'ENOENT' }) }
		);
		expect(NodeResolver.resolve()).toBe(node);
	});
	it('passes a Windows executable with spaces and Cyrillic directly without a shell', () => {
		windows();
		const node = String.raw`C:\Пользователи\Олег Шокин\Node.js\node.exe`;
		mocks.spawn.mockReturnValue(report(node));
		expect(NodeResolver.resolve(`"${node}"`)).toBe(node);
		expect(mocks.spawn).toHaveBeenCalledWith(
			node,
			expect.any(Array),
			expect.objectContaining({ windowsHide: true, shell: false })
		);
	});

	it('uses the nvm-windows version root without an invented bin directory', () => {
		windows();
		vi.stubEnv('NVM_HOME', 'D:\\nvm');
		const node = 'D:\\nvm\\v24.22.1\\node.exe';
		mocks.read.mockImplementation((p) => (p === 'D:\\nvm' ? ['v24.22.1'] : []));
		mocks.exists.mockImplementation((p) => p === node);
		mocks.spawn.mockImplementation((p) => (p === node ? report(node) : { error: new Error('missing') }));
		expect(NodeResolver.resolve()).toBe(node);
		expect(mocks.spawn.mock.calls.map((c: unknown[]) => c[0])).not.toContain('D:\\nvm\\v24.22.1\\bin\\node.exe');
	});
	it('finds fnm on Windows without requiring a login shell', () => {
		windows();
		vi.stubEnv('FNM_DIR', 'D:\\fnm');
		const node = 'D:\\fnm\\node-versions\\v24.22.1\\installation\\node.exe';
		mocks.read.mockImplementation((p) => (p === 'D:\\fnm\\node-versions' ? ['v24.22.1'] : []));
		mocks.exists.mockImplementation((p) => p === node);
		mocks.spawn.mockImplementation((p) => (p === node ? report(node) : { error: new Error('missing') }));
		expect(NodeResolver.resolve()).toBe(node);
	});
	it('tries later PATH installations after an incompatible first Node', () => {
		vi.stubEnv('PATH', '/old/bin:/new/bin');
		mocks.exists.mockReturnValue(true);
		mocks.spawn.mockImplementation((p) =>
			p === '/new/bin/node' ? report('/new/bin/node') : report('/old/bin/node', { version: '20.18.0' })
		);
		expect(NodeResolver.resolve()).toBe('/new/bin/node');
	});
	it('respects NVM_DIR and sorts installed versions numerically', () => {
		vi.stubEnv('NVM_DIR', '/custom/nvm');
		mocks.read.mockImplementation((p) => (p === '/custom/nvm/versions/node' ? ['v24.9.0', 'v24.22.1'] : []));
		mocks.exists.mockImplementation((p) => String(p).startsWith('/custom/nvm/versions/node/'));
		mocks.spawn.mockImplementation((p) => (p === 'node' ? { error: new Error('missing') } : report(String(p))));
		expect(NodeResolver.resolve()).toBe('/custom/nvm/versions/node/v24.22.1/bin/node');
	});
	it('finds Homebrew Node on macOS', () => {
		Object.defineProperty(process, 'platform', { value: 'darwin' });
		mocks.exists.mockImplementation((p) => p === '/opt/homebrew/bin/node');
		mocks.spawn.mockImplementation((p) => (p === 'node' ? { error: new Error('missing') } : report('/opt/homebrew/bin/node')));
		expect(NodeResolver.resolve()).toBe('/opt/homebrew/bin/node');
	});
	it('uses the editor server only when it is a standalone Node binary', () => {
		Object.defineProperty(process, 'execPath', { value: '/server/bin/commit/node' });
		mocks.exists.mockImplementation((p) => p === '/server/bin/commit/node');
		mocks.spawn.mockImplementation((p) => (p === 'node' ? { error: new Error('missing') } : report('/server/bin/commit/node')));
		expect(NodeResolver.resolve()).toBe('/server/bin/commit/node');
	});
	it('never starts the desktop editor to probe for Node', () => {
		expect(() => NodeResolver.resolve()).toThrow('Node.js was not found');
		expect(mocks.spawn.mock.calls.map((c: unknown[]) => c[0])).not.toContain('/opt/cursor/cursor');
	});
	it('rejects .cmd launchers without running a shell', () => {
		windows();
		expect(() => NodeResolver.resolve('D:\\node.cmd')).toThrow('configured Node.js');
		expect(mocks.spawn).not.toHaveBeenCalled();
	});
	it('keeps permission errors in diagnostics without exposing a native-prefix error to users', () => {
		mocks.spawn.mockReturnValue({ error: Object.assign(new Error('denied'), { code: 'EACCES' }) });
		const log = vi.fn();
		expect(() => NodeResolver.resolve(undefined, log)).toThrow('Node.js was not found');
		expect(log.mock.calls.flat().join(' ')).toContain('EACCES');
	});
	it('does not crash discovery because a manager directory is unreadable', () => {
		mocks.read.mockImplementation(() => {
			throw new Error('EACCES');
		});
		mocks.spawn.mockReturnValue(report());
		expect(NodeResolver.resolve()).toBe('/usr/bin/node');
	});
	it.each(['not JSON', '{}', 'null'])('rejects invalid runtime reports: %s', (stdout) => {
		mocks.spawn.mockReturnValue({ status: 0, stdout });
		expect(() => NodeResolver.resolve('/custom/node')).toThrow('configured Node.js');
	});
	it('bounds probes and does not interpolate a path containing shell metacharacters', () => {
		const node = '/a path/$(do-not-run)/node';
		mocks.spawn.mockReturnValue(report(node));
		expect(NodeResolver.resolve(node)).toBe(node);
		expect(mocks.spawn).toHaveBeenCalledWith(
			node,
			expect.any(Array),
			expect.objectContaining({ timeout: 3000, shell: false, windowsHide: true })
		);
	});
});
