import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ExtensionController } from '../../src/extension-controller';

const mocks = vi.hoisted(() => ({ select: vi.fn(), read: vi.fn(), alive: vi.fn(), run: vi.fn(), sync: vi.fn() }));
vi.mock('vscode', () => ({}));
vi.mock('../../src/node-runtime-settings', () => ({ chooseNodeRuntime: mocks.select, configuredNodePath: () => undefined }));
vi.mock('../../src/runtime-state', () => ({ RuntimeStateStore: { read: mocks.read } }));
vi.mock('../../src/utils/managed-process', () => ({
	ManagedProcess: { isAlive: mocks.alive },
	getCloudflaredBinPath: () => '/unused/cloudflared'
}));

beforeEach(() => {
	vi.resetAllMocks();
	mocks.select.mockResolvedValue(true);
	mocks.run.mockResolvedValue(undefined);
	mocks.sync.mockResolvedValue(undefined);
	mocks.read.mockReturnValue({ api: { status: 'error', pid: null, port: null } });
});
function controller() {
	const result = new ExtensionController({} as never);
	Object.assign(result, { services: { run: mocks.run }, syncFromRuntimeState: mocks.sync });

	return result as unknown as { runAction(action: 'choose-node-runtime'): Promise<void> };
}
describe('Node executable picker recovery', () => {
	it('starts an absent API after a successful selection', async () => {
		await controller().runAction('choose-node-runtime');
		expect(mocks.run).toHaveBeenCalledExactlyOnceWith('restart-services');
		expect(mocks.sync).toHaveBeenCalledOnce();
	});
	it('does not restart an API that is already running in another window', async () => {
		mocks.read.mockReturnValue({ api: { status: 'running', pid: 1234, port: 47821 } });
		await controller().runAction('choose-node-runtime');
		expect(mocks.run).not.toHaveBeenCalled();
	});
	it('does not stop a live process merely because its saved status is error', async () => {
		mocks.read.mockReturnValue({ api: { status: 'error', pid: 1234, port: 47821 } });
		mocks.alive.mockReturnValue(true);
		await controller().runAction('choose-node-runtime');
		expect(mocks.run).not.toHaveBeenCalled();
	});
	it('does not start anything when the picker is cancelled', async () => {
		mocks.select.mockResolvedValue(false);
		await expect(controller().runAction('choose-node-runtime')).rejects.toThrow('Action cancelled');
		expect(mocks.run).not.toHaveBeenCalled();
	});
});
