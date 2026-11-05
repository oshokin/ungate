/** Legacy runtime flag kept false so old windows do not toggle Cursor's key storage. */
export const DEFAULT_KEY_FIX_ENABLED = false;

/** Claude Code version sent when the user leaves the setting on Stable. */
export const CLAUDE_CLI_STABLE_VERSION = '2.1.9';

/** Claude Code version sent when the user selects Latest. */
export const CLAUDE_CLI_LATEST_VERSION = '2.1.296';

/** Suffix required in the Claude Code User-Agent. Anthropic checks this fingerprint. */
export const CLAUDE_CLI_USER_AGENT_SUFFIX = '(external, claude-vscode, agent-sdk/0.2.7)';

/** Official MiniMax API origins. A user base URL must match one of these. */
export const MINIMAX_BASE_URLS = {
	global: 'https://api.minimax.io',
	china: 'https://api.minimaxi.com'
} as const;

/** Milliseconds in one second. */
export const MILLISECONDS_PER_SECOND = 1000;

/** Seconds in one minute. */
export const SECONDS_PER_MINUTE = 60;

/** Seconds in one hour. */
export const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;

/** Seconds in one civil day. */
export const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;

/** IPv4 loopback. The API, the extension and the OAuth callback bind only here. */
export const LOOPBACK_HOST = '127.0.0.1';

/** Port stored for a new local API. Settings can change it later. */
export const DEFAULT_API_PORT = 47821;

/** Smallest TCP port a local API may use. */
export const TCP_PORT_MIN = 1;

/** Largest TCP port a local API may use. */
export const TCP_PORT_MAX = 65535;

/** anthropic-version header required by the Messages API. */
export const ANTHROPIC_API_VERSION = '2023-06-01';

/** openai-version header echoed on OpenAI-compatible responses. */
export const OPENAI_API_VERSION = '2020-10-01';
