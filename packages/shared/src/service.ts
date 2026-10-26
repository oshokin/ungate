/** One release identity for API, extension and dashboard. Packaging checks the manifest. */
export const UNGATE_VERSION = '1.7.14';
export const API_PROTOCOL_VERSION = 3;

export interface ApiHealth {
	service: 'ungate';
	pid: number;
	version: string | null;
	protocolVersion: number | null;
}

export interface ServiceState {
	status: 'checking' | 'ready' | 'incompatible' | 'stopped' | 'error';
	version: string | null;
	expectedVersion: string;
	canUpdate: boolean;
	message: string | null;
}

export function compareReleaseVersions(left: string, right: string): number | null {
	if (!/^\d+\.\d+\.\d+$/.test(left) || !/^\d+\.\d+\.\d+$/.test(right)) return null;
	const a = left.split('.').map(Number);
	const b = right.split('.').map(Number);
	for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;

	return 0;
}

export function describeService(health: ApiHealth): ServiceState {
	const ready = health.version === UNGATE_VERSION && health.protocolVersion === API_PROTOCOL_VERSION;
	const comparison = health.version ? compareReleaseVersions(health.version, UNGATE_VERSION) : -1;
	const protocolIsOlder = health.protocolVersion === null || health.protocolVersion < API_PROTOCOL_VERSION;
	const canUpdate = !ready && comparison !== null && (comparison < 0 || (comparison === 0 && protocolIsOlder));
	const sameReleaseNeedsApiUpdate = health.version === UNGATE_VERSION && protocolIsOlder;

	return {
		status: ready ? 'ready' : 'incompatible',
		version: health.version,
		expectedVersion: UNGATE_VERSION,
		canUpdate,
		message: ready
			? null
			: canUpdate
				? sameReleaseNeedsApiUpdate
					? 'The shared API is from an older Ungate build. Update the API when active chats finish.'
					: `The shared API is ${health.version ?? 'an older release'}; this window needs ${UNGATE_VERSION}. Update the API when active chats finish.`
				: 'The shared API is newer than this window. Update Ungate in this window, then reload this window; shared services will keep running and the API will not be downgraded.'
	};
}
