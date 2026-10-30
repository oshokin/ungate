import type { ModelMappingProvider } from '@ungate/shared/frontend';

export type DashboardPage = 'usage' | 'settings' | 'logs';
export type LogSource = 'api' | 'tunnel';

interface WebviewState {
	currentPage?: DashboardPage;
	scrollPositions?: Partial<Record<DashboardPage, number>>;
	logPanelHeights?: Partial<Record<LogSource, number>>;
	selectedSettingsProvider?: ModelMappingProvider;
	selectedSettingsModelIds?: Partial<Record<ModelMappingProvider, string>>;
}

interface VsCodeApi {
	postMessage(message: unknown): void;
	getState(): unknown;
	setState(state: WebviewState): void;
}

// acquireVsCodeApi() may only be called once — singleton
const vscodeApi = (
	window as Window & {
		acquireVsCodeApi?: () => VsCodeApi;
	}
).acquireVsCodeApi?.();

const dashboardPages: DashboardPage[] = ['usage', 'settings', 'logs'];
const modelMappingProviders: ModelMappingProvider[] = ['claude', 'minimax', 'openai'];

function readWebviewState(): WebviewState {
	const state = vscodeApi?.getState();

	if (!state || typeof state !== 'object') {
		return {};
	}

	return state;
}

function updateWebviewState(update: Partial<WebviewState>): void {
	vscodeApi?.setState({ ...readWebviewState(), ...update });
}

export function postExtensionMessage(message: { type: string; [key: string]: unknown }): boolean {
	if (!vscodeApi) return false;
	vscodeApi.postMessage(message);

	return true;
}

export function getSavedPage(): DashboardPage {
	const page = readWebviewState().currentPage;

	return page && dashboardPages.includes(page) ? page : 'settings';
}

export function savePage(currentPage: DashboardPage): void {
	updateWebviewState({ currentPage });
}

export function getSavedScrollPosition(page: DashboardPage): number {
	const scrollPosition = readWebviewState().scrollPositions?.[page];

	return typeof scrollPosition === 'number' && Number.isFinite(scrollPosition) && scrollPosition >= 0 ? scrollPosition : 0;
}

export function saveScrollPosition(page: DashboardPage, scrollPosition: number): void {
	const scrollPositions = {
		...readWebviewState().scrollPositions,
		[page]: Math.max(0, scrollPosition)
	};

	updateWebviewState({ scrollPositions });
}

export function getSavedLogPanelHeight(source: LogSource, fallback: number): number {
	const height = readWebviewState().logPanelHeights?.[source];

	return typeof height === 'number' && Number.isFinite(height) ? height : fallback;
}

export function saveLogPanelHeight(source: LogSource, height: number): void {
	const logPanelHeights = {
		...readWebviewState().logPanelHeights,
		[source]: height
	};

	updateWebviewState({ logPanelHeights });
}

export function getSavedSettingsProvider(): ModelMappingProvider {
	const provider = readWebviewState().selectedSettingsProvider;

	return provider && modelMappingProviders.includes(provider) ? provider : 'claude';
}

export function saveSettingsProvider(selectedSettingsProvider: ModelMappingProvider): void {
	updateWebviewState({ selectedSettingsProvider });
}

export function getSavedSettingsModelId(provider: ModelMappingProvider): string | null {
	const modelId = readWebviewState().selectedSettingsModelIds?.[provider];

	return typeof modelId === 'string' && modelId ? modelId : null;
}

export function saveSettingsModelId(provider: ModelMappingProvider, modelId: string): void {
	const selectedSettingsModelIds = {
		...readWebviewState().selectedSettingsModelIds,
		[provider]: modelId
	};

	updateWebviewState({ selectedSettingsModelIds });
}
