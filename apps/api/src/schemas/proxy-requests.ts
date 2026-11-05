const string = { type: 'string', minLength: 1, maxLength: 1_000_000 } as const;

/** Own properties on one tool definition. Nested parameter schemas are separate objects. */
const MAX_TOOL_PROPERTIES = 128;
const object = { type: 'object', maxProperties: MAX_TOOL_PROPERTIES } as const;

/** Top-level chat fields Cursor may add without a schema change here. */
const MAX_REQUEST_PROPERTIES = 32;
/** OpenAI role strings such as system, user, assistant, and tool. */
const MAX_ROLE_CHARS = 32;
/** Fields on one chat message, including tool call metadata. */
const MAX_MESSAGE_PROPERTIES = 16;
/** Model id and display label length accepted from discovery and chat requests. */
export const MAX_MODEL_ID_CHARS = 256;
/** Tool definitions accepted on one chat request. */
const MAX_TOOLS = 256;
/** Stop sequences accepted on one chat request. */
const MAX_STOP_SEQUENCES = 16;
/** Client-supplied prompt-cache routing hint. This is not a model id. */
const MAX_PROMPT_CACHE_KEY_CHARS = 256;

/**
 * Cursor resends the whole agent transcript on every turn. A long tool loop
 * reaches 1024 messages, and the follow-up must still be accepted. The 32 MiB
 * body limit remains the size bound.
 */
export const MAX_CHAT_MESSAGES = 8192;

export const openAiChatRequestSchema = {
	body: {
		type: 'object',
		required: ['model', 'messages'],
		additionalProperties: true,
		maxProperties: MAX_REQUEST_PROPERTIES,
		properties: {
			model: { type: 'string', minLength: 1, maxLength: MAX_MODEL_ID_CHARS },
			messages: {
				type: 'array',
				minItems: 1,
				maxItems: MAX_CHAT_MESSAGES,
				items: {
					type: 'object',
					required: ['role'],
					maxProperties: MAX_MESSAGE_PROPERTIES,
					properties: { role: { type: 'string', maxLength: MAX_ROLE_CHARS }, content: {} }
				}
			},
			tools: { type: 'array', maxItems: MAX_TOOLS, items: object },
			stop: { anyOf: [string, { type: 'array', maxItems: MAX_STOP_SEQUENCES, items: string }] },
			prompt_cache_key: { type: 'string', minLength: 1, maxLength: MAX_PROMPT_CACHE_KEY_CHARS },
			stream: { type: 'boolean' }
		}
	}
} as const;

export const anthropicRequestSchema = {
	body: {
		type: 'object',
		required: ['model', 'max_tokens', 'messages'],
		additionalProperties: true,
		maxProperties: MAX_REQUEST_PROPERTIES,
		properties: {
			model: { type: 'string', minLength: 1, maxLength: MAX_MODEL_ID_CHARS },
			max_tokens: { type: 'integer', minimum: 1, maximum: 1_000_000 },
			messages: {
				type: 'array',
				minItems: 1,
				maxItems: MAX_CHAT_MESSAGES,
				items: {
					type: 'object',
					required: ['role', 'content'],
					maxProperties: MAX_MESSAGE_PROPERTIES,
					properties: { role: { enum: ['user', 'assistant'] }, content: {} }
				}
			},
			tools: { type: 'array', maxItems: MAX_TOOLS, items: object },
			stop_sequences: { type: 'array', maxItems: MAX_STOP_SEQUENCES, items: string },
			stream: { type: 'boolean' }
		}
	}
} as const;
