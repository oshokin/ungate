import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { TestHelper } from './helpers/test-helper';

const createWebviewPanelMock = vi.fn();
const fileUriMock = vi.fn((value: string) => {
	return { fsPath: value, toString: () => value };
});
const sharedLogs = {
	api: [] as { timestamp: number; level: 'info' | 'warn' | 'error'; message: string }[],
	tunnel: [] as { timestamp: number; level: 'info' | 'warn' | 'error'; message: string }[]
};

vi.mock('@ungate/shared', async (original) => {
	const actual = await original<typeof import('@ungate/shared')>();

	return { ...actual, getAdminToken: () => 'test-admin' };
});

vi.mock('node:fs', () => {
	return {
		readFileSync: vi.fn(() => '<html><head></head><body></body></html>')
	};
});

vi.mock('../../src/runtime-state/shared-log-store', () => {
	return {
		SharedLogStore: {
			append(source: 'api' | 'tunnel', entry: { timestamp: number; level: 'info' | 'warn' | 'error'; message: string }) {
				sharedLogs[source].push(entry);

				return `${source}-${sharedLogs[source].length}`;
			},
			readAll(source: 'api' | 'tunnel') {
				return [...sharedLogs[source]];
			},
			readSnapshot(source: 'api' | 'tunnel') {
				return {
					entries: [...sharedLogs[source]],
					entryIds: sharedLogs[source].map((_, index) => `${source}-${index + 1}`)
				};
			},
			readSince(source: 'api' | 'tunnel', byteOffset: number) {
				const entries = sharedLogs[source].slice(byteOffset);

				return { entries, nextOffset: sharedLogs[source].length };
			},
			getFileSize() {
				return Math.max(sharedLogs.api.length, sharedLogs.tunnel.length);
			},
			clear(source: 'api' | 'tunnel') {
				sharedLogs[source] = [];
			}
		}
	};
});

vi.mock('vscode', () => {
	class Disposable {
		dispose(): void {}
	}

	return {
		workspace: {
			getConfiguration: () => ({ inspect: () => undefined }),
			onDidChangeConfiguration: vi.fn(() => new Disposable())
		},
		window: {
			registerWebviewViewProvider: vi.fn(() => new Disposable()),
			createWebviewPanel: createWebviewPanelMock
		},
		commands: { executeCommand: vi.fn(async () => {}) },
		ViewColumn: {
			One: 1,
			Active: -1
		},
		Uri: {
			file: fileUriMock
		},
		ExtensionMode: {
			Development: 1,
			Production: 2
		},
		MarkdownString: TestHelper.createMarkdownStringClass(),
		Disposable
	};
});

let Dashboard: typeof import('../../src/dashboard').Dashboard;

function createPanel() {
	const panel = {
		webview: {
			html: '',
			options: {} as Record<string, unknown>,
			postMessage: vi.fn(),
			asWebviewUri: vi.fn((value) => value),
			onDidReceiveMessage: vi.fn<(receive: (message: unknown) => void) => { dispose: () => void }>()
		},
		onDidChangeViewState: vi.fn(),
		onDidDispose: vi.fn<(dispose: () => void) => void>(),
		reveal: vi.fn(),
		dispose: vi.fn(),
		visible: true,
		iconPath: null
	};
	panel.webview.onDidReceiveMessage.mockImplementation((receive) => {
		receive({ type: 'webview-ready' });

		return { dispose: vi.fn() };
	});

	return panel;
}

describe('Dashboard.setPort', () => {
	beforeAll(async () => {
		const module = await import('../../src/dashboard');
		Dashboard = module.Dashboard;
	});

	beforeEach(() => {
		createWebviewPanelMock.mockReset();
		fileUriMock.mockClear();
		sharedLogs.api.length = 0;
		sharedLogs.tunnel.length = 0;
	});

	it('defaults to editor and restores only a valid persisted panel choice', async () => {
		const vscode = await import('vscode');
		const context = {
			extensionMode: 1,
			extensionPath: '/tmp/ungate-extension',
			globalState: { get: () => 'panel', update: vi.fn() }
		};
		const dashboard = new Dashboard(context as never, () => {});
		dashboard.show();
		expect(createWebviewPanelMock).not.toHaveBeenCalled();
		expect(vscode.commands.executeCommand).toHaveBeenCalledWith('ungate.dashboard.focus');
		dashboard.dispose();
	});

	it('waits for each host handshake and isolates disposed hosts', () => {
		const editor = createPanel();
		const view = createPanel();
		editor.webview.onDidReceiveMessage.mockImplementation(() => ({ dispose: vi.fn() }));
		view.webview.onDidReceiveMessage.mockImplementation(() => ({ dispose: vi.fn() }));
		createWebviewPanelMock.mockReturnValue(editor);
		const onMessage = vi.fn();
		const dashboard = new Dashboard({ extensionMode: 1, extensionPath: '/tmp/ungate-extension' } as never, onMessage);
		dashboard.show();
		dashboard.resolveWebviewView(view as never);
		dashboard.setPort(4321);
		expect(editor.webview.postMessage).not.toHaveBeenCalled();
		expect(view.webview.postMessage).not.toHaveBeenCalled();
		const editorReceive = editor.webview.onDidReceiveMessage.mock.calls[0][0];
		const viewReceive = view.webview.onDidReceiveMessage.mock.calls[0][0];
		editorReceive({ type: 'webview-ready' });
		dashboard.sendInitialState({ status: 'stopped', url: null, error: null });
		expect(editor.webview.postMessage).toHaveBeenCalledWith({ type: 'port', port: 4321 });
		expect(view.webview.postMessage).not.toHaveBeenCalled();
		viewReceive({ type: 'webview-ready' });
		expect(view.webview.html).toContain("connect-src 'none'");
		editor.webview.postMessage.mockClear();
		view.webview.postMessage.mockClear();
		view.onDidDispose.mock.calls[0][0]();
		dashboard.sendServiceState({ status: 'stopped' } as never);
		expect(editor.webview.postMessage).toHaveBeenCalled();
		expect(view.webview.postMessage).not.toHaveBeenCalled();
		dashboard.dispose();
	});

	it('persists switching without opening duplicate editor tabs', async () => {
		const editor = createPanel();
		const dispose = vi.fn();
		createWebviewPanelMock.mockReturnValue({ ...editor, dispose });
		const update = vi.fn(async () => {});
		const dashboard = new Dashboard(
			{ extensionMode: 1, extensionPath: '/tmp/ungate-extension', globalState: { get: () => undefined, update } } as never,
			() => {}
		);
		dashboard.show();
		dashboard.show();
		expect(createWebviewPanelMock).toHaveBeenCalledTimes(1);
		await dashboard.setPlacement('panel');
		expect(update).toHaveBeenCalledWith('dashboard.placement', 'panel');
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it('returns bridge responses only to their originating webview even with matching request ids', async () => {
		const editor = createPanel();
		const view = createPanel();
		createWebviewPanelMock.mockReturnValue(editor);
		const usage = { state: {}, load: vi.fn(() => Promise.resolve({ data: { providers: [] } })) };
		const dashboard = new Dashboard(
			{ extensionMode: 1, extensionPath: '/tmp/ungate-extension' } as never,
			() => {},
			undefined,
			usage as never
		);
		dashboard.show();
		dashboard.resolveWebviewView(view as never);
		editor.webview.postMessage.mockClear();
		view.webview.postMessage.mockClear();
		editor.webview.onDidReceiveMessage.mock.calls[0][0]({ type: 'api-request', id: 'same-id', method: 'GET', path: '/usage' });
		await vi.waitFor(() =>
			expect(editor.webview.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: 'api-response', id: 'same-id', status: 200 })
			)
		);
		expect(view.webview.postMessage).not.toHaveBeenCalled();
		editor.webview.postMessage.mockClear();
		view.webview.onDidReceiveMessage.mock.calls[0][0]({ type: 'api-request', id: 'same-id', method: 'GET', path: '/usage' });
		await vi.waitFor(() =>
			expect(view.webview.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: 'api-response', id: 'same-id', status: 200 })
			)
		);
		expect(editor.webview.postMessage).not.toHaveBeenCalled();
		dashboard.dispose();
	});

	it('journals and displays received entries unchanged for both sources', () => {
		const panel = createPanel();
		createWebviewPanelMock.mockReturnValue(panel);
		const dashboard = new Dashboard({ extensionMode: 1, extensionPath: '/tmp/ungate-extension' } as never, () => {});
		dashboard.show();
		panel.webview.postMessage.mockClear();
		const routine = { timestamp: 1, level: 'info' as const, message: 'join connections' };
		dashboard.pushLog('tunnel', routine);
		expect(sharedLogs.tunnel).toEqual([routine]);
		expect(panel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'log', entry: routine }));
		for (const entry of [
			{ ...routine, level: 'warn' as const },
			{ ...routine, level: 'error' as const },
			{ ...routine, message: 'join connections · error: refused' },
			{ ...routine, message: 'session reconnecting' },
			{ ...routine, message: 'received stop request' }
		])
			dashboard.pushLog('tunnel', entry);
		expect(sharedLogs.tunnel).toHaveLength(6);
		expect(panel.webview.postMessage).toHaveBeenCalledTimes(6);
		dashboard.pushLog('api', routine);
		expect(sharedLogs.api).toEqual([routine]);
	});

	it('does not rebuild the webview when the port did not change', () => {
		const panel = createPanel();
		createWebviewPanelMock.mockReturnValue(panel);
		const dashboard = new Dashboard(
			{
				extensionMode: 1,
				extensionPath: '/tmp/ungate-extension'
			} as never,
			() => {}
		);
		dashboard.show();

		const originalHtml = panel.webview.html;

		dashboard.setPort(4783);

		panel.webview.postMessage.mockClear();

		dashboard.setPort(4783);

		expect(panel.webview.html).toBe(originalHtml);
		expect(panel.webview.postMessage).not.toHaveBeenCalled();
	});

	it('sends the current port to the webview during initial state sync', () => {
		const panel = createPanel();
		createWebviewPanelMock.mockReturnValue(panel);
		const dashboard = new Dashboard(
			{
				extensionMode: 1,
				extensionPath: '/tmp/ungate-extension'
			} as never,
			() => {}
		);
		dashboard.show();
		dashboard.setPort(4783);
		panel.webview.postMessage.mockClear();

		dashboard.sendInitialState({ status: 'stopped', url: null, error: null });

		expect(panel.webview.postMessage).toHaveBeenCalledWith({ type: 'port', port: 4783 });
	});

	it('keeps HTTP and administrative capability outside the webview', () => {
		const panel = createPanel();
		createWebviewPanelMock.mockReturnValue(panel);
		const dashboard = new Dashboard({ extensionMode: 1, extensionPath: '/tmp/ungate-extension' } as never, () => {});
		dashboard.show();
		const html = panel.webview.html;
		dashboard.setPort(47821);
		expect(panel.webview.options.portMapping).toBeUndefined();
		expect(panel.webview.html).toBe(html);
		expect(html).toContain("connect-src 'none'");
		expect(html).not.toContain('__ADMIN_TOKEN__');
		expect(html).not.toContain('test-admin');
	});

	it('opens the panel without a port mapping while the api port is unknown', () => {
		const panel = createPanel();
		createWebviewPanelMock.mockReturnValue(panel);
		const dashboard = new Dashboard(
			{
				extensionMode: 1,
				extensionPath: '/tmp/ungate-extension'
			} as never,
			() => {}
		);

		dashboard.show();

		expect(createWebviewPanelMock).toHaveBeenCalledWith(
			'ungate',
			'Ungate',
			-1,
			expect.objectContaining({ enableScripts: true, retainContextWhenHidden: true })
		);
	});

	it('updates the current port without reloading an open panel', () => {
		const panel = createPanel();
		createWebviewPanelMock.mockReturnValue(panel);
		const dashboard = new Dashboard(
			{
				extensionMode: 1,
				extensionPath: '/tmp/ungate-extension'
			} as never,
			() => {}
		);
		dashboard.setPort(4783);
		dashboard.show();

		dashboard.setPort(4790);

		expect(panel.webview.options).toEqual({});
		expect(panel.webview.postMessage).toHaveBeenCalledWith({ type: 'port', port: 4790 });
	});

	it('reads shared api logs during initial state sync', () => {
		const panel = createPanel();
		createWebviewPanelMock.mockReturnValue(panel);
		const dashboardA = new Dashboard(
			{
				extensionMode: 1,
				extensionPath: '/tmp/ungate-extension'
			} as never,
			() => {}
		);
		const dashboardB = new Dashboard(
			{
				extensionMode: 1,
				extensionPath: '/tmp/ungate-extension'
			} as never,
			() => {}
		);
		dashboardA.pushLog('api', { timestamp: 1, level: 'info', message: 'started elsewhere' });
		dashboardB.show();
		panel.webview.postMessage.mockClear();

		dashboardB.sendInitialState({ status: 'stopped', url: null, error: null });

		expect(panel.webview.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'log-bulk',
				source: 'api',
				entries: [{ timestamp: 1, level: 'info', message: 'started elsewhere' }],
				entryIds: [expect.any(String)]
			})
		);
	});
});
