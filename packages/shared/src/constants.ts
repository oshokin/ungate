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
