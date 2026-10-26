import { ClaudeCliVersion, isReasoningBudgetTier, isTunnelProtocol } from '@ungate/shared/frontend';

import type {
	AppSettings,
	ClaudeCliVersionMode,
	ModelMappingConfig,
	ModelMappingProvider,
	TunnelProtocol
} from '@ungate/shared/frontend';

interface SettingsFormStore {
	readonly port: string;
	readonly apiKey: string;
	readonly quiet: boolean;
	readonly extraInstruction: string;
	readonly models: ModelMappingConfig[];
	readonly modelsDirty: boolean;
	readonly claudeCliVersionMode: ClaudeCliVersionMode;
	readonly claudeCliVersionCustom: string;
	readonly tunnelProtocol: TunnelProtocol;
	setPort(value: string): void;
	setApiKey(value: string): void;
	setQuiet(value: boolean): void;
	setExtraInstruction(value: string): void;
	setModels(models: ModelMappingConfig[]): void;
	markModelsSaved(): void;
	setClaudeCliVersionMode(mode: ClaudeCliVersionMode): void;
	setClaudeCliVersionCustom(value: string): void;
	setTunnelProtocol(value: string): void;
	syncFromAppSettings(settings: AppSettings): void;
	validate(): string | null;
	toSavePayload(): Partial<AppSettings>;
}

let port = $state('');
let apiKey = $state('');
let quiet = $state(false);
let extraInstruction = $state('');
let models = $state<ModelMappingConfig[]>([]);
let savedModelsFingerprint = '';
let claudeCliVersionMode = $state<ClaudeCliVersionMode>('stable');
let claudeCliVersionCustom = $state('');
let tunnelProtocol = $state<TunnelProtocol>('http2');

function cloneModels(items: ModelMappingConfig[]): ModelMappingConfig[] {
	return items.map((model, index) => {
		let reasoningBudget = model.reasoningBudget;
		let serviceTier = model.serviceTier;
		let provider: ModelMappingProvider = 'claude';

		if (model.provider === 'minimax') {
			provider = 'minimax';
		}

		if (model.provider === 'openai') {
			provider = 'openai';
		}

		if (!isReasoningBudgetTier(reasoningBudget)) {
			reasoningBudget = null;
		}

		if (serviceTier !== 'default' && serviceTier !== 'priority') {
			serviceTier = null;
		}

		return { ...model, provider, reasoningBudget, serviceTier, sortOrder: index };
	});
}

function withSortOrder(items: ModelMappingConfig[]): ModelMappingConfig[] {
	return items.map((model, index) => ({ ...model, sortOrder: index }));
}

function modelsFingerprint(items: ModelMappingConfig[]): string {
	return JSON.stringify(withSortOrder(items));
}

function syncFromAppSettings(settings: AppSettings): void {
	const nextModels = cloneModels(settings.models);
	port = String(settings.port);
	apiKey = settings.apiKey ?? '';
	quiet = settings.quiet;
	extraInstruction = settings.extraInstruction ?? '';
	claudeCliVersionMode = settings.claudeCliVersionMode ?? 'stable';
	claudeCliVersionCustom = settings.claudeCliVersionCustom ?? '';
	tunnelProtocol = isTunnelProtocol(settings.tunnelProtocol) ? settings.tunnelProtocol : 'http2';
	models = nextModels;
	savedModelsFingerprint = modelsFingerprint(nextModels);
}

function setPort(value: string): void {
	port = value;
}

function setApiKey(value: string): void {
	apiKey = value;
}

function setQuiet(value: boolean): void {
	quiet = value;
}

function setExtraInstruction(value: string): void {
	extraInstruction = value;
}

function setModels(nextModels: ModelMappingConfig[]): void {
	models = withSortOrder(nextModels);
}

function markModelsSaved(): void {
	savedModelsFingerprint = modelsFingerprint(models);
}

function setClaudeCliVersionMode(mode: ClaudeCliVersionMode): void {
	claudeCliVersionMode = mode;
}

function setClaudeCliVersionCustom(value: string): void {
	claudeCliVersionCustom = value;
}

function setTunnelProtocol(value: string): void {
	if (isTunnelProtocol(value)) tunnelProtocol = value;
}

function validate(): string | null {
	const parsedPort = parseInt(port, 10);

	if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
		return 'Port must be an integer between 1 and 65535.';
	}

	if (!apiKey.trim()) return 'An Ungate API key is required. Copy the saved key into Cursor Settings → Models.';

	for (const model of models) {
		if (!model.id.trim()) {
			return 'Every model must have a Model ID.';
		}

		if (!model.label.trim()) {
			return `Model "${model.id}" must have a label.`;
		}

		if (!model.upstreamModel.trim()) {
			return `Model "${model.id}" must have an upstream model.`;
		}
	}

	if (claudeCliVersionMode === 'custom') {
		const customError = ClaudeCliVersion.validateCustomVersion(claudeCliVersionCustom);

		if (customError) {
			return customError;
		}
	}

	return null;
}

function toSavePayload(): Partial<AppSettings> {
	const parsedPort = parseInt(port, 10);
	const payload: Partial<AppSettings> = {
		port: parsedPort,
		quiet,
		apiKey: apiKey.trim(),
		extraInstruction: extraInstruction.trim() || null,
		claudeCliVersionMode,
		claudeCliVersionCustom: claudeCliVersionCustom.trim() || null,
		tunnelProtocol,
		models: cloneModels(models)
	};

	return payload;
}

export function getSettingsFormStore(): SettingsFormStore {
	const store: SettingsFormStore = {
		get port() {
			return port;
		},
		get apiKey() {
			return apiKey;
		},
		get quiet() {
			return quiet;
		},
		get extraInstruction() {
			return extraInstruction;
		},
		get models() {
			return models;
		},
		get modelsDirty() {
			return modelsFingerprint(models) !== savedModelsFingerprint;
		},
		get claudeCliVersionMode() {
			return claudeCliVersionMode;
		},
		get claudeCliVersionCustom() {
			return claudeCliVersionCustom;
		},
		get tunnelProtocol() {
			return tunnelProtocol;
		},
		setPort,
		setApiKey,
		setQuiet,
		setExtraInstruction,
		setModels,
		markModelsSaved,
		setClaudeCliVersionMode,
		setClaudeCliVersionCustom,
		setTunnelProtocol,
		syncFromAppSettings,
		validate,
		toSavePayload
	};

	return store;
}
