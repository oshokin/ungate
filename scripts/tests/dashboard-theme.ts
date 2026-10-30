import assert from 'node:assert/strict';
import { join } from 'node:path';

import { measureTextContrast } from './theme-contrast.mjs';

import type { Page } from 'playwright';

/** Representative editor tokens, independent of the operating system's preferred scheme. */
const themes = [
	{
		name: 'dark',
		kind: 'vscode-dark',
		background: '#1e1e1e',
		foreground: '#dddddd',
		muted: '#aaaaaa',
		input: '#3c3c3c',
		button: '#0e639c',
		error: '#f48771',
		warning: '#cca700',
		selection: '#094771'
	},
	{
		name: 'light',
		kind: 'vscode-light',
		background: '#ffffff',
		foreground: '#202020',
		muted: '#555555',
		input: '#ffffff',
		button: '#005a9e',
		error: '#a1260d',
		warning: '#795e00',
		selection: '#005a9e'
	},
	{
		name: 'hc-dark',
		kind: 'vscode-high-contrast',
		background: '#000000',
		foreground: '#ffffff',
		muted: '#ffffff',
		input: '#000000',
		button: '#000000',
		error: '#ff8080',
		warning: '#ffff00',
		selection: '#000000'
	},
	{
		name: 'hc-light',
		kind: 'vscode-high-contrast-light',
		background: '#ffffff',
		foreground: '#000000',
		muted: '#000000',
		input: '#ffffff',
		button: '#0f4a85',
		error: '#a1260d',
		warning: '#795e00',
		selection: '#0f4a85'
	}
];

/** Measure actual rendered text against its composited background, including placeholders. */
async function assertReadable(page: Page, context: string): Promise<number> {
	const result = await page.evaluate(measureTextContrast);
	assert.ok(result.count > 0, `No visible text checked: ${context}`);
	assert.deepEqual(result.failures, [], `Unreadable text: ${context}`);

	return result.count;
}

export async function verifyDashboardThemes(
	page: Page,
	screenshots?: string
): Promise<{ configurations: number; screens: number; textChecks: number }> {
	let screens = 0,
		textChecks = 0;
	const configurations = [
		...themes.map((theme) => ({ ...theme, minimal: false })),
		...themes.map((theme) => ({ ...theme, name: `${theme.name}-minimal`, minimal: true })),
		{ ...themes[1], name: 'light-inverted-controls', minimal: false }
	];
	await page.setViewportSize({ width: 1100, height: 900 });
	for (const theme of configurations) {
		await page.emulateMedia({ colorScheme: theme.kind.includes('light') ? 'dark' : 'light' });
		await page.evaluate((theme) => {
			const style = document.documentElement.style;
			style.cssText = '';
			document.body.className = theme.kind;
			const tokens: Record<string, string> = {
				'editor-background': theme.background,
				'editor-foreground': theme.foreground
			};
			if (!theme.minimal)
				Object.assign(tokens, {
					descriptionForeground: theme.muted,
					focusBorder: theme.kind.includes('contrast') ? theme.foreground : theme.button,
					'widget-border': theme.muted,
					contrastBorder: theme.kind.includes('contrast') ? theme.foreground : 'transparent',
					'input-background': theme.input,
					'input-foreground': theme.foreground,
					'input-placeholderForeground': theme.muted,
					'input-border': theme.muted,
					'dropdown-background': theme.input,
					'dropdown-foreground': theme.foreground,
					'button-background': theme.button,
					'button-foreground': '#ffffff',
					'button-hoverBackground': theme.selection,
					'button-secondaryBackground': theme.name === 'light-inverted-controls' ? '#005a9e' : theme.input,
					'button-secondaryForeground': theme.name === 'light-inverted-controls' ? '#ffffff' : theme.foreground,
					'button-secondaryHoverBackground': theme.name === 'light-inverted-controls' ? '#003d6b' : theme.background,
					'button-border': theme.muted,
					'editorWidget-background': theme.background,
					'editorWidget-foreground': theme.foreground,
					'editorHoverWidget-background': theme.background,
					'editorHoverWidget-foreground': theme.foreground,
					'editorHoverWidget-border': theme.muted,
					errorForeground: theme.error,
					'editorWarning-foreground': theme.warning,
					'testing-iconPassed': theme.kind.includes('light') ? '#187028' : '#73c991',
					'list-activeSelectionBackground': theme.selection,
					'list-activeSelectionForeground': '#ffffff',
					'list-hoverBackground': theme.input,
					'list-hoverForeground': theme.foreground,
					'notifications-background': theme.background,
					'notifications-foreground': theme.foreground,
					'menu-background': theme.background,
					'menu-foreground': theme.foreground,
					'menu-selectionBackground': theme.selection,
					'menu-selectionForeground': '#ffffff',
					'progressBar-background': theme.button
				});
			for (const [key, value] of Object.entries(tokens)) style.setProperty(`--vscode-${key}`, value);
			(document.activeElement as HTMLElement | null)?.blur();
		}, theme);
		const verify = async (name: string) => {
			textChecks += await assertReadable(page, `${theme.name}/${name}`);
			screens++;
			if (screenshots && !theme.minimal)
				await page.screenshot({ path: join(screenshots, `${theme.name}-${name}.png`), fullPage: true });
		};
		await page.getByRole('button', { name: 'Usage', exact: true }).click();
		await page.getByText('Connect this provider in Settings.', { exact: true }).first().waitFor();
		await verify('usage');
		await page.getByRole('button', { name: 'Connection', exact: true }).click();
		const settings = page.locator('details.ug-details').filter({ hasText: 'Advanced settings' });
		const settingsOpen = await settings.getAttribute('open');
		if (settingsOpen === null) await settings.locator('summary').click();
		await page.getByLabel('Port', { exact: true }).focus();
		await verify('settings');
		for (const name of ['Models', 'Reload window', 'More actions']) {
			await (
				name === 'More actions' ? page.getByLabel(name, { exact: true }) : page.getByRole('button', { name, exact: true })
			).hover();
			await verify(`hover-${name}`);
		}
		await page.mouse.move(0, 0);
		for (const provider of ['Claude', 'ChatGPT / Codex', 'MiniMax']) {
			const manage = page.getByRole('button', { name: `Manage ${provider}`, exact: true });
			const isCollapsed = await manage.count();
			if (isCollapsed) await manage.click();
			await page.getByRole('button', { name: `Close ${provider}`, exact: true }).waitFor();
			const modelId = page.getByLabel('Model ID', { exact: true });
			await modelId.waitFor();
			const advanced = page.locator('details').filter({ hasText: 'Advanced options' });
			const advancedOpen = await advanced.getAttribute('open');
			if (advancedOpen === null) await advanced.locator('summary').click();
			if (provider === 'MiniMax') {
				await page.getByRole('radio', { name: 'Custom', exact: true }).check();
				await page.getByPlaceholder('https://your-custom-url.com', { exact: true }).waitFor();
			}
			await verify(provider === 'Claude' ? 'claude-models' : provider === 'MiniMax' ? 'minimax-models' : 'openai-models');
			if (provider === 'Claude') {
				await page.getByRole('button', { name: 'Sync Models', exact: true }).click();
				await page
					.getByText('Connect this provider before syncing models. Configured models were kept as fallback.', { exact: true })
					.waitFor();
				await page.getByRole('button', { name: 'Remove', exact: true }).click();
				const dialog = page.getByRole('dialog', { name: 'Remove model', exact: true });
				await dialog.waitFor();
				assert.equal(
					await dialog
						.getByRole('button', { name: 'Cancel', exact: true })
						.evaluate((button) => button === document.activeElement),
					true
				);
				await page.keyboard.press('Tab');
				assert.equal(
					await dialog
						.getByRole('button', { name: 'Remove', exact: true })
						.evaluate((button) => button === document.activeElement),
					true
				);
				await verify('remove-dialog');
				await page.keyboard.press('Escape');
				await dialog.waitFor({ state: 'hidden' });
				await page.getByRole('button', { name: 'Stable', exact: false }).hover();
				await page.getByRole('tooltip').first().waitFor();
				await page.getByRole('tooltip').first().waitFor();
				await verify('tooltip');
				const tooltip = page.getByRole('tooltip').first();
				assert.equal(
					await page.getByRole('button', { name: 'Stable', exact: false }).getAttribute('aria-describedby'),
					await tooltip.getAttribute('id')
				);
				await page.keyboard.press('Escape');
				await tooltip.waitFor({ state: 'hidden' });
				await page.mouse.move(0, 0);
			}
			await page.getByRole('button', { name: `Close ${provider}`, exact: true }).click();
		}
		for (const width of [320, 420, 580]) {
			await page.setViewportSize({ width, height: 820 });
			await page.getByLabel('More actions', { exact: true }).click();
			const menu = page.locator('.ug-menu');
			await menu.waitFor();
			const bounds = await menu.boundingBox();
			assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width, `${theme.name}/${width} menu clipped`);
			assert.equal(
				await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
				false,
				`${theme.name}/${width} narrow overflow`
			);
			await verify(`menu-${width}`);
			await page.keyboard.press('Escape');
			await page.getByRole('button', { name: 'Manage Claude', exact: true }).click();
			const stable = page.getByRole('button', { name: 'Stable', exact: false });
			await stable.focus();
			const hint = page.getByRole('tooltip').first();
			await hint.waitFor();
			const hintBounds = await hint.boundingBox();
			assert.ok(
				hintBounds && hintBounds.x >= 0 && hintBounds.x + hintBounds.width <= width,
				`${theme.name}/${width} tooltip clipped`
			);
			assert.equal(
				await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
				false,
				`${theme.name}/${width} provider overflow`
			);
			await verify(`provider-${width}`);
			await page.keyboard.press('Escape');
			await hint.waitFor({ state: 'hidden' });
			await page.getByRole('button', { name: 'Close Claude', exact: true }).click();
		}

		await page.setViewportSize({ width: 1100, height: 900 });
	}

	return { configurations: configurations.length, screens, textChecks };
}
