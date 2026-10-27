const string = { type: 'string', minLength: 1, maxLength: 1_000_000 } as const;
const object = { type: 'object', maxProperties: 128 } as const;

export const openAiChatRequestSchema = {
	body: {
		type: 'object',
		required: ['model', 'messages'],
		additionalProperties: true,
		maxProperties: 32,
		properties: {
			model: { type: 'string', minLength: 1, maxLength: 256 },
			messages: {
				type: 'array',
				minItems: 1,
				maxItems: 1024,
				items: {
					type: 'object',
					required: ['role'],
					maxProperties: 16,
					properties: { role: { type: 'string', maxLength: 32 }, content: {} }
				}
			},
			tools: { type: 'array', maxItems: 256, items: object },
			stop: { anyOf: [string, { type: 'array', maxItems: 16, items: string }] },
			stream: { type: 'boolean' }
		}
	}
} as const;

export const anthropicRequestSchema = {
	body: {
		type: 'object',
		required: ['model', 'max_tokens', 'messages'],
		additionalProperties: true,
		maxProperties: 32,
		properties: {
			model: { type: 'string', minLength: 1, maxLength: 256 },
			max_tokens: { type: 'integer', minimum: 1, maximum: 1_000_000 },
			messages: {
				type: 'array',
				minItems: 1,
				maxItems: 1024,
				items: {
					type: 'object',
					required: ['role', 'content'],
					maxProperties: 16,
					properties: { role: { enum: ['user', 'assistant'] }, content: {} }
				}
			},
			tools: { type: 'array', maxItems: 256, items: object },
			stop_sequences: { type: 'array', maxItems: 16, items: string },
			stream: { type: 'boolean' }
		}
	}
} as const;
