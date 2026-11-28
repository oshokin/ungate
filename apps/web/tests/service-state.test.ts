import { sameServiceState, UNGATE_VERSION, type ServiceState } from '@ungate/shared/frontend';
import { describe, expect, it } from 'vitest';

const banner: ServiceState = {
	status: 'error',
	version: null,
	expectedVersion: UNGATE_VERSION,
	canUpdate: false,
	message: 'Ungate API did not become ready within 30 seconds.',
	logsConnected: true,
	restartRequired: false
};

describe('sameServiceState', () => {
	it('treats a repeated API-down snapshot as the same banner', () => {
		expect(sameServiceState(banner, { ...banner })).toBe(true);
		expect(sameServiceState(banner, { ...banner, logsConnected: undefined, restartRequired: undefined })).toBe(true);
	});

	it('notices a status change that would show or hide the banner', () => {
		expect(sameServiceState(banner, { ...banner, status: 'ready', message: null })).toBe(false);
		expect(sameServiceState(banner, { ...banner, message: 'Connecting…' })).toBe(false);
	});
});
