import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('toast watchers', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it('does not announce the same persistent error again after a component remount', async () => {
		const { shouldAnnounceToast } = await import('../src/shared/toast-watcher');
		expect(shouldAnnounceToast('tunnel', 'Restart the API.')).toBe(true);
		expect(shouldAnnounceToast('tunnel', 'Restart the API.')).toBe(false);
	});

	it('announces a changed error and the same error after recovery', async () => {
		const { shouldAnnounceToast } = await import('../src/shared/toast-watcher');
		expect(shouldAnnounceToast('usage', 'Unavailable')).toBe(true);
		expect(shouldAnnounceToast('usage', 'Refresh failed')).toBe(true);
		expect(shouldAnnounceToast('usage', null)).toBe(false);
		expect(shouldAnnounceToast('usage', 'Unavailable')).toBe(true);
	});

	it('deduplicates each source independently', async () => {
		const { shouldAnnounceToast } = await import('../src/shared/toast-watcher');
		expect(shouldAnnounceToast('auth:claude', 'Unavailable')).toBe(true);
		expect(shouldAnnounceToast('auth:openai', 'Unavailable')).toBe(true);
	});
});
