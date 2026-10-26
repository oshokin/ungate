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
	console.error('Dashboard browser test exceeded its 60-second hard timeout.');
	try {
		child.kill('SIGKILL');
	} catch {}
	server.close();
	process.exit(1);
}, 60_000);
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
        let state = { currentPage: 'analytics' };
        window.acquireVsCodeApi = function () {
            return {
                postMessage: function (message) { void window.ungateBridge(message); },
                getState: function () { return state; },
                setState: function (value) { state = value; }
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
