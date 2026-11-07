import { describe, expect, it } from 'vitest';

import { ChatToolCodec } from 'src/proxy/chat-tool-codec';

import type { OpenAIChatRequest } from 'src/types/openai';

const normalize = (tools: unknown[], extra = {}) =>
	ChatToolCodec.normalize({
		model: 'test',
		messages: [{ role: 'user', content: 'never rewrite Shell_custom text' }],
		tools,
		...extra
	} as OpenAIChatRequest);

const patchParameters = {
	type: 'object',
	properties: { patch: { type: 'string', description: 'The patch to apply to the file' } },
	required: ['patch']
};

describe('request-scoped custom tool codec', () => {
	it('unwraps only the ApplyPatch argument shape Cursor executes', () => {
		expect(ChatToolCodec.unwrapPatch('*** Begin Patch\n')).toBe('*** Begin Patch\n');
		expect(ChatToolCodec.unwrapPatch('{"patch":"*** Begin Patch\\n"}')).toBe('*** Begin Patch\n');
		for (const input of ['{}', '{"patch":1}', '{"patch":"a","extra":true}', '{"input":"a"}', 'raw']) {
			expect(ChatToolCodec.unwrapPatch(input)).toBe(input);
		}
	});

	it('keeps an unknown choice and drops tool types Cursor does not send', () => {
		const nested = { type: 'function', function: { name: 'Shell', parameters: { type: 'object' } } };
		const result = normalize([nested, { type: 'namespace', name: 'ns' }, { type: 'provider-defined', name: 'computer' }], {
			tool_choice: { type: 'custom', name: 'missing' }
		});
		expect(result.tools).toEqual([nested]);
		expect(result.tool_choice).toEqual({ type: 'custom', name: 'missing' });
		expect(result.messages[0].content).toBe('never rewrite Shell_custom text');
	});

	it('nests a flat function without rewriting its parameters', () => {
		const parameters = { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] };
		const result = normalize([{ type: 'function', name: 'Shell', description: 'Run', parameters, strict: true }]);
		expect(result.tools?.[0]).toEqual({
			type: 'function',
			function: { name: 'Shell', description: 'Run', parameters, strict: true }
		});
	});

	it('keeps simultaneous custom calls distinct', () => {
		const result = normalize([{ type: 'custom', name: 'Shell' }, { type: 'custom', name: 'Edit' }], {
			messages: [
				{
					role: 'assistant',
					content: null,
					tool_calls: [
						{ id: 'a', type: 'custom', name: 'Shell', input: 'one' },
						{ id: 'b', type: 'custom', name: 'Edit', input: 'two' }
					]
				}
			]
		});
		expect(result.messages[0].tool_calls?.map((call) => [call.id, call.function.arguments])).toEqual([
			['a', 'one'],
			['b', 'two']
		]);
	});

	it.each([
		{ type: 'custom', name: 'Shell' },
		{ type: 'custom', custom: { name: 'Shell' } }
	])('converts a schemaless custom declaration %j without inventing arguments', (tool) => {
		const result = normalize([tool]);
		expect(result.tools?.[0]).toEqual({ type: 'function', function: { name: 'Shell' } });
	});

	it.each(['raw\ninput', '{"already":"json"}', ''])('preserves raw custom history %j', (input) => {
		const result = normalize([{ type: 'custom', name: 'Shell' }], {
			messages: [
				{ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'custom', custom: { name: 'Shell', input } }] },
				{ role: 'tool', tool_call_id: 'c1', content: 'result unchanged' }
			],
			tool_choice: { type: 'custom', custom: { name: 'Shell' } }
		});
		expect(result.messages[0].tool_calls?.[0].function.arguments).toBe(input);
		expect(result.messages[1]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'result unchanged' });
		expect(result.tool_choice).toEqual({ type: 'function', function: { name: 'Shell' } });
	});

	it('uses a custom tool schema when Cursor sent one', () => {
		const parameters = { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] };
		const result = normalize([{ type: 'custom', name: 'Shell', parameters }], {
			messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'custom', name: 'Shell', input: 'ls' }] }]
		});
		expect(result.tools?.[0].function.parameters).toEqual(parameters);
		expect(result.messages[0].tool_calls?.[0].function.arguments).toBe('{"command":"ls"}');
	});

	it('accepts Cursor grammar ApplyPatch as the local patch function', () => {
		const grammar = `start: begin_patch hunk end_patch\n${'hunk '.repeat(40)}`;
		const result = normalize(
			[
				{
					type: 'custom',
					name: 'ApplyPatch',
					description: 'Applies a patch',
					format: { type: 'grammar', syntax: 'lark', definition: grammar }
				}
			],
			{
				messages: [
					{
						role: 'assistant',
						content: null,
						tool_calls: [{ id: 'p1', type: 'custom', name: 'ApplyPatch', input: '*** Begin Patch\n' }]
					}
				],
				tool_choice: { type: 'custom', name: 'ApplyPatch' }
			}
		);
		expect(result.tools?.[0]).toEqual({
			type: 'function',
			function: { name: 'ApplyPatch', description: 'Applies a patch', parameters: patchParameters }
		});
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain(grammar);
		expect(serialized).not.toContain('lark');
		expect(ChatToolCodec.unwrapPatch(result.messages[0].tool_calls![0].function.arguments)).toBe('*** Begin Patch\n');
		expect(result.tool_choice).toEqual({ type: 'function', function: { name: 'ApplyPatch' } });
	});

	it('accepts the agent-runtime customToolFormat field the same way', () => {
		const result = normalize([
			{ type: 'custom', name: 'ApplyPatch', customToolFormat: { type: 'grammar', definition: 'secret grammar' } }
		]);
		expect(result.tools?.[0].function.parameters).toEqual(patchParameters);
		expect(JSON.stringify(result)).not.toContain('secret grammar');
	});

	it('preserves Responses history call ids and output text', () => {
		const result = normalize([{ type: 'custom', name: 'ApplyPatch' }], {
			input: [
				{ type: 'custom_tool_call', name: 'ApplyPatch', call_id: 'c1', input: '*** Begin Patch\n' },
				{ type: 'custom_tool_call_output', call_id: 'c1', output: 'Shell text' }
			]
		});
		expect(result.input).toEqual([
			{ type: 'function_call', name: 'ApplyPatch', call_id: 'c1', arguments: '{"patch":"*** Begin Patch\\n"}' },
			{ type: 'custom_tool_call_output', call_id: 'c1', output: 'Shell text' }
		]);
	});
});
