/** Directory name under the user home for Ungate state, logs, and binaries. */
export const UNGATE_DIR = '.ungate';

/** Owner read and write. Secrets, databases, logs, and lock files. */
export const PRIVATE_FILE_MODE = 0o600;

/** Owner read, write, and execute. Private directories. */
export const PRIVATE_DIR_MODE = 0o700;

/** Owner read, write, and execute; everyone else read and execute. Downloaded binaries. */
export const EXECUTABLE_FILE_MODE = 0o755;

/** Permission bits of fs.Stats.mode, excluding the file-type bits. */
export const FILE_PERMISSION_BITS = 0o777;

/**
 * Empty `/dev/null` makes cloudflared log "Configuration file was empty" at error level.
 * A real empty mapping still has no ingress, so the `--url` origin is what gets published.
 */
export const QUICK_TUNNEL_CONFIG = '{}\n';

/** File name of that mapping under the Ungate data directory. */
export const QUICK_TUNNEL_CONFIG_NAME = 'quick-tunnel.yml';
