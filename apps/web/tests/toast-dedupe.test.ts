import { describe, expect, it } from 'vitest';

import { sameToast } from '../src/shared/toast-dedupe';

describe('toast queue dedupe', () => {
	it('coalesces equivalent errors and statuses', () => {
		expect(sameToast({ message: 'Failed', tone: 'error' }, { message: 'Failed', tone: 'error' })).toBe(true);
		expect(sameToast({ message: 'Saved', tone: 'status' }, { message: 'Saved', tone: 'status' })).toBe(true);
	});

	it('keeps different messages, tones, and action labels independent', () => {
		expect(sameToast({ message: 'Failed', tone: 'error' }, { message: 'Retry', tone: 'error' })).toBe(false);
		expect(sameToast({ message: 'Failed', tone: 'error' }, { message: 'Failed', tone: 'status' })).toBe(false);
		expect(
			sameToast(
				{ message: 'Unavailable', tone: 'error', action: { label: 'Restart' } },
				{ message: 'Unavailable', tone: 'error', action: { label: 'Retry' } }
			)
		).toBe(false);
	});
});
