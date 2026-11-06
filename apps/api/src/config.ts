import { MINIMAX_BASE_URLS, TCP_PORT_MAX, type AppSettings } from '@ungate/shared';

import type { ProxyConfig } from './types';

/** Provider URLs and OAuth client values. These are upstream contracts, not local preferences. */
export const config = {
	claude: {
		clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
		oauth: {
			tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
			redirectUri: 'https://console.anthropic.com/oauth/code/callback'
		}
	},
	anthropic: {
		apiUrl: 'https://api.anthropic.com',
		beta: {
			oauth: 'oauth-2025-04-20',
			claudeCode: 'claude-code-20250219',
			interleavedThinking: 'interleaved-thinking-2025-05-14'
		}
	},
	minimax: {
		baseUrlGlobal: MINIMAX_BASE_URLS.global,
		baseUrlChina: MINIMAX_BASE_URLS.china
	},
	claudeCode: {
		systemPrompt: "You are Claude Code, Anthropic's official CLI for Claude."
	},
	openai: {
		oauth: {
			authorizeUrl: 'https://auth.openai.com/oauth/authorize',
			tokenUrl: 'https://auth.openai.com/oauth/token',
			redirectUri: 'http://localhost:1455/auth/callback',
			clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
			scope: 'openid profile email offline_access',
			codeChallengeMethod: 'S256',
			extraParams: {
				id_token_add_organizations: 'true',
				codex_cli_simplified_flow: 'true',
				originator: 'codex_cli_rs'
			}
		},
		codexUrl: 'https://chatgpt.com/backend-api/codex'
	}
} as const;

export type Config = ProxyConfig;

export function getConfig(settings: AppSettings): ProxyConfig {
	let envPort: number | undefined;

	if (process.env.PORT !== undefined) {
		const raw = process.env.PORT;
		const parsed = Number(raw);
		// Environment-only zero requests an ephemeral port for isolated process tests.
		if (!/^\d+$/.test(raw) || !Number.isInteger(parsed) || parsed < 0 || parsed > TCP_PORT_MAX) {
			throw new Error(`PORT must be an integer between 0 and ${TCP_PORT_MAX}`);
		}
		envPort = parsed;
	}

	return {
		port: envPort ?? settings.port,
		apiKey: settings.apiKey ?? undefined,
		quietMode: settings.quiet
	};
}
