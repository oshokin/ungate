import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { chooseNodeRuntime, configuredNodePath } from '../../src/node-runtime-settings';

const mocks = vi.hoisted(() => ({ dialog: vi.fn(), inspect: vi.fn(), update: vi.fn(), resolve: vi.fn() }));
vi.mock('vscode', () => ({
	window: { showOpenDialog: mocks.dialog },
	Uri: { file: (fsPath: string) => ({ scheme: 'file', fsPath }) },
	workspace: { getConfiguration: () => ({ inspect: mocks.inspect, update: mocks.update }) },
	ConfigurationTarget: { Global: 1 }
}));
vi.mock('../../src/utils/node-resolver', () => ({ NodeResolver: { resolve: mocks.resolve } }));
beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv('UNGATE_NODE_BIN', '/env/node');
});
afterEach(() => vi.unstubAllEnvs());

describe('local Node runtime configuration', () => {
	it('uses the explicit machine setting before an inherited environment override', () => {
		mocks.inspect.mockReturnValue({ globalValue: '/selected/node', workspaceValue: '/untrusted/node' });
		expect(configuredNodePath()).toBe('/selected/node');
	});
	it('ignores a workspace-provided executable', () => {
		mocks.inspect.mockReturnValue({ workspaceValue: '/untrusted/node' });
		expect(configuredNodePath()).toBe('/env/node');
	});
	it('validates and canonicalizes the selected executable before saving it', async () => {
		mocks.dialog.mockResolvedValue([{ scheme: 'file', fsPath: '/selected/node' }]);
		mocks.resolve.mockReturnValue('/real/node');
		await expect(chooseNodeRuntime()).resolves.toBe(true);
		expect(mocks.dialog).toHaveBeenCalledWith(
			expect.objectContaining({ defaultUri: expect.objectContaining({ scheme: 'file' }) })
		);
		expect(mocks.update).toHaveBeenCalledExactlyOnceWith('nodePath', '/real/node', 1);
	});
	it('keeps the previous setting when validation fails', async () => {
		mocks.dialog.mockResolvedValue([{ scheme: 'file', fsPath: '/selected/node' }]);
		mocks.resolve.mockImplementation(() => {
			throw new Error('Node.js is incompatible');
		});
		await expect(chooseNodeRuntime()).rejects.toThrow('incompatible');
		expect(mocks.update).not.toHaveBeenCalled();
	});
	it('rejects an executable selected from a remote filesystem', async () => {
		mocks.dialog.mockResolvedValue([{ scheme: 'vscode-remote', fsPath: '/remote/node' }]);
		await expect(chooseNodeRuntime()).rejects.toThrow('not on the SSH host');
		expect(mocks.resolve).not.toHaveBeenCalled();
		expect(mocks.update).not.toHaveBeenCalled();
	});
	it('treats a cancelled dialog as cancellation and does not overwrite settings', async () => {
		mocks.dialog.mockResolvedValue(undefined);
		await expect(chooseNodeRuntime()).resolves.toBe(false);
		expect(mocks.resolve).not.toHaveBeenCalled();
		expect(mocks.update).not.toHaveBeenCalled();
	});
});
