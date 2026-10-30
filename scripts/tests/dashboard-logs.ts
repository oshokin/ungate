import assert from 'node:assert/strict';

import { LOG_PANEL } from '../../apps/web/src/features/logs/log-tail';

import type { Locator, Page } from 'playwright';

async function panelHeight(handle: Locator): Promise<number> {
	const value = await handle.getAttribute('aria-valuenow');

	return Number(value);
}

export async function verifyLogPanels(page: Page, emit: (message: unknown) => Promise<unknown>): Promise<void> {
	for (const unrelated of [null, 'unrelated message', 42]) await emit(unrelated);
	const sources = ['api', 'tunnel'] as const;
	const snapshot = (source: string, generation: string, count = 80) => ({
		type: 'log-bulk',
		source,
		entries: Array.from({ length: count }, (_, i) => ({
			timestamp: Date.now() + i,
			level: 'info',
			message: `${source} ${generation} ${i}`
		})),
		entryIds: Array.from({ length: count }, (_, i) => `${source}-${generation}-${i}`)
	});
	const tail = async (panel: Locator, context: string) => {
		const id = await panel.getAttribute('id');
		await page
			.waitForFunction(
				({ id, threshold }) => {
					const element = document.getElementById(id);

					return !!element && element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
				},
				{ id: id ?? '', threshold: LOG_PANEL.tailThreshold },
				{ timeout: 3000 }
			)
			.catch(() => {
				throw new Error(`Log panel did not reach the latest entry: ${context}`);
			});
	};
	const savedHeights: number[] = [];
	for (const source of sources) {
		const label = source === 'api' ? 'API' : 'Tunnel';
		const section = page.getByRole('region', { name: `${label} log entries`, exact: true });
		const group = page.locator('section').filter({ has: section });
		const handle = page.getByRole('separator', { name: `Resize ${label} logs vertically`, exact: true });
		await emit(snapshot(source, 'resize'));
		await section.locator('.ug-log-message').getByText(`${source} resize 79`, { exact: true }).waitFor();
		await tail(section, `${label} initial snapshot`);
		await handle.evaluate((element) => element.scrollIntoView({ block: 'center' }));
		const bounds = await handle.boundingBox();
		assert.ok(bounds);
		await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
		await page.mouse.down();
		await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2 + 64, { steps: 4 });
		await page.mouse.up();
		const height = await panelHeight(handle);
		assert.equal(height, LOG_PANEL.defaultHeight + 64, `${label} pointer resize`);
		assert.equal(await section.evaluate((element) => element.getBoundingClientRect().height), height);
		await tail(section, `${label} resized while following`);
		await handle.focus();
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('Shift+ArrowDown');
		assert.equal(await panelHeight(handle), height + LOG_PANEL.resizeStep + LOG_PANEL.largeResizeStep);
		const savedHeight = await panelHeight(handle);
		savedHeights.push(savedHeight);
		// Clear while reading old messages must reset the paused state, even if scrollTop was already zero.
		await section.evaluate((element) => {
			element.scrollTop = 0;
			element.dispatchEvent(new Event('scroll'));
		});
		await group.getByRole('button', { name: 'Clear', exact: true }).click();
		await section.getByText('No log entries', { exact: true }).waitFor();
		await emit(snapshot(source, 'after-clear'));
		await section.locator('.ug-log-message').getByText(`${source} after-clear 79`, { exact: true }).waitFor();
		await tail(section, `${label} snapshot after Clear`);
	}
	// Leaving the page resets paused reading; re-entering always opens each panel at its tail.
	for (const source of sources) {
		await page.locator(`#${source}-log-panel`).evaluate((element) => {
			element.scrollTop = 0;
			element.dispatchEvent(new Event('scroll'));
		});
	}
	// A retained webview also opens at the tail when it becomes visible again.
	for (const visibility of ['hidden', 'visible']) {
		await page.evaluate((visibility) => {
			Object.defineProperty(document, 'visibilityState', { configurable: true, value: visibility });
			document.dispatchEvent(new Event('visibilitychange'));
		}, visibility);
	}
	for (const source of sources) {
		const panel = page.locator(`#${source}-log-panel`);
		await tail(panel, `${source} visible again`);
		await panel.evaluate((element) => {
			element.scrollTop = 0;
			element.dispatchEvent(new Event('scroll'));
		});
	}
	await page.evaluate(() => Reflect.deleteProperty(document, 'visibilityState'));
	await page.getByRole('button', { name: 'Connection', exact: true }).click();
	await page.getByRole('button', { name: 'Logs', exact: true }).click();
	for (const [index, source] of sources.entries()) {
		const label = source === 'api' ? 'API' : 'Tunnel';
		assert.equal(
			await panelHeight(page.getByRole('separator', { name: `Resize ${label} logs vertically`, exact: true })),
			savedHeights[index]
		);
		await tail(page.locator(`#${source}-log-panel`), `${label} re-entered page`);
	}
	// A real webview reload restores saved heights; a delayed initial history still opens at the latest entry.
	await page.reload();
	for (const [index, source] of sources.entries()) {
		const label = source === 'api' ? 'API' : 'Tunnel';
		const handle = page.getByRole('separator', { name: `Resize ${label} logs vertically`, exact: true });
		await handle.waitFor();
		assert.equal(await panelHeight(handle), savedHeights[index]);
		await emit(snapshot(source, 'reload'));
		const panel = page.locator(`#${source}-log-panel`);
		await panel.locator('.ug-log-message').getByText(`${source} reload 79`, { exact: true }).waitFor();
		await tail(panel, `${label} delayed history after reload`);
		await handle.focus();
		await page.keyboard.press('Home');
		assert.equal(await panelHeight(handle), LOG_PANEL.minHeight);
		await page.keyboard.press('ArrowUp');
		assert.equal(await panelHeight(handle), LOG_PANEL.minHeight);
		await page.keyboard.press('End');
		assert.equal(await panelHeight(handle), LOG_PANEL.maxHeight);
		await page.keyboard.press('ArrowDown');
		assert.equal(await panelHeight(handle), LOG_PANEL.maxHeight);
		await page.locator('section').filter({ has: panel }).getByRole('button', { name: 'Reset height', exact: true }).click();
		assert.equal(await panelHeight(handle), LOG_PANEL.defaultHeight);
		await tail(panel, `${label} reset height`);
		// Increasing the limit fetches older history, which must not inflate the unread count.
		for (const liveFirst of [false, true]) {
			const generation = `limit-${liveFirst}`;
			const history = snapshot(source, generation, 200);
			await emit({ ...history, maxEntries: 100 });
			await panel.locator('.ug-log-message').getByText(`${source} ${generation} 199`, { exact: true }).waitFor();
			await tail(panel, `${label} limited history`);
			await panel.evaluate((element) => {
				element.scrollTop = 0;
				element.dispatchEvent(new Event('scroll'));
			});
			const entry = { timestamp: Date.now(), level: 'info', message: `${source} ${generation} live` };
			const entryId = `${source}-${generation}-live`;
			if (liveFirst) await emit({ type: 'log', source, entry, entryId, maxEntries: 1000 });
			await emit({
				...history,
				maxEntries: 1000,
				entries: [...history.entries, ...(liveFirst ? [entry] : [])],
				entryIds: [...history.entryIds, ...(liveFirst ? [entryId] : [])]
			});
			await page.waitForFunction(
				({ source, count }) => document.querySelectorAll(`#${source}-log-panel .ug-log-message`).length === count,
				{ source, count: liveFirst ? 201 : 200 }
			);
			const badge = page.getByRole('button', { name: `1 new ${label} log entry. Jump to latest.`, exact: true });
			if (!liveFirst) {
				assert.equal(await page.locator('section').filter({ has: panel }).locator('.ug-new-logs').count(), 0);
				await emit({ type: 'log', source, entry, entryId, maxEntries: 1000 });
			}
			await badge.waitFor();
			await badge.click();
			await tail(panel, `${label} genuine new entry after expanding history`);
		}
	}
}
