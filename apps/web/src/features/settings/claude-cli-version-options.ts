import { CLAUDE_CLI_LATEST_VERSION, CLAUDE_CLI_STABLE_VERSION } from '@ungate/shared/frontend';

import type { ClaudeCliVersionMode } from '@ungate/shared/frontend';

export interface ClaudeCliVersionOption {
	mode: ClaudeCliVersionMode;
	label: string;
	version: string | null;
	tooltip: string;
}

/** Choices shown for the Claude Code version setting. */
export const CLAUDE_CLI_VERSION_OPTIONS: ClaudeCliVersionOption[] = [
	{
		mode: 'stable',
		label: 'Stable',
		version: CLAUDE_CLI_STABLE_VERSION,
		tooltip: 'Tested with Ungate. Newer models may not work with this version.'
	},
	{
		mode: 'latest',
		label: 'Latest',
		version: CLAUDE_CLI_LATEST_VERSION,
		tooltip: 'Current Claude Code version. Required by newer models, but may not work with older ones.'
	},
	{
		mode: 'custom',
		label: 'Custom',
		version: null,
		tooltip: 'Any Claude Code version. Compatibility with models is not guaranteed.'
	}
];
