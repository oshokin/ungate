import * as vscode from 'vscode';

const preferences = {
	'logs.maxEntries': { min: 100, max: 5000, fallback: 500 },
	'tunnel.connectTimeoutSeconds': { min: 15, max: 120, fallback: 45 },
	'network.providerHeaderTimeoutSeconds': { min: 5, max: 120, fallback: 30 }
} as const;

export function readDashboardPreferences(): Record<string, number> {
	const configuration = vscode.workspace.getConfiguration('ungate');

	return Object.fromEntries(
		Object.entries(preferences).map(([key, bounds]) => {
			const value = configuration.inspect<number>(key)?.globalValue;

			return [
				key,
				typeof value === 'number' && Number.isInteger(value) && value >= bounds.min && value <= bounds.max
					? value
					: bounds.fallback
			];
		})
	);
}

export async function writeDashboardPreference(message: unknown): Promise<boolean> {
	if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'set-dashboard-preference')
		return false;
	if (!('key' in message) || typeof message.key !== 'string' || !Object.hasOwn(preferences, message.key))
		throw new Error('Unknown preference.');
	const key = message.key as keyof typeof preferences;
	const bounds = preferences[key];
	if (
		!('value' in message) ||
		typeof message.value !== 'number' ||
		!Number.isInteger(message.value) ||
		message.value < bounds.min ||
		message.value > bounds.max
	)
		throw new Error(`Enter ${bounds.min}–${bounds.max}.`);
	await vscode.workspace.getConfiguration('ungate').update(key, message.value, vscode.ConfigurationTarget.Global);

	return true;
}
