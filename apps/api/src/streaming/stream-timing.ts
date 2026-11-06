/** Shared transport heartbeat policy; unrelated to dashboard action deadlines. */
export const STREAM_HEARTBEAT_MS = 15_000;
/** Initial provider readiness deadline. */
export const STREAM_FIRST_BYTE_TIMEOUT_MS = 180_000;
/** Node timers overflow beyond signed 32-bit milliseconds. */
export const MAX_NODE_TIMER_MS = 2_147_483_647;
