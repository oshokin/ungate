import type { OpenAIChatRequest, OpenAITool } from '../types/openai';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined =>
	value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : undefined;

/**
 * Cursor 3.29.9 defines ApplyPatch as `{ patch: string }` and unwraps a tool
 * argument only when it is raw text or exactly that one property. The grammar
 * is a client-side constraint and is not part of the chat function schema.
 */
const applyPatchParameters = (): Record<string, unknown> => ({
	type: 'object',
	properties: { patch: { type: 'string', description: 'The patch to apply to the file' } },
	required: ['patch']
});

const singleStringKey = (parameters: unknown): string | undefined => {
	const schema = record(parameters);
	const properties = record(schema?.properties);
	const required = schema?.required;
	if (!properties || !Array.isArray(required) || required.length !== 1 || typeof required[0] !== 'string') return undefined;
	if (record(properties[required[0]])?.type !== 'string') return undefined;

	return required[0];
};

const functionFields = (definition: RecordValue): Record<string, unknown> => ({
	name: definition.name,
	...(typeof definition.description === 'string' ? { description: definition.description } : {}),
	...(definition.parameters !== undefined ? { parameters: definition.parameters } : {}),
	...(definition.strict !== undefined ? { strict: definition.strict } : {})
});

/**
 * Request-local view of Cursor's chat tool payload.
 * Function tools stay function tools. The one local custom tool, ApplyPatch,
 * becomes the same `{patch: string}` function Cursor executes. Nothing else
 * aborts the chat.
 */
export class ChatToolCodec {
	/** Same acceptance rule as Cursor's ApplyPatch executor. Other JSON is left unchanged. */
	static unwrapPatch(argumentsText: string): string {
		const trimmed = argumentsText.trim();
		if (!trimmed.startsWith('{')) return argumentsText;
		let parsed: unknown;
		try {
			parsed = JSON.parse(argumentsText);
		} catch {
			return argumentsText;
		}
		const value = record(parsed);
		if (!value) return argumentsText;
		const keys = Object.keys(value);
		if (keys.length === 1 && keys[0] === 'patch' && typeof value.patch === 'string') return value.patch;

		return argumentsText;
	}

	static normalize(body: OpenAIChatRequest): OpenAIChatRequest {
		const names = new Set<string>();
		const customArguments = new Map<string, string | undefined>();
		const tools = body.tools?.flatMap((value) => {
			const tool = record(value);
			if (!tool || (tool.type !== 'function' && tool.type !== 'custom')) return [];
			const nested = record(tool[tool.type as string]);
			const definition = nested ?? tool;
			const name = definition.name;
			if (typeof name !== 'string' || name.length === 0) return [];
			names.add(name);
			if (tool.type === 'function') {
				return nested ? value : { type: 'function', function: functionFields(definition) };
			}
			const parameters =
				definition.parameters !== undefined ? definition.parameters : name === 'ApplyPatch' ? applyPatchParameters() : undefined;
			customArguments.set(name, singleStringKey(parameters));

			return {
				type: 'function',
				function: {
					name,
					...(typeof definition.description === 'string' ? { description: definition.description } : {}),
					...(parameters !== undefined ? { parameters } : {})
				}
			};
		});
		const choice = record(body.tool_choice);
		let toolChoice = body.tool_choice;
		if (choice && (choice.type === 'function' || choice.type === 'custom')) {
			const definition = record(choice[choice.type as string]) ?? choice;
			if (typeof definition.name === 'string' && names.has(definition.name)) {
				toolChoice = { type: 'function', function: { name: definition.name } };
			}
		}
		const argumentsFor = (name: string, input: string): string => {
			const key = customArguments.get(name);
			if (key === undefined) return input;

			return JSON.stringify({ [key]: input });
		};
		const messages = body.messages.map((message) => {
			if (!Array.isArray(message.tool_calls)) return message;

			return {
				...message,
				tool_calls: message.tool_calls.map((value) => {
					const call = value as unknown as RecordValue;
					if (call.type !== 'custom') return value;
					const definition = record(call.custom) ?? call;
					const name = definition.name;
					if (typeof name !== 'string' || !customArguments.has(name) || typeof definition.input !== 'string') return value;

					return { id: value.id, type: 'function' as const, function: { name, arguments: argumentsFor(name, definition.input) } };
				})
			};
		});
		const input = Array.isArray(body.input)
			? body.input.map((value: unknown) => {
					const item = record(value);
					if (item?.type !== 'custom_tool_call') return value;
					const name = item.name;
					if (typeof name !== 'string' || !customArguments.has(name) || typeof item.input !== 'string') return value;
					const { input: rawInput, ...rest } = item;

					return { ...rest, type: 'function_call', arguments: argumentsFor(name, rawInput) };
				})
			: body.input;

		return { ...body, tools: tools as OpenAITool[] | undefined, tool_choice: toolChoice, messages, input };
	}
}
