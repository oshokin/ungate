import * as os from 'node:os';
import * as path from 'node:path';

const baseDir = path.join(os.homedir(), '.ungate');

export const config = {
	baseDir,
	paths: {
		stateFilePath: path.join(baseDir, 'runtime-state.json'),
		lockPath: path.join(baseDir, 'runtime-state.lock'),
		logDir: path.join(baseDir, 'logs')
	},
	runtimeState: {
		// Max age for a client heartbeat before the window is considered stale.
		staleClientMs: 30000,
		// Default lock wait; only a provably dead owner is recovered.
		lockTimeoutMs: 1500,
		// Minimum interval between heartbeat writes for the same window.
		heartbeatThrottleMs: 2000
	},
	locks: {
		commandsTimeoutMs: 180_000,
		startupTimeoutMs: 120_000
	},
	apiServer: {
		startupTimeoutMs: 30_000,
		shutdownRequestTimeoutMs: 5_000,
		shutdownTimeoutMs: 10_000,
		terminationGraceMs: 2_000,
		terminationTimeoutMs: 5_000,
		pollIntervalMs: 100,
		healthFailureThreshold: 3,
		stdoutBufferBytes: 8_192,
		retainedProcessLogs: 5,
		// Interval between API /health checks while process is running.
		healthCheckIntervalMs: 1000,
		// Grace period before stopping API when no live windows remain.
		noClientsGracePeriodMs: 3000,
		// Delay before spawning API again after restart/clean exit.
		restartDelayMs: 500,
		// Request timeout used when validating an existing API port.
		portHealthRequestTimeoutMs: 1500,
		adminRequestTimeoutMs: 3_000
	},
	tunnelManager: {
		monitorIntervalMs: 1_000,
		startupTimeoutMs: 45_000,
		startupPollIntervalMs: 200,
		stopPollIntervalMs: 100
	},
	extensionController: {
		// Interval between heartbeat updates from the current window.
		heartbeatIntervalMs: 2000,
		// Interval for pulling shared runtime state and syncing UI/actions.
		runtimeSyncIntervalMs: 2000
	}
};
