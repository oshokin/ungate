/* eslint-disable @typescript-eslint/unbound-method -- mocked static API methods */
import { beforeEach, expect, it, vi } from 'vitest';

import type { AppSettings, ModelMappingConfig } from '@ungate/shared/frontend';

vi.mock('$shared/api', () => ({ Api: { discoverModels: vi.fn(), updateSettings: vi.fn() } }));

const model = {
	id: 'test',
	label: 'Test',
	provider: 'claude',
	upstreamModel: 'test',
	reasoningBudget: null
} as ModelMappingConfig;

beforeEach(() => {
	vi.resetModules();
	vi.stubGlobal('$state', (value: unknown) => value);
});

async function form() {
	const { getSettingsFormStore } = await import('../src/features/settings/settings-form-store.svelte');
	const store = getSettingsFormStore();
	store.syncFromAppSettings({ port: 3000, apiKey: 'key', models: [model] } as AppSettings);

	return store;
}

it('rejects partial, fractional and out-of-range ports', async () => {
	const store = await form();
	for (const port of ['3000junk', '3000.5', '3e3', '', ' 3000', '0', '65536']) {
		store.setPort(port);
		expect(store.validate()).toContain('Port must');
	}
	for (const port of ['1024', '65535']) {
		store.setPort(port);
		expect(store.validate()).toBeNull();
	}
});

it('rejects whitespace IDs and normalized duplicate IDs', async () => {
	const store = await form();
	store.setModels([{ ...model, id: ' test ' }]);
	expect(store.validate()).toContain('whitespace');
	store.setModels([model, { ...model, id: 'TEST' }]);
	expect(store.validate()).toContain('unique');
});

it('keeps edits made during discovery persistence dirty', async () => {
	const store = await form();
	const { Api } = await import('../src/shared/api');
	const { getModelDiscoveryStore } = await import('../src/features/settings/model-discovery-store.svelte');
	vi.mocked(Api.discoverModels).mockResolvedValue({
		provider: 'claude',
		status: 'ok',
		message: null,
		models: [{ id: 'new', label: 'New', upstreamModel: 'new' }]
	} as never);
	let release!: () => void;
	vi.mocked(Api.updateSettings).mockImplementation(
		() =>
			new Promise<{ ok: boolean }>((resolve) => {
				release = () => resolve({ ok: true });
			})
	);
	const pending = getModelDiscoveryStore().syncAfterConnection('claude');
	await vi.waitFor(() => expect(Api.updateSettings).toHaveBeenCalledOnce());
	const snapshot = vi.mocked(Api.updateSettings).mock.calls[0][0].models!;
	store.models[0].label = 'Edited during request';
	expect(snapshot[0].label).toBe('Test');
	release();
	await pending;
	expect(store.modelsDirty).toBe(true);
	store.setModels(snapshot);
	expect(store.modelsDirty).toBe(false);
});

it('captures queued discovery payloads before later edits', async () => {
	const store = await form();
	const { Api } = await import('../src/shared/api');
	const { getModelDiscoveryStore } = await import('../src/features/settings/model-discovery-store.svelte');
	vi.mocked(Api.discoverModels).mockResolvedValue({
		provider: 'claude',
		status: 'ok',
		message: null,
		models: [{ id: 'new', label: 'New', upstreamModel: 'new' }]
	} as never);
	const releases: (() => void)[] = [];
	vi.mocked(Api.updateSettings).mockImplementation(
		() =>
			new Promise<{ ok: boolean }>((resolve) => {
				releases.push(() => resolve({ ok: true }));
			})
	);
	const discovery = getModelDiscoveryStore();
	const first = discovery.syncAfterConnection('claude');
	await vi.waitFor(() => expect(releases).toHaveLength(1));
	// Simulate another clean provider connection while the first write is delayed.
	store.markModelsSaved();
	vi.mocked(Api.discoverModels).mockResolvedValue({
		provider: 'openai',
		status: 'ok',
		message: null,
		models: [{ id: 'queued', label: 'Queued', upstreamModel: 'queued' }]
	} as never);
	const second = discovery.syncAfterConnection('openai');
	await vi.waitFor(() => expect(discovery.state('openai').loading).toBe(false));
	store.models[0].label = 'Later edit';
	releases[0]();
	await first;
	await vi.waitFor(() => expect(releases).toHaveLength(2));
	const persisted = vi.mocked(Api.updateSettings).mock.calls[1][0].models!;
	expect(persisted[0].label).toBe('Test');
	releases[1]();
	await second;
	expect(store.modelsDirty).toBe(true);
});

it('preserves edits when the page synchronizes a completed save snapshot', async () => {
	const store = await form();
	const payload = store.toSavePayload();
	store.models[0].label = 'Edited while saving';
	// The SettingsPage effect can run before or after the save continuation.
	store.syncFromAppSettings(payload as AppSettings);
	store.markModelsSaved(payload.models);
	expect(store.models[0].label).toBe('Edited while saving');
	expect(store.modelsDirty).toBe(true);
	store.syncFromAppSettings(payload as AppSettings);
	expect(store.models[0].label).toBe('Edited while saving');
	expect(store.modelsDirty).toBe(true);
});

it('does not autosave edits made while discovery is pending', async () => {
	const store = await form();
	const { Api } = await import('../src/shared/api');
	const { getModelDiscoveryStore } = await import('../src/features/settings/model-discovery-store.svelte');
	let release!: (response: Awaited<ReturnType<typeof Api.discoverModels>>) => void;
	vi.mocked(Api.discoverModels).mockImplementation(
		() =>
			new Promise((resolve) => {
				release = resolve;
			})
	);
	const pending = getModelDiscoveryStore().syncAfterConnection('claude');
	store.models[0].label = 'Edited while discovering';
	release({
		provider: 'claude',
		status: 'ok',
		message: null,
		models: [{ id: 'new', label: 'New', upstreamModel: 'new' }]
	} as never);
	await pending;
	expect(Api.updateSettings).not.toHaveBeenCalled();
	expect(store.models[0].label).toBe('Edited while discovering');
	expect(store.modelsDirty).toBe(true);
});
