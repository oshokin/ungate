export type ReasoningBudgetTier = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | 'persistent';

export type ModelMappingProvider = 'claude' | 'minimax' | 'openai';
export type ModelServiceTier = 'default' | 'priority';
export type TunnelProtocol = 'http2' | 'quic' | 'auto';

export const MODEL_MAPPING_PROVIDERS = ['claude', 'minimax', 'openai'] as const;
export const MODEL_SERVICE_TIERS = ['default', 'priority'] as const;
export const TUNNEL_PROTOCOLS = ['http2', 'quic', 'auto'] as const;
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
