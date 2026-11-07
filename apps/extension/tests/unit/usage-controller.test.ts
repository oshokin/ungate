import { formatUsageDuration, formatUsagePercent, type SubscriptionUsage } from '@ungate/shared/frontend';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { UsageController } from '../../src/usage-controller';

const settings = vi.hoisted((): { values: Record<string, unknown> } => ({ values: {} }));
vi.mock('vscode', () => ({
	workspace: { getConfiguration: () => ({ inspect: (key: string) => ({ globalValue: settings.values[key] }) }) }
}));
afterEach(() => {
	vi.useRealTimers();
	settings.values = {};
});

describe('usage shared formatting and controller', () => {
	it.each([
		[120, 60_000, false, false],
		[120, 120_000, false, true],
		[15, 15_000, false, true],
		[120, -1, false, true],
		[120, 1_000, true, true]
	])('ages cache reads at cadence %s with age %s and failure stale %s', async (interval, age, failed, stale) => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-11-07T12:00:00Z'));
		settings.values['usage.intervalSeconds'] = interval;
		const data: SubscriptionUsage = {
			providers: [
				{
					provider: 'claude',
					status: 'ok',
					checkedAt: new Date().toISOString(),
					fetchedAt: new Date(Date.now() - Number(age)).toISOString(),
					stale: Boolean(failed),
					windows: [],
					source: 'test',
					contract: 'internal',
					message: null
				}
			]
		};
		const read = vi.fn(() => Promise.resolve(data));
		const controller = new UsageController(read, () => false, vi.fn());
		await controller.load(false);
		expect(controller.state.data?.providers[0].stale).toBe(stale);
		expect(read.mock.calls).toHaveLength(1);
		expect(data.providers[0].stale).toBe(failed);
		controller.dispose();
	});
	it('uses real durations and conservative remaining percentages', () => {
		expect(formatUsageDuration(604800)).toBe('7d');
		expect(formatUsageDuration(18000)).toBe('5h');
		expect(formatUsageDuration(null)).toBe('Period not reported');
		expect([0, 0.9, 88.8, null].map(formatUsagePercent)).toEqual(['0%', '<1%', '88%', 'Not reported']);
	});
	it('defaults to no polling and no widgets, with a saved 60 second interval', () => {
		const read = vi.fn();
		const controller = new UsageController(read, () => true, vi.fn());
		controller.configure();
		expect(controller.state.preferences).toEqual({
			autoRefresh: false,
			intervalSeconds: 60,
			widgets: { claude: false, openai: false, minimax: false }
		});
		expect(read).not.toHaveBeenCalled();
		controller.dispose();
	});
	it('deduplicates manual refreshes and ignores a response after disposal', async () => {
		let resolve!: (value: { providers: [] }) => void;
		const read = vi.fn(
			() =>
				new Promise<{ providers: [] }>((done) => {
					resolve = done;
				})
		);
		const controller = new UsageController(read, () => true, vi.fn());
		const first = controller.load(true);
		expect(controller.load(true)).toBe(first);
		expect(read).toHaveBeenCalledTimes(1);
		controller.dispose();
		resolve({ providers: [] });
		await first;
		expect(controller.state.data).toBeNull();
	});
	it('polls sequentially at 60 seconds, follows leadership, and cancels on disable', async () => {
		vi.useFakeTimers();
		settings.values['usage.autoRefresh'] = true;
		let leader = true;
		const read = vi.fn((_refresh: boolean, _signal: AbortSignal) => Promise.resolve({ providers: [] }));
		const controller = new UsageController(read, () => leader, vi.fn());
		controller.configure();
		await vi.advanceTimersByTimeAsync(0);
		expect(read.mock.calls[0][0]).toBe(true);
		await vi.advanceTimersByTimeAsync(59999);
		expect(read).toHaveBeenCalledTimes(1);
		leader = false;
		await vi.advanceTimersByTimeAsync(1);
		expect(read.mock.calls[1][0]).toBe(false);
		settings.values['usage.intervalSeconds'] = 15;
		controller.configure();
		await vi.advanceTimersByTimeAsync(15000);
		expect(read).toHaveBeenCalledTimes(4);
		settings.values['usage.autoRefresh'] = false;
		controller.configure();
		await vi.advanceTimersByTimeAsync(60000);
		expect(read).toHaveBeenCalledTimes(4);
		expect(controller.state.nextUpdate).toBeNull();
		controller.dispose();
	});
	it('honors retry-after and restores the configured interval after success', async () => {
		vi.useFakeTimers();
		settings.values['usage.autoRefresh'] = true;
		const read = vi
			.fn()
			.mockResolvedValueOnce({ providers: [{ status: 'error', retryAfterSeconds: 180 }] })
			.mockResolvedValue({ providers: [] });
		const controller = new UsageController(read, () => true, vi.fn());
		controller.configure();
		await vi.advanceTimersByTimeAsync(179999);
		expect(read).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(read).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(60000);
		expect(read).toHaveBeenCalledTimes(3);
		controller.dispose();
	});
});
