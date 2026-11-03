/** A process probe must not stall the extension host. */
export const PROCESS_PROBE_TIMEOUT_MS = 3_000;

/** stdout/stderr retained from a short process probe. */
export const PROCESS_PROBE_MAX_BUFFER_BYTES = 64 * 1024;

/** Node inspection used to choose a better-sqlite3 prebuild. */
export const SQLITE_RUNTIME_INSPECT_TIMEOUT_MS = 5_000;

/** In-memory load test of one native SQLite binding. */
export const SQLITE_BINDING_LOAD_TIMEOUT_MS = 10_000;

/** Download of one pinned cloudflared or native artifact. */
export const ARTIFACT_DOWNLOAD_TIMEOUT_MS = 120_000;
