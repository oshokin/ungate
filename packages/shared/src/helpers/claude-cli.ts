import { CLAUDE_CLI_LATEST_VERSION, CLAUDE_CLI_STABLE_VERSION, CLAUDE_CLI_USER_AGENT_SUFFIX } from '../constants';

import type { ClaudeCliVersionMode } from '../types/settings';

/** Shown when a custom Claude Code version is not major.minor.patch. */
const CUSTOM_VERSION_ERROR = 'Custom Claude Code version must look like 2.1.280';

export class ClaudeCliVersion {
	private static readonly versionPattern = /^\d+\.\d+\.\d+$/;

	public static isVersionString(value: string): boolean {
		return this.versionPattern.test(value.trim());
	}

	public static formatUserAgent(version: string): string {
		const trimmed = version.trim();

		return `claude-cli/${trimmed} ${CLAUDE_CLI_USER_AGENT_SUFFIX}`;
	}

	public static resolve(mode: ClaudeCliVersionMode, customVersion: string | null): string {
		if (mode === 'latest') {
			return CLAUDE_CLI_LATEST_VERSION;
		}

		if (mode === 'custom') {
			const trimmed = customVersion?.trim();

			if (trimmed && this.isVersionString(trimmed)) {
				return trimmed;
			}
		}

		return CLAUDE_CLI_STABLE_VERSION;
	}

	public static validateCustomVersion(value: string): string | null {
		const trimmed = value.trim();

		if (!trimmed || !this.isVersionString(trimmed)) {
			return CUSTOM_VERSION_ERROR;
		}

		return null;
	}
}
