# Model routing and provider protocols

The data path is **Cursor backend → public tunnel → local Ungate API → provider**.
See [runtime and operations](runtime-and-operations.md) for tunnel and security
boundaries, and the [README](../README.md) for installation.

## Model registry

**Providers & models** stores the registry used by `/v1/models` and routing.
Each row selects its provider, upstream model and optional reasoning settings.
Resolution uses an exact ID, compatible reasoning-suffix recovery or an
upstream-model match. A name prefix alone does not select a provider; unknown
models return 404. Prefer custom registry IDs: Cursor may route built-in model
names outside the override. Dashboard discovery is separate from `/v1/models`.

## Endpoints

- `/v1/chat/completions` accepts Chat Completions and returns OpenAI-shaped
  responses or streaming chunks. Claude requests become Anthropic Messages;
  ChatGPT/Codex uses the subscription backend's `/responses`, not the public
  OpenAI Chat Completions API. MiniMax uses `/v1/text/chatcompletion_v2`.
- `/v1/messages` and `/v1/messages/count_tokens` accept Anthropic-shaped requests
  for Claude and MiniMax mappings only; OpenAI mappings are rejected.
- There is no `/v1/responses` ingress or general Responses-body support at the
  Chat endpoint.

## Tools and compatibility

Chat ingress normalizes flat/nested function declarations without renaming tools.
Custom `ApplyPatch` becomes a function accepting `{ patch: string }`; grammar
metadata is removed. Namespace and provider-defined declarations are dropped
without failing the whole request. Codex receives flat function tools and maps
both function and custom-tool streaming events back into Chat tool calls.
Compatibility depends on Cursor's request format, not a universal protocol bridge.

[Cursor compatibility evidence](cursor-compatibility.md) records observations
for one installed build and historical local results, not a promise about every
Cursor version or its remote backend. Current implementation takes precedence.

## Prompt caching

[Claude caching and accounting](claude-caching.md) describes default and explicit
cache policies, Codex `prompt_cache_key` forwarding, provider-specific boundaries
and verification limits. This is provider-side prompt-prefix reuse, not local
response caching. Eligibility, hits and effects on subscription limits are not
guaranteed. Protocol cached-token counters remain available, but no request
history or local cost analytics is stored. MiniMax caching is provider-controlled.
