import { afterEach, describe, expect, it, vi } from "vitest";

import healthPlugin from "src/routes/health";
import modelsPlugin from "src/routes/models";
import settingsPlugin from "src/routes/settings";

import { withPlugin } from "../test-harness";

const settingsGetMock = vi.fn();
const settingsUpdateMock = vi.fn();

vi.mock("src/database/app-settings", () => ({
	Settings: {
		get: (...args: unknown[]) => settingsGetMock(...args),
		update: (...args: unknown[]) => settingsUpdateMock(...args),
	},
}));

describe("routes: health/settings/models", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("health returns ok", async () => {
		const app = await withPlugin(healthPlugin);
		const response = await app.inject({ method: "GET", url: "/health" });
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ status: "ok", service: "ungate" });
		const adminResponse = await app.inject({ method: "GET", url: "/admin/health" });
		expect(adminResponse.statusCode).toBe(200);
		expect(adminResponse.json()).toEqual({
			status: "ok",
			service: "ungate",
			pid: process.pid,
			version: "1.7.14",
			protocolVersion: 3,
		});
		await app.close();
	});

	it("strips unknown fields from model payload and saves successfully", async () => {
		settingsUpdateMock.mockReturnValueOnce(undefined);

		const app = await withPlugin(settingsPlugin);
		const res = await app.inject({
			method: "POST",
			url: "/settings",
			payload: {
				models: [
					{
						id: "test-model",
						label: "Test Model",
						provider: "claude",
						upstreamModel: "claude-test-model",
						sortOrder: 0,
						reasoningBudget: null,
						serviceTier: null,
						enabled: true,
					},
				],
			},
		});
		expect(res.statusCode).toBe(200);
		expect(settingsUpdateMock).toHaveBeenCalledWith({
			models: [
				{
					id: "test-model",
					label: "Test Model",
					provider: "claude",
					upstreamModel: "claude-test-model",
					sortOrder: 0,
					reasoningBudget: null,
					serviceTier: null,
				},
			],
		});
		await app.close();
	});

	it("settings get and post delegate to Settings", async () => {
		settingsGetMock.mockReturnValueOnce({
			port: 4783,
			apiKey: "k",
			quiet: false,
			extraInstruction: "",
			claudeCliVersionMode: "stable",
			claudeCliVersionCustom: null,
			tunnelProtocol: 'http2',
			models: [],
		});

		const app = await withPlugin(settingsPlugin);
		const getRes = await app.inject({ method: "GET", url: "/settings" });
		expect(getRes.statusCode).toBe(200);
		expect(getRes.json().port).toBe(4783);

		const postRes = await app.inject({
			method: "POST",
			url: "/settings",
			payload: { quiet: true },
		});
		expect(postRes.statusCode).toBe(200);
		expect(postRes.json()).toEqual({ ok: true });
		expect(settingsUpdateMock).toHaveBeenCalledWith({ quiet: true });

		const invalid = await app.inject({
			method: 'POST',
			url: '/settings',
			payload: { tunnelProtocol: 'udp' }
		});
		expect(invalid.statusCode).toBe(400);
		await app.close();
	});

	it("models returns all mappings", async () => {
		settingsGetMock.mockReturnValueOnce({
			models: [
				{ id: "m1", provider: "claude" },
				{ id: "m2", provider: "openai" },
			],
		});

		const app = await withPlugin(modelsPlugin, { apiKey: "test-proxy" });
		const response = await app.inject({
			method: "GET",
			url: "/v1/models",
			headers: { authorization: "Bearer test-proxy" },
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			object: "list",
			data: [
				{ id: "m1", object: "model", created: 1700000000, owned_by: "claude" },
				{ id: "m2", object: "model", created: 1700000000, owned_by: "openai" },
			],
		});
		await app.close();
	});

	it("rejects unauthenticated model requests", async () => {
		settingsGetMock.mockReturnValue({ models: [] });
		const app = await withPlugin(modelsPlugin, { apiKey: "model-key" });

		expect((await app.inject("/v1/models")).statusCode).toBe(403);
		expect((await app.inject({
			url: "/v1/models",
			headers: { authorization: "Bearer model-key" }
		})).statusCode).toBe(200);
		await app.close();
	});
});
