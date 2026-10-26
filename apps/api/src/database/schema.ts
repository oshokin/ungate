import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const appSettings = sqliteTable('app_settings', {
	id: integer()
		.primaryKey({ autoIncrement: false })
		.$defaultFn(() => 1),
	port: integer().notNull().default(47821),
	apiKey: text(),
	quiet: integer({ mode: 'boolean' }).notNull().default(false),
	extraInstruction: text(),
	claudeCliVersionMode: text().notNull().default('stable'),
	claudeCliVersionCustom: text(),
	tunnelProtocol: text().notNull().default('http2')
});

export const providerSettings = sqliteTable('provider_settings', {
	provider: text().primaryKey(),
	accessToken: text().notNull(),
	refreshToken: text(),
	expiresAt: integer(),
	email: text(),
	accountId: text(),
	createdAt: integer().notNull(),
	baseUrl: text()
});

export const modelMappings = sqliteTable('model_mappings', {
	id: text().primaryKey(),
	label: text().notNull(),
	provider: text().notNull(),
	upstreamModel: text().notNull(),
	sortOrder: integer().notNull().default(0),
	reasoningBudget: text(),
	serviceTier: text()
});

export const schema = { appSettings, providerSettings, modelMappings };
