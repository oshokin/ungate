import * as os from 'node:os';
import * as path from 'node:path';

import { UNGATE_DIR } from '@ungate/shared';

const baseDir = path.join(os.homedir(), UNGATE_DIR);

/** Paths and deadlines for the shared API, tunnel and multi-window state. */
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
		/** Cross-window command lock. Matches the longest dashboard action. */
		commandsTimeoutMs: 180_000,
		/** Lock held while the shared API is starting. */
		startupTimeoutMs: 120_000
	},
	apiServer: {
		/** How long to wait for the child process to print its port. */
		startupTimeoutMs: 30_000,
		/** HTTP timeout for the admin shutdown request. */
		shutdownRequestTimeoutMs: 5_000,
		/** How long the extension waits after asking the API to stop. */
		shutdownTimeoutMs: 10_000,
		/** SIGTERM grace before SIGKILL. */
		terminationGraceMs: 2_000,
		/** Final wait after SIGKILL. */
		terminationTimeoutMs: 5_000,
		/** Pause between startup polls for the listening port. */
		pollIntervalMs: 100,
		/** Consecutive health failures before the API is marked down. */
		healthFailureThreshold: 3,
		/** Stdout retained while searching for the printed port. */
		stdoutBufferBytes: 8_192,
		/** Recent API process logs kept in the runtime state. */
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
		/** How often a running tunnel is checked after it connects. */
		monitorIntervalMs: 1_000,
		/** Pause between startup polls for the tunnel URL. */
		startupPollIntervalMs: 200,
		/** Pause between checks that cloudflared has exited. */
		stopPollIntervalMs: 100
	},
	extensionController: {
		// Interval between heartbeat updates from the current window.
		heartbeatIntervalMs: 2000,
		// Interval for pulling shared runtime state and syncing UI/actions.
		runtimeSyncIntervalMs: 2000,
		// Coalesce filesystem notifications for the shared runtime file.
		runtimeStateDebounceMs: 100,
		// How long a yellow status-bar warning stays visible.
		statusBarWarningMs: 8_000,
		// A starting API owned by a live window is left alone for this long.
		apiStartFreshMs: 120_000
	}
};
