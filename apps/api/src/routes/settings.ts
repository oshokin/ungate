import { z } from 'zod';

import {
	ClaudeCliVersion,
	TCP_PORT_MAX,
	TCP_PORT_MIN,
	TUNNEL_PROTOCOLS,
	isClaudeCliVersionMode,
	isModelMappingProvider,
	isModelServiceTier,
	isReasoningBudgetTier,
	type AppSettings
} from '@ungate/shared';
import { logger } from 'src/utils/logger';

import { Settings } from '../database/app-settings';

import type { FastifyPluginCallback } from 'fastify';

const TokenLimitSchema = z.union([z.null(), z.number().int().positive()]);

const ModelMappingUpdateSchema = z
	.object({
		id: z.string().trim().min(1),
		label: z.string().trim().min(1),
		provider: z.string().refine((value) => isModelMappingProvider(value), {
			message: 'Model provider must be claude, openai or minimax'
		}),
		upstreamModel: z.string().trim().min(1),
		sortOrder: z.number().int(),
		reasoningBudget: z.union([
			z.null(),
			z.string().refine((value) => isReasoningBudgetTier(value), { message: 'Invalid reasoningBudget' })
		]),
		serviceTier: z
			.union([z.null(), z.string().refine((value) => isModelServiceTier(value), { message: 'Invalid serviceTier' })])
			.default(null),
		contextWindow: TokenLimitSchema.default(null),
		maxOutputTokens: TokenLimitSchema.default(null)
	})
	.strip();

const SettingsUpdateSchema = z
	.object({
		port: z.number().int().min(TCP_PORT_MIN).max(TCP_PORT_MAX).optional(),
		apiKey: z.string().trim().min(1, 'Ungate API key cannot be empty').optional(),
		quiet: z.boolean().optional(),
		extraInstruction: z.union([z.string(), z.null()]).optional(),
		claudeCliVersionMode: z
			.string()
			.refine((value) => isClaudeCliVersionMode(value), { message: 'claudeCliVersionMode must be stable, latest, or custom' })
			.optional(),
		claudeCliVersionCustom: z.union([z.string(), z.null()]).optional(),
		tunnelProtocol: z.enum(TUNNEL_PROTOCOLS).optional(),
		models: z
			.array(ModelMappingUpdateSchema)
			.refine((models) => new Set(models.map((model) => model.id.toLowerCase())).size === models.length, {
				message: 'Model IDs must be unique (case-insensitive)'
			})
			.optional()
	})
	.strip();

function validateSettingsUpdate(payload: unknown): { ok: true; value: Partial<AppSettings> } | { ok: false; error: string } {
	const result = SettingsUpdateSchema.safeParse(payload);

	if (!result.success) {
		const issue = result.error.issues[0];
		const path = issue.path.length ? ` at ${issue.path.join('.')}` : '';

		return { ok: false, error: `${issue.message}${path}` };
	}

	const value: Partial<AppSettings> = result.data;

	if (value.claudeCliVersionMode === 'custom') {
		const rawCustom = value.claudeCliVersionCustom ?? '';
		const customError = ClaudeCliVersion.validateCustomVersion(rawCustom);

		if (customError) {
			const errorResult: { ok: false; error: string } = { ok: false, error: customError };

			return errorResult;
		}

		value.claudeCliVersionCustom = rawCustom.trim();
	}

	const successResult: { ok: true; value: Partial<AppSettings> } = { ok: true, value };

	return successResult;
}

const plugin: FastifyPluginCallback = (app) => {
	app.get('/settings', async (_request, reply) => {
		const settings = Settings.get();

		return reply.send(settings);
	});

	app.post('/settings', async (request, reply) => {
		const validation = validateSettingsUpdate(request.body);

		if (!validation.ok) {
			logger.error(`Settings update failed: ${validation.error}`);

			return reply.code(400).send({ ok: false, error: validation.error });
		}

		Settings.update(validation.value);
		// Key changes take effect immediately, rather than silently using the old key until restart.
		if (validation.value.apiKey !== undefined) app.config.apiKey = validation.value.apiKey ?? undefined;

		return reply.send({ ok: true });
	});
};

export default plugin;
