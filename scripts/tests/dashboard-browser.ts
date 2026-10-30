import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';

import { chromium } from 'playwright';

import { describeService, UNGATE_VERSION, API_PROTOCOL_VERSION } from '../../packages/shared/src/service';
import { repoDir } from '../build-package/process';

import { verifyLogPanels } from './dashboard-logs';
import { verifyDashboardThemes } from './dashboard-theme';

import type { DashboardApiBridge as ApiBridge } from '../../apps/extension/src/dashboard-api-bridge';

// The extension is CJS, the build tools are ESM. Use the CJS boundary explicitly.
const { DashboardApiBridge } = createRequire(import.meta.url)(
	'../../apps/extension/src/dashboard-api-bridge.ts'
) as typeof import('../../apps/extension/src/dashboard-api-bridge');

const directory = mkdtempSync(join(tmpdir(), 'ungate-dashboard-test-'));
const admin = randomBytes(32).toString('hex');
const previousAdmin = process.env.UNGATE_ADMIN_TOKEN;
process.env.UNGATE_ADMIN_TOKEN = admin;
const child = spawn(process.execPath, [join(repoDir, 'apps/api/dist/main.js')], {
	cwd: join(repoDir, 'apps/api'),
	env: { ...process.env, PORT: '0', DB_PATH: join(directory, 'data.db'), UNGATE_ADMIN_TOKEN: admin },
	stdio: ['ignore', 'pipe', 'pipe']
});
let startup = '';
child.stdout.on('data', (value: Buffer) => {
	startup += value.toString();
});
child.stderr.on('data', (value: Buffer) => {
	startup += value.toString();
});
const dist = join(repoDir, 'apps/web/dist');
const server = createServer((request, response) => {
	const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
	const file = pathname === '/' ? join(dist, 'index.html') : resolve(dist, `.${pathname}`);
	if ((!file.startsWith(dist + sep) && file !== join(dist, 'index.html')) || !existsSync(file)) {
		response.writeHead(404).end();

		return;
	}
	const mime: Record<string, string> = {
		'.html': 'text/html',
		'.js': 'text/javascript',
		'.css': 'text/css',
		'.png': 'image/png'
	};
	response.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream');
	const content = readFileSync(file);
	response.end(
		extname(file) === '.html'
			? content
					.toString()
					.replace(
						'<head>',
						`<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'">`
					)
			: content
	);
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let bridge: ApiBridge | undefined;
const hardTimeout = setTimeout(() => {
	console.error('Dashboard browser test exceeded its 120-second hard timeout.');
	try {
		child.kill('SIGKILL');
	} catch {}
	server.close();
	process.exit(1);
}, 120_000);
try {
	const port = await new Promise<number>((resolvePort, reject) => {
		const timer = setTimeout(() => reject(new Error(`API did not start: ${startup}`)), 10000);
		child.once('error', reject);
		child.once('exit', (code) => {
			clearTimeout(timer);
			reject(new Error(`API exited ${code}: ${startup}`));
		});
		child.stdout.on('data', () => {
			const match = /listening on localhost:(\d+)/.exec(startup);
			if (match) {
				clearTimeout(timer);
				resolvePort(Number(match[1]));
			}
		});
	});
	await new Promise<void>((resolveServer) => {
		server.listen(0, '127.0.0.1', resolveServer);
	});
	const address = server.address();
	assert.ok(address && typeof address === 'object');
	const executablePath = process.env.UNGATE_CHROMIUM_EXECUTABLE_PATH;
	const customArgs: unknown = JSON.parse(process.env.UNGATE_CHROMIUM_ARGS ?? '[]');
	assert.ok(Array.isArray(customArgs) && customArgs.every((value) => typeof value === 'string'));
	browser = await chromium.launch({
		headless: true,
		...(executablePath ? { executablePath, args: customArgs } : { channel: 'chromium' })
	});
	const page = await browser.newPage({ colorScheme: 'dark', viewport: { width: 960, height: 820 } });
	const actionRequests: string[] = [];
	page.setDefaultTimeout(10000);
	const screenshotDirectory = process.env.UNGATE_DASHBOARD_SCREENSHOTS_DIR;
	if (screenshotDirectory) mkdirSync(screenshotDirectory, { recursive: true });
	const errors: string[] = [];
	const browserFetches: string[] = [];
	page.on('pageerror', (error) => {
		errors.push(error.message);
		console.error(`Dashboard script error: ${error.message}`);
	});
	page.on('console', (message) => {
		if (message.type() === 'error') console.error(`Dashboard console: ${message.text()}`);
	});
	page.on('request', (request) => {
		if (['fetch', 'xhr'].includes(request.resourceType())) browserFetches.push(request.url());
	});
	bridge = new DashboardApiBridge(
		() => port,
		(message) => {
			void page.evaluate((value) => {
				window.postMessage(value, '*');
			}, message);
		}
	);
	const readyState = describeService({
		service: 'ungate',
		pid: child.pid!,
		version: UNGATE_VERSION,
		protocolVersion: API_PROTOCOL_VERSION
	});
	const emit = (message: unknown) => page.evaluate((value) => window.postMessage(value, '*'), message);
	await page.exposeBinding('ungateBridge', async (_source, raw: unknown) => {
		const message = raw as { type: string; id?: string; action?: string };
		if (message.type === 'webview-ready') {
			await emit({ type: 'service-state', state: readyState });
			await emit({ type: 'tunnel-status', state: { status: 'running', url: 'https://example.trycloudflare.com', error: null } });
		} else if (message.type === 'dashboard-action') {
			actionRequests.push(message.action!);
			// Native editor actions are emulated; provider HTTP and the API bridge are real.
			await emit({
				type: 'action-result',
				id: message.id,
				...(message.action === 'reload-window' ? { error: 'Reload is emulated in this browser test.' } : {})
			});
		} else await bridge?.handle(raw);
	});
	await page.addInitScript(`(() => {
        let state = JSON.parse(sessionStorage.getItem('ungate-test-state') || '{"currentPage":"analytics"}');
        window.acquireVsCodeApi = function () {
            return {
                postMessage: function (message) { void window.ungateBridge(message); },
                getState: function () { return state; },
                setState: function (value) { state = value; sessionStorage.setItem('ungate-test-state', JSON.stringify(value)); }
            };
        };
    })();`);

	await page.goto(`http://127.0.0.1:${address.port}/`);
	await page.getByRole('heading', { name: 'Providers & models', exact: true }).waitFor();
	assert.equal(await page.getByRole('button', { name: 'Use a Cursor model once', exact: true }).count(), 0);
	assert.equal(await page.getByRole('button', { name: 'Analytics', exact: true }).count(), 0);
	assert.equal(await page.getByText('Failed to fetch', { exact: true }).count(), 0);
	assert.equal(await page.getByRole('checkbox', { name: /Use Ungate/ }).count(), 0);
	assert.equal(await page.getByRole('button', { name: 'Open Cursor Models', exact: true }).count(), 1);
	await page.getByRole('button', { name: 'Copy tunnel URL', exact: true }).click();
	assert.equal(
		await page.getByRole('button', { name: 'Copy API key', exact: true }).isEnabled(),
		true,
		'copy does not dim the panel'
	);
	await page.getByText('Tunnel URL copied', { exact: true }).waitFor();
	await page.waitForTimeout(1600);
	assert.equal(
		await page.getByRole('button', { name: 'Tunnel URL copied', exact: true }).count(),
		1,
		'inline copy confirmation remains visible long enough to notice'
	);
	await page.locator('.ug-toast[role="status"]').getByRole('button', { name: 'Dismiss notification' }).click();
	await page.getByRole('button', { name: 'Copy API key', exact: true }).click();
	const copied = page.getByText('API key copied', { exact: true });
	await copied.waitFor();
	assert.equal(await page.getByRole('button', { name: 'API key copied', exact: true }).count(), 1);
	assert.equal(await copied.evaluate((element) => getComputedStyle(element.closest('.ug-toast')!).position), 'fixed');
	const statusToast = page.locator('.ug-toast[role="status"]');
	await statusToast.hover();
	await page.waitForTimeout(4200);
	assert.equal(await copied.count(), 1, 'hover pauses status auto-dismiss');
	await page.mouse.move(0, 0);
	await copied.waitFor({ state: 'hidden', timeout: 4500 });
	await page.getByRole('button', { name: 'Copy API key', exact: true }).click();
	const dismissStatus = statusToast.getByRole('button', { name: 'Dismiss notification' });
	await dismissStatus.focus();
	await page.waitForTimeout(4200);
	assert.equal(await copied.count(), 1, 'keyboard focus pauses status auto-dismiss');
	await dismissStatus.evaluate((element) => element.blur());
	await copied.waitFor({ state: 'hidden', timeout: 4500 });
	await page.getByRole('button', { name: 'Reload window', exact: true }).click();
	const errorToast = page.getByRole('alert');
	await errorToast.getByText('Reload is emulated in this browser test.', { exact: true }).waitFor();
	await page.getByRole('button', { name: 'Copy API key', exact: true }).click();
	assert.equal(await errorToast.count(), 1, 'status cannot displace an active error');
	await page.waitForTimeout(4200);
	assert.equal(await errorToast.count(), 1, 'errors never auto-dismiss');
	await errorToast.getByRole('button', { name: 'Dismiss notification' }).click();
	await copied.waitFor();
	await page.getByRole('button', { name: 'Models', exact: true }).click();
	await page.getByLabel('More actions', { exact: true }).click();
	await page.getByRole('button', { name: 'Stop API and tunnel · all windows', exact: true }).waitFor();
	await page.keyboard.press('Escape');
	assert.equal(await page.locator('details.ug-overflow').getAttribute('open'), null);
	await page.getByLabel('More actions', { exact: true }).click();
	await page.getByRole('button', { name: 'Stop API and tunnel · all windows', exact: true }).click();
	await page.getByText('Stop Shared API and Tunnel: done', { exact: true }).waitFor();
	assert.equal(await page.locator('details.ug-overflow').getAttribute('open'), null);
	if (screenshotDirectory) await page.screenshot({ path: join(screenshotDirectory, 'connection.png'), fullPage: true });
	// A repeated health message must not reset an in-progress settings edit.
	await page.getByText('Advanced settings', { exact: true }).click();
	assert.equal(await page.getByLabel('Tunnel protocol', { exact: true }).inputValue(), 'http2');
	await page.getByLabel('Tunnel protocol', { exact: true }).selectOption('quic');
	await page.getByLabel('Port', { exact: true }).fill('47999');
	await emit({ type: 'service-state', state: readyState });
	await page.getByRole('button', { name: 'Copy API key', exact: true }).click();
	await page.getByText('API key copied', { exact: true }).waitFor();
	assert.equal(await page.getByLabel('Port', { exact: true }).inputValue(), '47999');
	assert.equal(await page.getByLabel('Tunnel protocol', { exact: true }).inputValue(), 'quic');
	await page.getByRole('button', { name: 'Usage', exact: true }).click();
	await page.getByRole('heading', { name: 'Subscription usage', exact: true }).waitFor();
	await page.getByRole('heading', { name: 'ChatGPT / Codex', exact: true }).waitFor();
	await page.getByText('Connect this provider in Settings.', { exact: true }).first().waitFor();
	assert.equal(await page.getByText('Connect this provider in Settings.', { exact: true }).count(), 3);
	assert.equal(await page.locator('progress').count(), 0);
	if (screenshotDirectory) await page.screenshot({ path: join(screenshotDirectory, 'usage.png'), fullPage: true });
	await page.getByRole('button', { name: 'Refresh', exact: true }).click();
	await page.getByRole('button', { name: 'Refresh', exact: true }).waitFor();
	await page.getByRole('button', { name: 'Connection', exact: true }).click();
	await page.getByRole('button', { name: 'Usage', exact: true }).click();
	assert.equal(await page.getByText('Connect this provider in Settings.', { exact: true }).count(), 3);
	assert.equal(await page.getByText('Reading subscription limits…', { exact: true }).count(), 0);
	// An older API gets a recovery action, never a dead-end 404 Usage screen.
	await emit({
		type: 'service-state',
		state: describeService({ service: 'ungate', pid: 123, version: null, protocolVersion: null })
	});
	await page.getByText('Shared API update required', { exact: true }).waitFor();
	await page.getByRole('button', { name: 'Update shared API', exact: true }).click();
	await page.getByText('Restart Shared API: done', { exact: true }).waitFor();
	await page.getByRole('button', { name: 'Connection', exact: true }).click();
	await page.getByRole('heading', { name: 'Connection', exact: true }).waitFor();
	if (screenshotDirectory) await page.screenshot({ path: join(screenshotDirectory, 'api-update.png'), fullPage: true });
	await emit({ type: 'service-state', state: readyState });
	await page.getByRole('heading', { name: 'Providers & models', exact: true }).waitFor();
	await page.getByRole('button', { name: 'Manage Claude', exact: true }).click();
	await page.getByRole('button', { name: 'Close Claude', exact: true }).waitFor();
	const familyButton = page.locator('button[aria-controls^="model-family-"]').first();
	await familyButton.waitFor();
	assert.equal(await familyButton.getAttribute('aria-expanded'), 'true');
	await page.getByRole('columnheader', { name: 'Reasoning', exact: true }).waitFor();
	await page.getByRole('columnheader', { name: 'Standard', exact: true }).waitFor();
	assert.equal(await page.getByText('Advanced details', { exact: true }).count(), 0);
	await page.getByLabel('Model ID', { exact: true }).waitFor();
	const advancedOptions = page.locator('details').filter({ hasText: 'Advanced options' });
	await advancedOptions.locator('summary').click();
	assert.equal(await advancedOptions.getAttribute('open'), '');
	await advancedOptions.locator('select').first().waitFor();
	await familyButton.click();
	assert.equal(await familyButton.getAttribute('aria-expanded'), 'false');
	assert.equal(await page.getByRole('columnheader', { name: 'Reasoning', exact: true }).count(), 0);
	await familyButton.click();
	await page.getByRole('columnheader', { name: 'Reasoning', exact: true }).waitFor();
	await page.getByRole('button', { name: 'Sync Models', exact: true }).click();
	await page
		.getByText('Connect this provider before syncing models. Configured models were kept as fallback.', { exact: true })
		.waitFor();
	assert.deepEqual(browserFetches, []);
	await page.getByRole('button', { name: 'Close Claude', exact: true }).click();
	await page.getByRole('button', { name: 'Reload window', exact: true }).click();
	await page.getByText('Reload is emulated in this browser test.', { exact: true }).waitFor();
	await page.locator('.ug-toast[role="alert"]').getByRole('button', { name: 'Dismiss notification' }).click();
	// Check native light-theme tokens and the compact layout.
	await page.evaluate(() => {
		const style = document.documentElement.style;
		style.setProperty('--vscode-editor-background', '#ffffff');
		style.setProperty('--vscode-editor-foreground', '#202020');
		style.setProperty('--vscode-descriptionForeground', '#555555');
	});
	assert.equal(await page.locator('body').evaluate((element) => getComputedStyle(element).color), 'rgb(32, 32, 32)');
	await page.setViewportSize({ width: 420, height: 820 });
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
	if (screenshotDirectory) await page.screenshot({ path: join(screenshotDirectory, 'light-narrow.png'), fullPage: true });

	// Reproduce startup failure before any API request and check recovery controls.
	await emit({
		type: 'service-state',
		state: {
			status: 'error',
			version: null,
			expectedVersion: UNGATE_VERSION,
			canUpdate: false,
			message: 'Node.js was not found or is incompatible.'
		}
	});
	await page.getByRole('button', { name: 'Choose Node.js', exact: true }).click();
	await page.getByText('Choose Node.js Executable: done', { exact: true }).waitFor();
	assert.ok(actionRequests.includes('choose-node-runtime'));
	await emit({ type: 'service-state', state: readyState });
	await emit({
		type: 'log-bulk',
		source: 'api',
		entries: [{ timestamp: Date.now(), level: 'error', message: 'Node.js was not found or is incompatible.' }],
		entryIds: ['api-initial']
	});
	await page.getByRole('button', { name: 'Logs', exact: true }).click();
	const logPanel = page.getByRole('region', { name: 'API log entries', exact: true });
	const logText = logPanel.locator('.ug-log-message');
	await logText.getByText('Node.js was not found or is incompatible.', { exact: true }).waitFor();
	await emit({
		type: 'log-bulk',
		source: 'api',
		entries: Array.from({ length: 40 }, (_, index) => ({
			timestamp: Date.now() + index,
			level: 'info',
			message: `Live tail entry ${index + 1}`
		})),
		entryIds: Array.from({ length: 40 }, (_, index) => `api-${index + 1}`)
	});
	await emit({
		type: 'log-bulk',
		source: 'tunnel',
		entries: Array.from({ length: 40 }, (_, index) => ({
			timestamp: Date.now() + index,
			level: 'info',
			message: `Tunnel tail entry ${index + 1}`
		})),
		entryIds: Array.from({ length: 40 }, (_, index) => `tunnel-${index + 1}`)
	});
	await logText.getByText('Live tail entry 40', { exact: true }).waitFor();
	const tunnelPanel = page.getByRole('region', { name: 'Tunnel log entries', exact: true });
	await tunnelPanel.locator('.ug-log-message').getByText('Tunnel tail entry 40', { exact: true }).waitFor();
	await page.waitForFunction(
		() => {
			const panel = document.querySelector<HTMLElement>('[aria-label="API log entries"]');

			return !!panel && panel.scrollHeight - panel.scrollTop - panel.clientHeight <= 24;
		},
		undefined,
		{ timeout: 5000 }
	);
	await logPanel.evaluate((panel) => {
		panel.scrollTop = 0;
		panel.dispatchEvent(new Event('scroll'));
	});
	await tunnelPanel.evaluate((panel) => {
		panel.scrollTop = 0;
		panel.dispatchEvent(new Event('scroll'));
	});
	for (const source of ['api', 'tunnel'] as const) {
		for (let index = 1; index <= 3; index += 1) {
			await emit({
				type: 'log',
				source,
				entry: { timestamp: Date.now() + 100 + index, level: 'info', message: `${source} paused entry ${index}` },
				entryId: `${source}-new-${index}`
			});
		}
	}
	const apiNewLogs = page.getByRole('button', { name: '3 new API log entries. Jump to latest.', exact: true });
	const tunnelNewLogs = page.getByRole('button', { name: '3 new Tunnel log entries. Jump to latest.', exact: true });
	await apiNewLogs.waitFor();
	await tunnelNewLogs.waitFor();
	assert.equal(await logPanel.evaluate((panel) => panel.scrollTop), 0);
	assert.equal(await tunnelPanel.evaluate((panel) => panel.scrollTop), 0);
	await apiNewLogs.click();
	await tunnelNewLogs.click();
	await page.waitForFunction(
		() => {
			const panels = [...document.querySelectorAll<HTMLElement>('[aria-label$="log entries"]')];

			return panels.length === 2 && panels.every((panel) => panel.scrollHeight - panel.scrollTop - panel.clientHeight <= 24);
		},
		undefined,
		{ timeout: 5000 }
	);
	// Text remains readable even if a third-party surface palette uses white.
	// The extension owns the preference; bulk updates must apply it to entries and identities together.
	for (const maxEntries of [100, 1000]) {
		await emit({
			type: 'log-bulk',
			source: 'api',
			maxEntries,
			entries: Array.from({ length: 200 }, (_, index) => ({
				timestamp: Date.now() + index,
				level: 'info',
				message: `Capacity entry ${index}`
			})),
			entryIds: Array.from({ length: 200 }, (_, index) => `capacity-${index}`)
		});
		await page.waitForFunction(
			(expected) => document.querySelectorAll('[aria-label="API log entries"] .ug-log-message').length === expected,
			Math.min(200, maxEntries)
		);
	}
	await verifyLogPanels(page, emit);
	for (const [name, background, foreground] of [
		['dark', '#1e1e1e', '#dddddd'],
		['light', '#ffffff', '#202020'],
		['high-contrast', '#000000', '#ffffff']
	]) {
		await page.evaluate(
			({ background, foreground }) => {
				const style = document.documentElement.style;
				style.setProperty('--vscode-editor-background', background);
				style.setProperty('--vscode-editor-foreground', foreground);
				style.setProperty('--vscode-descriptionForeground', foreground);
				style.setProperty('--vscode-errorForeground', background === '#ffffff' ? '#c00000' : '#ff8080');
				style.setProperty('--vscode-textCodeBlock-background', '#ffffff');
			},
			{ background, foreground }
		);
		const colors = await logPanel.evaluate((panel) => {
			const text = panel.querySelector('.ug-log-message')!;

			return { background: getComputedStyle(panel).backgroundColor, foreground: getComputedStyle(text).color };
		});
		const rgb = (value: string) => value.match(/\d+/g)!.slice(0, 3).map(Number);
		const luminance = (values: number[]) =>
			values
				.map((number) => number / 255)
				.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
				.reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
		const a = luminance(rgb(colors.background)),
			b = luminance(rgb(colors.foreground));
		assert.ok((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5, `Logs contrast in ${name}`);
		await page.getByRole('button', { name: 'Reload window', exact: true }).click();
		const themeToast = page.locator('.ug-toast');
		await themeToast.waitFor();
		const toastColors = await themeToast.evaluate((element) => ({
			background: getComputedStyle(element).backgroundColor,
			foreground: getComputedStyle(element.querySelector('p')!).color
		}));
		const ta = luminance(rgb(toastColors.background)),
			tb = luminance(rgb(toastColors.foreground));
		assert.ok((Math.max(ta, tb) + 0.05) / (Math.min(ta, tb) + 0.05) >= 4.5, `Toast fallback contrast in ${name}`);
		if (screenshotDirectory) await page.screenshot({ path: join(screenshotDirectory, `logs-${name}.png`), fullPage: true });
	}
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
	const themeAudit = await verifyDashboardThemes(page, screenshotDirectory);
	await page.emulateMedia({ forcedColors: 'active', colorScheme: 'light' });
	await page.getByLabel('More actions', { exact: true }).click();
	const forcedBorder = await page.getByRole('button', { name: 'Models', exact: true }).evaluate((element) => {
		const style = getComputedStyle(element);

		return { border: style.borderTopColor, background: getComputedStyle(document.body).backgroundColor };
	});
	assert.notEqual(forcedBorder.border, forcedBorder.background, 'Controls need a boundary in Windows forced-colors');
	await page.keyboard.press('Escape');
	await page.emulateMedia({ forcedColors: 'none' });
	assert.ok(
		actionRequests.includes('open-cursor-models') &&
			actionRequests.includes('copy-api-key') &&
			actionRequests.includes('stop-services') &&
			actionRequests.includes('restart-services') &&
			actionRequests.includes('reload-window')
	);
	assert.deepEqual(errors, []);
	assert.deepEqual(browserFetches, []);
	assert.equal(await page.evaluate(() => '__ADMIN_TOKEN__' in window), false);
	const browserVersion = browser.version();
	console.log(
		JSON.stringify({
			check: 'dashboard-browser',
			status: 'PASS',
			browser: 'Chromium',
			browserVersion,
			realApi: true,
			realBridge: true,
			nativeActionsEmulated: true,
			actionRequests,
			versionRecovery: true,
			draftSurvivesHealthSync: true,
			narrowAndLightTheme: true,
			logsContrastAcrossThemes: true,
			nodeRecoveryAction: true,
			logPanelBehavior: true,
			themeAudit,
			cspConnectNone: true,
			browserHttpFetches: 0,
			analyticsRemoved: true,
			missingUsageIsNotZero: true,
			pageErrors: 0,
			providerTraffic: false
		})
	);
} finally {
	bridge?.dispose();
	await browser?.close();
	server.close();
	child.kill();
	if (child.exitCode === null && child.signalCode === null)
		await new Promise<void>((resolveExit) => {
			const shutdownTimeout = setTimeout(() => {
				try {
					child.kill('SIGKILL');
				} catch {}
				resolveExit();
			}, 2000);
			child.once('exit', () => {
				clearTimeout(shutdownTimeout);
				resolveExit();
			});
		});
	if (previousAdmin === undefined) delete process.env.UNGATE_ADMIN_TOKEN;
	else process.env.UNGATE_ADMIN_TOKEN = previousAdmin;
	rmSync(directory, { recursive: true, force: true });
	clearTimeout(hardTimeout);
}
