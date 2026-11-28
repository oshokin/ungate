import assert from 'node:assert/strict';

import type { Locator, Page } from 'playwright';

/** Read both viewport-relative rectangles in one browser task, before scrolling/layout can intervene. */
async function measureGap(before: Locator, after: Locator, horizontal = false): Promise<number> {
	const target = await after.elementHandle();
	assert.ok(target, 'Spacing targets must be rendered');
	try {
		return await before.evaluate(
			(element, { target, horizontal }) => {
				if (!element.getClientRects().length || !target.getClientRects().length)
					throw new Error('Spacing targets must be rendered');
				const a = element.getBoundingClientRect();
				const b = target.getBoundingClientRect();

				return horizontal ? b.left - a.right : b.top - a.bottom;
			},
			{ target, horizontal }
		);
	} finally {
		await target.dispose();
	}
}

/** A 43px scroll between independent snapshots turns a real 4px gap into the reported 47px. */
export async function verifySpacingSnapshotRegression(page: Page): Promise<void> {
	const browser = page.context().browser();
	assert.ok(browser);
	const fixture = await browser.newPage();
	try {
		await fixture.setContent(
			'<div style="height:200px"></div><div id="before" style="height:20px"></div><div id="after" style="margin-top:4px;height:20px"></div><div style="height:2000px"></div>'
		);
		const before = fixture.locator('#before');
		const after = fixture.locator('#after');
		await fixture.evaluate(() => window.scrollTo(0, 43));
		const a = await before.boundingBox();
		await fixture.evaluate(() => window.scrollTo(0, 0));
		const b = await after.boundingBox();
		assert.ok(a && b);
		assert.equal(b.y - a.y - a.height, 47);
		assert.equal(await measureGap(before, after), 4);
		await fixture.evaluate(() => window.scrollTo(0, 43));
		assert.equal(await measureGap(before, after), 4);
	} finally {
		await fixture.close();
	}
}

/** Border-box measurements catch collapsed margins and wrapping, not just CSS declarations. */
export async function verifyDashboardSpacing(page: Page): Promise<void> {
	const gap = async (before: Locator, after: Locator, expected: number, horizontal = false) => {
		const actual = await measureGap(before, after, horizontal);
		assert.ok(
			Math.abs(actual - expected) < 0.6,
			`Expected ${expected}px gap, got ${actual}px (${String(before)} -> ${String(after)}, ${JSON.stringify(page.viewportSize())})`
		);
	};
	const bounded = async (scope: Locator) => {
		for (const button of await scope.getByRole('button').all()) {
			const visible = await button.isVisible();
			if (!visible) continue;
			const box = await button.boundingBox();
			assert.ok(box && box.width > 0 && box.x >= 0 && box.x + box.width <= page.viewportSize()!.width + 1);
		}
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
	};
	await page.getByRole('button', { name: 'Connection', exact: true }).click();
	const connection = page.getByRole('region', { name: 'Connection', exact: true });
	for (const title of ['Tunnel options', 'API configuration']) {
		const summary = connection.getByText(title, { exact: true });
		const open = await summary.locator('..').getAttribute('open');
		if (open === null) await summary.click();
	}
	const options = connection.locator('.ug-tunnel-options');
	for (const width of [320, 420, 580]) {
		await page.setViewportSize({ width, height: 900 });
		for (const preference of await connection.locator('.ug-preference').all())
			await gap(preference.locator('input'), preference.locator('p'), 6);
		await gap(options.locator('.ug-preference'), options.locator('select').locator('..'), 12);
		await gap(options.locator('select'), options.locator(':scope > p'), 6);
		await gap(options.locator(':scope > p'), options.locator(':scope > button'), 12);
		await gap(options.locator(':scope > button'), options.locator('.ug-operational-warnings'), 16);
		const runtime = connection.locator('.ug-runtime-choice');
		await gap(runtime.locator('button'), runtime.locator('p'), 6);
		await gap(runtime.locator('..').locator(':scope > .ug-preference'), runtime, 16);
		await bounded(connection);
	}
	await page.evaluate(() => window.postMessage({ type: 'tunnel-config', provider: 'ngrok', token: '' }, '*'));
	const account = connection.locator('.ug-ngrok-account');
	await account.getByLabel('ngrok authtoken', { exact: true }).fill('spacing-test');
	for (const width of [320, 420, 580]) {
		await page.setViewportSize({ width, height: 900 });
		await gap(account.locator(':scope > p').first(), account.locator('.ug-label'), 12);
		await gap(account.locator('.ug-endpoint'), account.locator(':scope > p').last(), 6);
		await gap(account.locator(':scope > p').last(), account.locator(':scope > .ug-toolbar'), 12);
		await bounded(connection);
	}
	await page.evaluate(() => window.postMessage({ type: 'tunnel-config', provider: 'quick', token: '' }, '*'));
	await connection.getByText('Tunnel options', { exact: true }).click();
	await connection.getByText('API configuration', { exact: true }).click();
	await page.getByRole('button', { name: 'Manage Claude', exact: true }).click();
	await page.locator('.ug-model-variant').first().waitFor();
	for (const width of [320, 420, 580]) {
		await page.setViewportSize({ width, height: 900 });
		for (const copy of await page.locator('.ug-model-copy').all()) {
			const children = copy.locator(':scope > *');
			const count = await children.count();
			for (let i = 1; i < count; i++) await gap(children.nth(i - 1), children.nth(i), 4);
		}
		for (const variant of await page.locator('.ug-model-variant').all())
			await gap(variant.locator('button').first(), variant.locator('button').last(), 6, true);
		// The variant table deliberately scrolls locally; its buttons remain reachable there.
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
	}
	await page.getByRole('button', { name: 'Close Claude', exact: true }).click();
	await page.setViewportSize({ width: 420, height: 820 });
}

export async function verifyBannerSpacing(page: Page): Promise<void> {
	for (const width of [320, 420, 580]) {
		await page.setViewportSize({ width, height: 900 });
		const banner = page.locator('.ug-banner-copy').first();
		await banner.waitFor();
		const actual = await measureGap(banner.locator('strong'), banner.locator('p'));
		assert.ok(Math.abs(actual - 4) < 0.6, `Expected 4px banner gap, got ${actual}px`);
		for (const button of await page.locator('.ug-banner').getByRole('button').all()) {
			const box = await button.boundingBox();
			assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1);
		}
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
	}
	await page.setViewportSize({ width: 420, height: 820 });
}
