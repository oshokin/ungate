import { normalizeProviderHeaderTimeoutMs } from '@ungate/shared';
import * as vscode from 'vscode';

/** Captured only when spawning, never when attaching to an existing shared API. */
export function providerHeaderTimeoutEnvironment(
	inherited: NodeJS.ProcessEnv = process.env
): Pick<NodeJS.ProcessEnv, 'UPSTREAM_HEADER_TIMEOUT_MS'> {
	// Explicit environment wins even when invalid: the API validates it and falls back to 30s.
	if (inherited.UPSTREAM_HEADER_TIMEOUT_MS !== undefined) {
		return { UPSTREAM_HEADER_TIMEOUT_MS: inherited.UPSTREAM_HEADER_TIMEOUT_MS };
	}
	const setting = vscode.workspace.getConfiguration('ungate', null).inspect<unknown>('network.providerHeaderTimeoutSeconds');

	// Machine setting: deliberately ignore workspace/folder values, including malformed callers.
	return {
		UPSTREAM_HEADER_TIMEOUT_MS: String(normalizeProviderHeaderTimeoutMs(setting?.globalValue ?? setting?.defaultValue))
	};
}
