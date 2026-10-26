export type CodexReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | 'persistent';

export interface ResolvedChatGptModel {
	model: string;
	reasoningEffort?: CodexReasoningEffort;
}

export interface BuildResponsesBodyOptions {
	extraInstruction?: string;
	envInstructions?: string;
	instructionsFallback: string;
}

export interface BuildResponsesBodyResult {
	payload: Record<string, unknown>;
	debug: {
		chatMessages: number;
		inputField: number;
		codexItems: number;
		fromBodyInput: boolean;
	};
}
