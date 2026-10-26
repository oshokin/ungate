import { beforeEach, describe, expect, it, vi } from 'vitest';

import { openCursorModels } from '../../src/cursor-settings';

const mocks = vi.hoisted(() => ({ commands: vi.fn(), execute: vi.fn(), information: vi.fn() }));
vi.mock('vscode', () => ({
	commands: { getCommands: mocks.commands, executeCommand: mocks.execute },
	window: { showInformationMessage: mocks.information }
}));
beforeEach(() => {
	vi.clearAllMocks();
	mocks.execute.mockResolvedValue(undefined);
});

describe('Cursor Models navigation', () => {
	it('requests Models directly when Cursor exposes the navigation command', async () => {
		mocks.commands.mockResolvedValue(['aiSettings.action.open', 'aiSettings.usingOpenAIKey.toggle']);
		await openCursorModels();
		expect(mocks.execute).toHaveBeenCalledExactlyOnceWith('aiSettings.action.open', 'models');
	});
	it('opens general Cursor settings when direct navigation is absent', async () => {
		mocks.commands.mockResolvedValue(['aiSettings.action.openhidden']);
		await openCursorModels();
		expect(mocks.execute).toHaveBeenCalledExactlyOnceWith('aiSettings.action.openhidden');
		expect(mocks.information).toHaveBeenCalledOnce();
	});
	it('falls back to a filtered palette instead of opening VS Code settings', async () => {
		mocks.commands.mockResolvedValue([]);
		await openCursorModels();
		expect(mocks.execute).toHaveBeenCalledExactlyOnceWith('workbench.action.quickOpen', '>Cursor Settings');
	});
	it('propagates a failed navigation command instead of claiming success', async () => {
		mocks.commands.mockResolvedValue(['aiSettings.action.open']);
		mocks.execute.mockRejectedValue(new Error('Command failed'));
		await expect(openCursorModels()).rejects.toThrow('Command failed');
	});
});
