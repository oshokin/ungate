# Cursor compatibility evidence (2026-11-07)

Target: installed Cursor 3.29.9, commit
`306d153d51d714882ab7b1bc49649cab624e8a30`.
Evidence is compiled client code, not Cursor's remote backend or a live native-chat capture.

## Installed-client observations

Inspected `/usr/share/cursor/resources/app/`:

- `extensions/cursor-local-agent-runtime/dist/main.js`: `G3e` honors an explicit
  endpoint; otherwise `gpt-5*` selects Responses only on `api.openai.com`,
  and names containing `codex` select Responses regardless of host.
  Other names select Chat Completions. This does not prove backend routing.
- In the same bundle, `LWe` requires a recognized nonempty `api_types`;
  `UWe` makes context/output limits and tool/stream/reasoning/vision capabilities
  optional. `BWe` validates this enriched shape.
- `d9e` accepts models without `api_types`, but when it exists requires compatible
  API types and explicitly true `supports_tool_use`. Another discovery path also
  requires streaming and text output. Adding partial metadata can therefore
  remove a currently usable model.
- `extensions/cursor-agent-host/dist/900.js` independently parses API types and
  nested capabilities. `out/vs/workbench/workbench.desktop.main.js` contains
  internal RPC/protobuf tool structures; these do not establish public namespace
  ingress support. Minified symbol names are bundle-specific.

Decision: leave catalog output unchanged. Preserve established context/output
aliases, provider ownership and stable timestamp. Omit unknown capabilities and
`api_types`; never advertise Responses ingress merely because Codex uses it
upstream. No migration or UI setting is justified.

## Narrow tool contract

The Chat ingress still accepts at most the existing 256 tool definitions. Tool
normalization follows the installed local agent, not an extra rejection gate.
`G3e` selects Chat Completions for a non-`api.openai.com` base URL unless the
model name contains `codex`. Its chat tool mapper emits nested function tools
and does not fail the request for an unsupported tool.

Flat function declarations become that nested shape. Existing nested functions
are unchanged, including their parameter schemas. `ApplyPatch` is the only
custom tool in this Cursor build. Locally it is declared with
`parameters: { patch: string }` and `customToolFormat: { type: "grammar" }`.
The executor unwraps an argument only when it is raw patch text or a JSON
object whose sole property is the string `patch`. A cloud override request
sends `{ type: "custom", name: "ApplyPatch", format: { type: "grammar" } }`
without that schema. The codec restores the local `{ patch: string }` function
and rewrites custom history to `{"patch":"..."}`. Grammar `syntax` and
`definition`, including `customToolFormat`, are not forwarded, logged or copied
into the description. A schemaless custom tool other than ApplyPatch stays a
same-name function with no invented parameter, and its history input stays the
original string. Namespace, provider-defined and other tool types are passed
through; they do not abort the chat.

Cursor does not rename tool names on the way to a provider. Claude receives
the same `Shell`, `StrReplace`, `ApplyPatch` and `Write` names the agent
advertised. `tool_choice: "none"` omits both the tools and the choice, matching
Cursor's Anthropic client. `auto`, `required` and a function choice become
`auto`, `any` and `{type:"tool", name}`. OpenAI Responses gets flat function
tools only; other tool types are dropped, and `parallel_tool_calls` is not
forced off. MiniMax is not a Cursor provider: its chat body is forwarded,
including the original `tool_choice`.

Custom choices for a converted tool become same-name function choices. Unknown
choices stay as sent. Call identifiers and tool-result text remain unchanged.
There is no generated alias, namespace splitting, global registry or recursive
string replacement. Client-facing output remains the Chat function-call
protocol Cursor already executes.

Existing Codex normalizers already flatten functions, normalize choices, retain
call ids, handle Responses input and custom output event variants. They were not
rewritten. Request schemas still require Chat `messages`; this work does not add
general Responses-shaped ingress or `/v1/responses`.

## Regression fixtures and limitations

Synthetic tests cover flat/nested functions, ApplyPatch's `{patch: string}`
schema, raw history, the executor's unwrap rule, grammar stripping, unchanged
user/result text, choice identity and history ids. Namespace and provider-defined
tools are not a request failure.
Catalog fixtures cover limits, absence of unknown metadata and provider separation.
Terminal/usage regressions are maintained separately in the existing mapper tests.

No live Cursor-backend/Cloudflare turn, provider subscription call, user database
inspection, installation, commit or push is part of this verification.

Test-inclusive `tsc --noEmit` is now part of `pnpm check` for the API,
extension, shared library and dev-kit, alongside the scripts configuration and
Svelte diagnostics. The follow-up baseline contained 9 API and 8 extension
diagnostics; complete fixtures, current runtime-state fields, typed mock wiring
and unused-import cleanup resolve them. Deliberately nonconforming upstream
adapter cases use narrowly documented `@ts-expect-error` directives. Production
types, compiler strictness and library checking remain unchanged.
The follow-up sequential `pnpm check` passed all test-inclusive configurations,
Svelte (zero errors or warnings), workspace lint and all 748 tests, plus the
73-check HTTP harness, 8-process coordination and 171-screen browser audit.
The edited API fixtures also pass targeted ESLint (the normal API lint target
covers production sources).

Verification: Node 24.21.0, Corepack pnpm 10.33.1. Sequential `pnpm check`
and `pnpm package` passed. Package pass: extension 266, API unit 218,
API integration 236, web 28 tests (748 total); focused codec 17 tests and
two new route/catalog cases comprise 19 new tool/catalog regression cases.
HTTP harness passed 73 checks without provider traffic or user DB access.
Coordination passed 8 processes/400 updates/400 clients. Browser audit passed
9 configurations, 171 screens, 11122 text contrast checks, zero page errors.
Verified VSIX: `apps/extension/out/ungate-1.7.14.vsix`, 83 files, hashes match.
The final invalid-declaration fixture correction was additionally re-run in the
focused suite after the package test phase; production sources were unchanged.

## External references and architecture decisions

- [OpenAI Responses streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events)
  defines the public protocol; internal Cursor RPC names are not a replacement
  for that contract.
- [Responses-shaped requests at a Chat endpoint](https://forum.cursor.com/t/override-openai-base-url-sends-responses-api-payload-to-chat-completions-but-expects-chat-completions-output/159298)
  and the [related discussion](https://forum.cursor.com/t/cursor-agent-sends-responses-api-format-to-chat-completions-endpoint/153019)
  motivate synthetic negative fixtures, not a claim that the installed build
  always exhibits the reported behavior. General Responses-body ingress remains
  unsupported; clients must send the documented Chat request shape.
- [Custom-tool validation report](https://forum.cursor.com/t/bug-agent-chat-fails-with-missing-required-parameter-tools-6-custom-when-using-custom-openai-api-key-and-base-url-override/167894)
  motivates explicit flat/nested declaration handling rather than silently
  forwarding malformed provider-specific structures.
- Google, [Building Secure and Reliable Systems, chapter 7](https://google.github.io/building-secure-and-reliable-systems/raw/ch07.html):
  “Make changes that are as small and standalone as possible.”
  The implementation therefore uses a request-local codec and existing terminal
  mapper, not an imported gateway, endpoint framework or persistence layer.

No UI changes were needed, so no claim of Apple/Material design compliance is
made. Analytics, request history, pricing, gateways and additional providers
remain excluded. Thirty new cases were added relative to the pre-change 718-test
baseline; four existing error expectations were corrected.
