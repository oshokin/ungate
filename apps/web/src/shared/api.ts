import { DashboardClient } from './dashboard-client';

import type { AppSettings, ModelDiscoveryResponse, ModelMappingProvider, SubscriptionUsage } from '@ungate/shared/frontend';

export class Api {
	private static get<T>(path: string): Promise<T> {
		return DashboardClient.request('GET', path);
	}

	private static post<T>(path: string, body?: unknown): Promise<T> {
		return DashboardClient.request('POST', path, body);
	}

	static fetchUsage(refresh = false): Promise<SubscriptionUsage> {
		return refresh ? this.post('/usage/refresh') : this.get('/usage');
	}

	static fetchSettings(): Promise<AppSettings> {
		return this.get('/settings');
	}

	static updateSettings(settings: Partial<AppSettings>): Promise<{ ok: boolean }> {
		return this.post('/settings', settings);
	}

	static discoverModels(provider: ModelMappingProvider): Promise<ModelDiscoveryResponse> {
		return this.post('/models/discover', { provider });
	}

	static authStart(): Promise<{ authUrl: string; sessionId: string }> {
		return this.post('/auth/claude/start');
	}

	static authComplete(code: string, sessionId: string): Promise<{ ok: boolean; email?: string; error?: string }> {
		return this.post('/auth/claude/complete', { code, sessionId });
	}

	static authStatus(): Promise<{ authenticated: boolean; email?: string }> {
		return this.get('/auth/claude/status');
	}

	static authLogout(): Promise<{ ok: boolean }> {
		return this.post('/auth/claude/logout');
	}

	static authMinimaxStatus(): Promise<{ authenticated: boolean; baseUrl?: string }> {
		return this.get('/auth/minimax/status');
	}

	static authMinimaxLogin(apiKey: string, baseUrl: string): Promise<{ ok: boolean; error?: string }> {
		return this.post('/auth/minimax/login', { apiKey, baseUrl });
	}

	static authMinimaxUpdateBaseUrl(baseUrl: string): Promise<{ ok: boolean; error?: string }> {
		return this.post('/auth/minimax/base-url', { baseUrl });
	}

	static authMinimaxLogout(): Promise<{ ok: boolean }> {
		return this.post('/auth/minimax/logout');
	}

	static authChatGPTStart(): Promise<{ authUrl: string; sessionId: string }> {
		return this.get('/auth/openai/start');
	}

	static authChatGPTStatus(): Promise<{ authenticated: boolean; email?: string }> {
		return this.get('/auth/openai/status');
	}

	static authChatGPTLogout(): Promise<{ ok: boolean }> {
		return this.post('/auth/openai/logout');
	}

	static async healthPid(): Promise<number | null> {
		try {
			const health = await this.get<{ service?: string; pid?: number }>('/health');

			return health.service === 'ungate' ? (health.pid ?? null) : null;
		} catch {
			return null;
		}
	}

	static async healthCheck(): Promise<boolean> {
		return (await this.healthPid()) !== null;
	}
}
