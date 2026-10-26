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
			},
			readAll(source: 'api' | 'tunnel') {
				return [...sharedLogs[source]];
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
		window: {
			createWebviewPanel: createWebviewPanelMock
		},
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
	return {
		webview: {
			html: '',
			options: {} as Record<string, unknown>,
			postMessage: vi.fn(),
			asWebviewUri: vi.fn((value) => value),
			onDidReceiveMessage: vi.fn()
		},
		onDidChangeViewState: vi.fn(),
		onDidDispose: vi.fn(),
		reveal: vi.fn(),
		visible: true,
		iconPath: null
	};
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

		expect(panel.webview.postMessage).toHaveBeenCalledWith({
			type: 'log-bulk',
			source: 'api',
			entries: [{ timestamp: 1, level: 'info', message: 'started elsewhere' }]
		});
	});
});
