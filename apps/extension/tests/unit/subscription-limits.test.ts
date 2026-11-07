import { describe, expect, it } from 'vitest';

import { formatSubscriptionLimitLine, formatSubscriptionLimitTooltip } from '../../src/subscription-limits';

import type { ProviderUsage } from '@ungate/shared/frontend';

function provider(overrides: Partial<ProviderUsage> = {}): ProviderUsage {
	return {
		provider: 'claude',
		status: 'ok',
		message: null,
		checkedAt: '2026-11-07T00:00:00.000Z',
		fetchedAt: '2026-11-07T00:00:00.000Z',
		stale: false,
		windows: [],
		source: null,
		contract: 'internal',
		...overrides
	};
}

describe('subscription limit line', () => {
	it('shows Claude five-hour and weekly usage and skips a disconnected provider', () => {
		const line = formatSubscriptionLimitLine([
			provider({
				windows: [
					{
						id: 'five_hour',
						label: 'Five hours',
						usedPercent: 12.4,
						remainingPercent: 87.6,
						resetsAt: '2026-11-07T05:00:00.000Z',
						windowSeconds: 18_000
					},
					{
						id: 'seven_day',
						label: 'Weekly',
						usedPercent: 40,
						remainingPercent: 60,
						resetsAt: '2026-11-14T00:00:00.000Z',
						windowSeconds: 604_800
					},
					{
						id: 'seven_day_opus',
						label: 'Weekly · Opus',
						usedPercent: 99,
						remainingPercent: 1,
						resetsAt: null,
						windowSeconds: 604_800
					}
				]
			}),
			provider({ provider: 'openai', status: 'not_connected', windows: [], fetchedAt: null }),
			provider({ provider: 'minimax', status: 'unsupported', message: 'unsupported', windows: [] })
		]);

		expect(line).toBe('Claude 7d 60% left');
	});

	it('keeps a stale connected snapshot and hides a connected provider with no windows', () => {
		const providers = [
			provider({
				provider: 'openai',
				stale: true,
				windows: [
					{
						id: 'rate_limit.primary_window',
						label: 'Codex · 5 hours',
						usedPercent: 3,
						remainingPercent: 97,
						resetsAt: '2026-11-07T05:00:00.000Z',
						windowSeconds: 18_000
					},
					{
						id: 'rate_limit.secondary_window',
						label: 'Codex · 7 days',
						usedPercent: 11.2,
						remainingPercent: 88.8,
						resetsAt: null,
						windowSeconds: 604_800
					}
				]
			}),
			provider({ status: 'error', message: 'timeout', windows: [] })
		];

		expect(formatSubscriptionLimitLine(providers)).toBe('ChatGPT 7d 88% left (stale)');
		expect(formatSubscriptionLimitTooltip(providers)).toContain('ChatGPT\n7d · 88% left\n');
		expect(formatSubscriptionLimitTooltip(providers)).not.toContain('Codex · 7 days (7d)');
		expect(formatSubscriptionLimitTooltip(providers)).toContain('\nShowing the last successful read\n');
		expect(formatSubscriptionLimitTooltip(providers)).not.toContain('ChatGPT:');
		expect(formatSubscriptionLimitTooltip(providers)).toContain('\nReset time not reported');
	});

	it('returns nothing when every provider is disconnected', () => {
		expect(formatSubscriptionLimitLine([provider({ status: 'not_connected', windows: [], fetchedAt: null })])).toBeNull();
	});
	it('does not label a seven-day primary window five hours or select additional pools', () => {
		const base = { label: 'Codex', usedPercent: 60, remainingPercent: 40, resetsAt: null, windowSeconds: 604800 };
		expect(
			formatSubscriptionLimitLine([
				provider({
					provider: 'openai',
					windows: [
						{ ...base, id: 'code_review_rate_limit.primary_window', remainingPercent: 0 },
						{ ...base, id: 'rate_limit.primary_window' }
					]
				})
			])
		).toBe('ChatGPT 7d 40% left');
	});
	it('keeps zero, fractional and unknown remaining distinct', () => {
		const window = {
			id: 'five_hour',
			label: 'Five hours',
			usedPercent: 100,
			remainingPercent: 0,
			resetsAt: null,
			windowSeconds: 18000
		};
		expect(formatSubscriptionLimitLine([provider({ windows: [window] })])).toBe('Claude 5h 0% left');
		expect(formatSubscriptionLimitLine([provider({ windows: [{ ...window, remainingPercent: 0.8 }] })])).toBe(
			'Claude 5h <1% left'
		);
		expect(formatSubscriptionLimitLine([provider({ windows: [{ ...window, remainingPercent: null }] })])).toBeNull();
	});
});
