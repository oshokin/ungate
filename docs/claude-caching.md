# Claude request caching

Ungate adds `cache_control: { "type": "ephemeral" }` only to outgoing Claude
`/v1/messages` completion requests, including converted Chat Completions. No TTL
is requested: Anthropic documents a five-minute default. Token counting and
MiniMax requests do not receive this default.

Explicit top-level cache policies are preserved (including supported `5m` and
`1h` TTLs); Chat Completions also preserves a valid top-level policy. When an
outgoing request already contains a cache marker on a tool, system block, or
message block, Ungate skips its default. This avoids adding another breakpoint
to a client policy; it does not repair invalid client policies or guarantee that
client-supplied policies fit Anthropic's four-breakpoint limit. Explicit block
TTLs are preserved through Chat conversion on supported tool, system, text,
and image blocks, as well as during native Claude request preparation.

Anthropic's [prompt caching documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
(consulted November 7, 2026) documents automatic top-level caching, the default
lifetime, and the four-breakpoint limit. Automatic caching moves the breakpoint
to the last eligible block. Cache hits still depend on provider eligibility,
minimum token thresholds, identical prefixes, expiry, and lookback limits.

This change is covered by local mocked-request and routing tests, not live
provider testing. It does not guarantee cache hits, subscription-limit savings,
or OAuth-account acceptance; it adds no pricing, history, settings, or storage.

## Local Cursor comparison

Inspected November 7, 2026: installed Cursor **3.29.9**. Its
`/usr/share/cursor/resources/app/extensions/cursor-agent-host/dist/900.js`
contains a Messages executor that marks the latest message as ephemeral and
retains up to four rolling message breakpoints. Equivalent code exists in
`cursor-local-agent-runtime/dist/main.js` and `cursor-agent-exec/dist/main.js`.
The provider adapter in `cursor-agent-host/dist/3534.js` serializes Anthropic
cache policies. This establishes a configured local Messages path, not the
behavior of every request routed through Cursor's backend.

Ungate's automatic top-level policy is a documented alternative to rolling
explicit breakpoints. It does not need extra markers to match that intent.
No explicit OpenAI cache-key/retention forwarding or MiniMax-specific cache
implementation was found in the inspected Cursor bundles. Server-side routing,
retention, and actual cache-hit rates remain unknown.

## OpenAI/Codex and MiniMax

[OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
is automatic for eligible repeated prefixes. Ungate preserves an explicitly
supplied `prompt_cache_key` for Codex, without inventing a random or account-wide
key. Mocked fetch-boundary tests verify stable instructions, tools, history and
request bodies across appended turns and authentication retries. `store: false`
is not a switch that disables prompt caching. Public API retention options are
not assumed to work on the subscription Codex endpoint; Ungate does not inject
`prompt_cache_retention`.

[MiniMax prompt caching](https://platform.minimax.io/docs/api-reference/text-prompt-caching)
automatically matches eligible prefixes. Its OpenAI-compatible path receives no
injected Claude cache policy. Its Anthropic-compatible path preserves explicit
client policies; this does not imply that all models support every policy or TTL.
Tests verify body and prefix preservation, not live provider cache hits.

## Usage accounting

For Anthropic-format responses, total prompt tokens include `input_tokens`,
`cache_creation_input_tokens`, and `cache_read_input_tokens`. Streaming and
non-streaming Chat conversion use the same calculation. Only reported cache
reads become `prompt_tokens_details.cached_tokens`: writes are not reads, an
explicit zero remains zero, and an absent counter remains absent.

OpenAI/MiniMax-format `prompt_tokens` already includes cache reads and must not
have cached tokens added again. MiniMax streaming preserves reported
`prompt_tokens_details`, as documented by its
[Chat Completion API](https://platform.minimax.io/docs/api-reference/text-chat-openai).
These counters improve visibility; they do not enable caching themselves.

This is provider-side prompt-prefix reuse, not cached completion replay. No
credentials, private conversation history, or paid provider requests were used
for this comparison.
