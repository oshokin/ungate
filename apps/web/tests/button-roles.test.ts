import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/app.css', import.meta.url), 'utf8');

function block(selector: string): string {
	const start = css.indexOf(selector);
	expect(start).toBeGreaterThanOrEqual(0);

	return css.slice(start, css.indexOf('}', start));
}

describe('button roles', () => {
	it('paints only the forward action with the accent fill', () => {
		expect(block('.ug-primary {')).toContain('var(--ug-button-bg)');
		expect(block('.ug-primary {')).toContain('width: fit-content');
		expect(block(".ug-choice .ug-button[aria-pressed='true']")).not.toContain('--ug-button-bg');
	});

	it('gives secondary actions their own hover pair', () => {
		expect(block('.ug-secondary {')).toContain('button-secondaryBackground');
		expect(block('.ug-secondary:hover:not(:disabled)')).toContain('button-secondaryHoverBackground');
	});
});
