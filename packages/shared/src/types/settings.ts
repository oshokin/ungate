export type ReasoningBudgetTier = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | 'persistent';

export type ModelMappingProvider = 'claude' | 'minimax' | 'openai';
export type ModelServiceTier = 'default' | 'priority';
export type TunnelProtocol = 'http2' | 'quic' | 'auto';

/** Providers a model row can point at. */
export const MODEL_MAPPING_PROVIDERS = ['claude', 'minimax', 'openai'] as const;
/** Service tiers accepted on an OpenAI model row. */
export const MODEL_SERVICE_TIERS = ['default', 'priority'] as const;
/** cloudflared protocols the tunnel manager can start. */
export const TUNNEL_PROTOCOLS = ['http2', 'quic', 'auto'] as const;
/** Reasoning tiers stored on a model row. The suffix in the model id selects one. */
export const REASONING_BUDGET_TIERS = [
	'none',
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
	'max',
	'ultra',
	'persistent'
] as const;

/** How the Claude Code version in the User-Agent is chosen. */
export const CLAUDE_CLI_VERSION_MODES = ['stable', 'latest', 'custom'] as const;

export type ClaudeCliVersionMode = (typeof CLAUDE_CLI_VERSION_MODES)[number];

export interface ModelMappingConfig {
	id: string;
	label: string;
	provider: ModelMappingProvider;
	upstreamModel: string;
	sortOrder: number;
	reasoningBudget: ReasoningBudgetTier | null;
	serviceTier: ModelServiceTier | null;
	/** Input context metadata reported to clients; null means unknown. */
	contextWindow?: number | null;
	/** Upstream output cap; null keeps the provider fallback. */
	maxOutputTokens?: number | null;
}

export interface DiscoveredModel {
	id: string;
	label: string;
	upstreamModel: string;
	description?: string;
	priority?: number;
	isProviderDefault?: boolean;
	reasoningLevels?: ReasoningBudgetTier[];
	defaultReasoningLevel?: ReasoningBudgetTier | null;
	serviceTiers?: ModelServiceTier[];
	defaultServiceTier?: ModelServiceTier | null;
	contextWindow?: number;
	maxOutputTokens?: number;
}

export type ModelDiscoveryStatus = 'ok' | 'not_connected' | 'unsupported' | 'error';

export interface ModelDiscoveryResponse {
	provider: ModelMappingProvider;
	status: ModelDiscoveryStatus;
	message: string | null;
	models: DiscoveredModel[];
	catalogComplete: boolean;
	fetchedAt: string | null;
}

export interface AppSettings {
	port: number;
	apiKey: string | null;
	quiet: boolean;
	extraInstruction: string | null;
	claudeCliVersionMode: ClaudeCliVersionMode;
	claudeCliVersionCustom: string | null;
	tunnelProtocol: TunnelProtocol;
	models: ModelMappingConfig[];
}
/** Provider attribution in protocol adapters; no local request collection. */
export type RequestSource = ModelMappingProvider | 'error';
