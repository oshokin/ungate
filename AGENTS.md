# Ungate — architecture and project structure

## Purpose

Ungate is a Cursor extension that lets you use Claude, ChatGPT, and MiniMax subscriptions instead of paying for API tokens. It consists of a VS Code extension, a local HTTP proxy (Fastify), a Svelte WebUI, and a shared types/constants library. The primary user value is using a subscription through Cursor's native chat, not exposing a generic proxy for arbitrary providers.

Scope: one monorepo with the extension, proxy, and web UI. Tunnel integration is part of the product because Cursor cannot reach `localhost` from its backend. Hosted deployment, custom domains, and external key-management infrastructure are out of scope.

## Monorepo (pnpm workspace)

```text
ungate/
├── apps/
│   ├── api/          # Local proxy server (Fastify + TypeScript)
│   ├── extension/    # VS Code / Cursor extension
│   └── web/          # Web UI (dashboard) in Svelte
├── packages/
│   ├── shared/       # Shared types, schemas, constants, helpers
│   └── dev-kit/      # Linter, vitest configs
└── scripts/          # Utilities (build, tunnel, check-tunnels)
```

## Data flow

Cursor → Cloudflare Tunnel → Ungate API → Provider API. Cursor cannot call localhost, so a public tunnel URL is required. Cursor's OpenAI Base URL is that tunnel. Ungate listens on IPv4 loopback, turns the chat request into the selected provider's format, and returns OpenAI chat chunks.

## apps/api — proxy server

Fastify v5 server, spawned by the extension as a child Node.js process. CORS is handled globally via `@fastify/cors`. Both the extension and the API are bundled with `tsup` (CJS) — production entry point is `bundle/main.cjs`, dev entry point is `dist/main.js`.

**Entry points.** Do not give these two groups the same prefix. `protectAdministration` skips `/health` and every path under `/v1/`; those routes authenticate the Cursor API key themselves. Everything else requires the admin token and is reached only through the dashboard allowlist.

Provider contract, called by Cursor:

- `/v1/chat/completions` — chat ingress. `ChatToolCodec.normalize` runs before model routing. An unknown model is 404. A handler failure is 502, not a tool-shape 400
- `/v1/models` — OpenAI model list from `model_mappings`
- `/v1/messages`, `/v1/messages/count_tokens` — Anthropic-shaped ingress. Claude and MiniMax mappings are forwarded with the mapped upstream model. An unknown model or an OpenAI mapping is rejected

Local administration:

- `/settings` — settings
- `/usage`, `/usage/refresh` — subscription snapshots, not request history
- `/auth/*` — Claude, ChatGPT Codex and MiniMax sign-in
- `/models/discover` — dashboard discovery for one configured provider. This is not `/v1/models`

**Architecture:**

- `src/server.ts` — Fastify initialization, plugin registration
- `src/config.ts` — static configuration (URLs, OAuth, beta parameters)
- `src/plugins/auth.ts` — preHandler for API-key authentication

**Routing (`src/routes/`):**

- `openai.ts` — main router: determines provider by model (MiniMax → mapped → Claude). Branch order matters and must stay consistent.
- `anthropic.ts` — `/v1/messages` and token counting. Claude goes through the OAuth client; MiniMax uses `minimax-anthropic-client.ts`
- `usage.ts`, `auth.ts`, `health.ts`, `models.ts`, `model-discovery.ts`, `settings.ts`

**Provider selection (`src/orchestration/openai/model-routing.ts`):**

- Resolution is `model_mappings` only: exact id, then a dropped reasoning suffix, then an upstream model. A name prefix does not select a provider, and an unknown id is 404
- MiniMax and OpenAI are taken from the resolved row. Every other resolved provider, including Claude, uses the Claude handler
- Each model ID maps to one provider, configured per row, not by a global setting

**Proxy clients (`src/proxy/`):**

- `chat-tool-codec.ts` — chat-ingress tool normalization, before provider routing
- `anthropic-client.ts` — Anthropic Claude Code API via OAuth. Tool names are forwarded unchanged and `reverseToolMapping` is always `{}`. 401 retries after a token refresh. 400 responses are logged, including the rare `illegal value` case
- `openai-client.ts` — ChatGPT Codex `POST /responses` with the Codex OAuth token. This is not `api.openai.com` chat completions. The stream mapper handles both `function_call` and `custom_tool_call`
- `minimax-client.ts` — MiniMax `{base}/v1/text/chatcompletion_v2`. Cursor has no MiniMax client. The forwarded body is a whitelist: model, messages, stream, `stream_options.include_usage` when streaming, `max_completion_tokens`, temperature, top_p, tools, and the original `tool_choice`. The base URL must be an official MiniMax origin
- `minimax-anthropic-client.ts` — Anthropic-shaped MiniMax requests from `/v1/messages`
- `proxy-client.ts` — wrapper
- `request-builder.ts` — Claude Code request fingerprint: headers, stainless headers, beta flags, adaptive thinking

**OpenAI orchestration (`src/orchestration/openai/`):**

- `model-routing.ts` — provider determination by model ID
- `provider-handlers/` — handlers for Claude, OpenAI, MiniMax
- `streaming-gateway.ts` — stream management
- `error-mapper.ts`, `error-messages.ts` — error mapping to OpenAI format

**Adapters (`src/adapter/`):**

- `anthropic-to-openai.ts` — Anthropic response → OpenAI format conversion (including streaming tool calls)
- `openai-to-anthropic.ts` — OpenAI request → Anthropic conversion
- `xml-tool-parser.ts` — XML tool use parsing

**Streaming (`src/streaming/`):**

- `openai-stream-handler.ts` — Claude SSE to OpenAI chat chunks. Tool names are not renamed. `ToolNormalizer` may rewrite the arguments of a completed call. The `reverseToolMapping` lookup stays, and production always passes `{}`
- `minimax-stream-handler.ts` — MiniMax streaming with `<think>`/`</think>` tag parsing (split tags across chunks via `pendingTag` state)

**Codex responses (`src/proxy/responses-stream-mapper/`):**

- SSE stream parsing from ChatGPT Codex `/responses` into OpenAI chat.completion.chunk
- Handles both streaming variants: `function_call` + `response.function_call_arguments.*` and `custom_tool_call` + `response.custom_tool_call_input.*`
- `stream-state.ts`, `stream-openai-chunks.ts`, `responses-event-router.ts`, `stream-assistant-text.ts`, `process-responses-chunk.ts`, `stream-diagnostics.ts`

**Codex input normalization (`src/proxy/responses-input-normalizer/`):**

- OpenAI chat completion → Codex `/responses` payload. Nested function tools are flattened; already-flat function tools pass through; every other tool type is dropped. `tool_choice` is copied only when the client sent one. `parallel_tool_calls` is not forced off
- `input-shape.ts`, `build-body.ts`, `input-text.ts`, `resolve-model.ts`, `types.ts`

**Database (`src/database/`):**

- SQLite via Drizzle ORM + better-sqlite3
- Tables: `app_settings` (port, apiKey, quiet, extraInstruction, claudeCliVersionMode, claudeCliVersionCustom, tunnelProtocol), `provider_settings` (provider, accessToken, refreshToken, expiresAt, email, accountId, createdAt, baseUrl), `model_mappings` (id, label, provider, upstreamModel, sortOrder, reasoningBudget, serviceTier, contextWindow, maxOutputTokens)
- Migrations: `apps/api/drizzle/` — idempotent (`CREATE TABLE IF NOT EXISTS`, `INSERT OR IGNORE`, later `ALTER TABLE`). Generated with `pnpm drizzle-kit generate --name <index>` (config: `prefix: 'none'`); files are `_0000.sql` through `_0013.sql`. `_0010.sql` drops the retired `requests` table and nothing else
- Model registry: `model_mappings` is the single source of truth for model routing. Default models are seeded by migration `_0002.sql` only — there are no runtime defaults in code
- Databases on disk: `~/.ungate/data.db` (production default) and `~/.ungate/data-dev.db` (used when `DB_PATH=$HOME/.ungate/data-dev.db` is set in dev). Check which file the running API process has open before debugging auth or routing

**Types (`src/types/`):**

- `openai.ts`, `anthropic.ts`, `anthropic-stream.ts`, `proxy.ts`, `auth.ts`

**Tools (`src/tools/`):**

- `translator.ts` — rewrites legacy XML tool markup inside assistant text. It is not an outbound tool-name map
- `normalizer.ts` — adjusts arguments of a completed Claude tool call (path aliases, numeric strings, Shell command shape). It does not rename the tool

**Response headers (`src/metrics/`):** request identifiers and diagnostics only; no request persistence.

**Auth (`src/auth/`):**

- Claude: OAuth PKCE. `startLogin()` generates the verifier and challenge, `completeLogin()` exchanges the code. Manual `CODE#STATE` entry is required because Anthropic rejects a localhost redirect for claude.ai OAuth
- OpenAI: Codex OAuth PKCE with a loopback callback on port 1455. See `src/auth/openai/`
- MiniMax: API key plus an official base URL, not OAuth

## apps/extension — VS Code extension

User entry point. Manages the API server and tunnel lifecycle.

- `extension.ts` — activate/deactivate
- `extension-controller.ts` — main controller: manages dashboard, typed actions, heartbeat and runtime state sync
- `api-server.ts` — start/stop Node.js API as child process. Production: `cp.spawn(runtime, ['bundle/main.cjs'])`. Dev: `cp.spawn('node', ['-r', 'source-map-support/register', 'dist/main.js'])`. Port detected from stdout via `localhost:(\d+)` regex
- `tunnel-manager.ts` — Cloudflare tunnel (cloudflared) management. Quick tunnel only, no named tunnel config (avoids 404 conflicts). Not auto-started, only on explicit user action. Auto-restarts on port change if already running
- `dashboard.ts` — WebView dashboard (Svelte UI). Reads `index.html` from `web/dist/`, rewrites `/assets/` to `vscode-resource:` URIs, injects `window.__PORT__`. Handshake: frontend sends `webview-ready` before extension sends initial state
- `extension-status-bar.ts` — connection state only. `usage-controller.ts` owns the dashboard/status-bar snapshot and sequential polling; only the runtime leader refreshes providers, followers read cache. `ungate.usage.claude`, `.openai`, `.minimax` are independent opt-in items showing the lowest reported basic-window remaining percentage with its actual duration. Application preferences default to auto-refresh off, 60 seconds (15–3600), all widgets off. Disconnected accounts are omitted. Cursor's own plan meter is not read.
- `extension-commands.ts`, shared `schemas/actions.ts` — action catalog, command IDs, allowlist and results
- `shared-service-controller.ts` — serialized lifecycle actions in the requesting window, authenticated API replacement and same-port tunnel preservation
- `local-api.ts` — release/protocol health checks; old APIs are rejected by the management bridge
- `cursor-settings.ts` — capability-checked Models navigation, with explicit fallback; no routing setter or private storage access
- `runtime-state/` — multi-window coordination via file-based state. Windows heartbeat, leader election, command queue

**Native dependencies:**

- cloudflared: verified standalone download to `~/.ungate/bin/`. It is not part of the tsup bundle
- Every standalone download goes through `utils/verified-artifact.ts`: one pinned upstream URL plus a SHA-256 allowlist per platform/arch. Bytes are hashed while streaming into a staging directory and compared with `timingSafeEqual`; nothing is copied, chmod-ed or executed before the digest matches, and staging is deleted on failure
- better-sqlite3 13.0.3 ships N-API prebuilds inside its npm package for x64/arm64 on glibc Linux, musl Linux, macOS and Windows. Packaging includes all eight prebuilds; startup selects the target using the spawned Node runtime's platform/libc/arch and load-tests it. Discovery requires standalone Node >=22 with Node-API >=10 (22.14+), not a Node module-ABI allowlist. `node-runtime-settings.ts` reads only the machine/global path and validates file-picker selections; never honor workspace executable paths. The picker may start an absent API, but must not restart a live shared service. Unsupported tuples fail closed without downloading or compiling native code
- cloudflared 2026.8.2 remains a standalone verified download. Its managed binary carries a `<binary>.sha256` stamp in `~/.ungate/bin/`; an unstamped or mismatched binary is never executed
- There is no manual native-binary drop-in override

**Logs:**

- `[runtime]` identifies runtime discovery; `[sqlite]` identifies native SQLite checks. Do not put component tags in user-facing exception messages. The webview logs must use paired editor background/foreground tokens and remain readable with dark, light and high-contrast themes.

- Shared API/tunnel journal and dashboard view; 500 entries per source by default, controlled by the application-scoped `ungate.logs.maxEntries` preference (100–5000). `packages/shared/src/limits.ts` owns defaults and bounds; file retention is independent. Both processes use `utils/log-file-reader.ts` to publish only complete UTF-8/CRLF lines with a bounded read budget.
- Health check against `/health` every second, three states: running, stopped, error
- `ungate.network.providerHeaderTimeoutSeconds` (5–120, default 30) is the provider response-header deadline passed to the API process. It is not a stream idle timeout

## Dashboard transport and packaging

The dashboard communicates through a validated postMessage bridge (`dashboard-api-bridge.ts`), which sends allowlisted operations to IPv4 loopback from the local extension host. The webview does not receive the administrative token and has `connect-src 'none'`. Do not restore browser localhost fetches or general URL forwarding. CORS is registered before administration auth, so legitimate preflight is answered while actual management requests still require the capability.

Analytics, estimated prices and request persistence were removed. `_0010.sql` drops only the old request-history table. Protocol usage fields remain for compatible model responses. Subscription snapshots are memory-only, account-bound, and must display absent, failed or unsupported data explicitly.

Use Node 24 and `corepack pnpm` for development. `task setup`, `task check`, and `task package` delegate to package scripts. The normal package pipeline validates types, lint, tests, HTTP/process/browser regressions, then stages and checks actual VSIX bytes. Only an explicitly requested install command invokes Cursor. Build and package commands are sequential, not parallel Task dependencies.

## apps/web — Svelte Web UI

Use semantic `ug-*` classes and paired VS Code theme tokens from `app.css` for every panel, state and control. Keep Tailwind for layout only; do not restore Skeleton/Wintry or independent surface/primary color scales. Native form color-scheme follows the webview body theme class, not the OS preference. Keep normal/light/high-contrast fallbacks readable when optional tokens are missing. `scripts/tests/dashboard-theme.ts` audits the rendered screens with composited text contrast; its plain JavaScript browser-side helper avoids tsx serialization helpers. Cover button hover color pairs, open menus and tooltips at 320/420/580 px, sparse high-contrast tokens, opposing OS color schemes, and Windows forced-colors independently. Tooltips use a viewport-bounded native popover, associated via aria-describedby and dismissible with Escape. Confirmation uses native `<dialog>.showModal()` with themed foreground/background, Escape cancellation and native focus containment.

Dashboard for managing providers, tunnel, settings.

- Svelte 5 (runes) built with Vite. It is not a SvelteKit app
- `src/shared/api.ts`, `dashboard-client.ts` — typed client over extension messages
- `src/shared/vscode.ts` — `acquireVsCodeApi()` singleton
- `src/features/settings/` — settings, providers and model discovery
- `src/features/auth/` — Claude, ChatGPT and MiniMax sign-in panels
- `src/features/tunnel/` — tunnel management (tunnel-store)
- `src/features/usage/` — account subscription windows; no local token/cost analytics
- `src/features/logs/` — log viewer (logs-store)

## packages/shared — shared library

Types, constants, Zod schemas, helpers.

- `src/types/` — `settings.ts`, `runtime.ts`, `tunnel.ts`, `log.ts`, `usage.ts`
- `src/constants.ts` — ports, loopback, Claude CLI fingerprint, MiniMax origins, API versions. There is no `src/constants/` directory and no `src/enums/`
- `src/helpers/` — `claude-cli.ts` (`ClaudeCliVersion`), `model-provider.ts`, `provider-labels.ts`, `utils.ts`, `admin-token.ts`
- `src/schemas/` — `runtime.ts`, `actions.ts`, `dashboard.ts`
- `src/guards/` — `settings.ts`
- `src/limits.ts`, `provider-timeout.ts`, `process-lock.ts`, `service.ts`, `fs-access.ts`
- Two entry points: `index.ts` (server-side) and `frontend.ts` (browser-safe subset)

## Key mechanisms

**Claude OAuth authentication:** acquires token via Anthropic OAuth PKCE flow, stores in SQLite. Refreshes token on 401. Anthropic requires Claude Code request fingerprint: `?beta=true` URL suffix, `User-Agent` with `claude-cli/<version> (external, claude-vscode, agent-sdk/0.2.7)` (`<version>` from `claudeCliVersionMode` / `claudeCliVersionCustom` in `app_settings`, default stable `2.1.9`), full `x-stainless-*` headers, `anthropic-dangerous-direct-browser-access: true`, three `anthropic-beta` feature flags (oauth, claude-code, interleaved-thinking). Headers built in `RequestBuilder.getClaudeOAuthHeaders()`. Dashboard: Provider → Claude → Claude Code version. Manual `CODE#STATE` entry required — Anthropic does not accept localhost as redirect_uri for claude.ai OAuth.

**ChatGPT Codex OAuth:** the OpenAI provider is the Codex CLI OAuth client (`originator: codex_cli_rs`), not an API key and not public Chat Completions. The callback is `http://localhost:1455/auth/callback`. Tokens are stored in `provider_settings`. Upstream calls go to `https://chatgpt.com/backend-api/codex/responses`.

**System prompt conflict:** Claude Code's system prompt describing tools conflicts with Cursor's actual `input_schema`. The prompt must be minimal — identity only — and delegate tool shape to `input_schema`. The `extraInstruction` field in `app_settings` reinforces this priority. Full removal breaks API contract (empty blocks error), long prompts cause `invalid arguments` on large plans.

**Tools:** do not rename Cursor tool names and do not restore `tool-mapper.ts`. `/v1/chat/completions` runs `ChatToolCodec.normalize` before routing. Nested function tools stay nested. A flat function tool becomes nested. `ApplyPatch` is the only custom tool restored to a function with parameters `{ patch: string }`; grammar and `customToolFormat` are dropped. Another schemaless custom tool stays a same-name function with no invented schema, and its history input stays the raw string. Custom history is wrapped as JSON only when that tool's schema has one required string property, so ApplyPatch history becomes `{"patch":"..."}`. Namespace and provider-defined tools are removed from the chat tool list. They do not abort the request. A `custom` or `function` choice for a known name becomes a function choice. An unknown object choice stays as sent.

Claude receives the same names, including `Shell`, `StrReplace`, `ApplyPatch` and `Write`. `tool_choice: "none"` omits both `tools` and `tool_choice`. `auto` becomes `{type:"auto"}`, `required` becomes `{type:"any"}`, and a function choice becomes `{type:"tool", name}`. Tool ids are sanitized to `^[a-zA-Z0-9_-]+$` so `tool_use` and `tool_result` stay paired. `RequestContext.reverseToolMapping` remains for the stream lookup and is always `{}` in production.

Codex `/responses` then receives only flat function tools. MiniMax chat forwards the already normalized tools and the original `tool_choice`. MiniMax is not a Cursor provider.

**Multi-window:** multiple Cursor windows sync via a file-based runtime state in `~/.ungate/`. One window is the leader (monitors shared services), others read state. Detached API and verified tunnel survive window changes; Stop Shared API and Tunnel is explicit. The extension is local UI-only, including Remote SSH windows. Heartbeat-based liveness, command queue for coordinated actions (start/restart/stop tunnel, restart API). Tunnel identity is persisted as PID, executable and unique log marker; lifecycle operations are serialized.

**Cursor navigation:** The old key-fix and routing mode commands were removed. Do not read/write Cursor SQLite or call its key toggle. The legacy runtime `keyFix.enabled` field remains only for old-window compatibility and is set false on bootstrap. Models navigation checks the runtime command registry and calls `aiSettings.action.open` with `models` when available; this is a private Cursor integration, not a stable setter contract.

**API upgrades:** `/health` exposes release and protocol identity. The webview bridge rejects incompatible APIs before management HTTP requests. Recovery actions remain available without a healthy API. Explicit replacement runs from the requesting extension bundle under `commands.lock` and `api-start.lock`; it must not downgrade a newer service or restart a same-port cloudflared process. Stop all suppresses auto-start before shutdown and remains effective on reload.

**Codex streaming variants:** ChatGPT Codex `/responses` has two tool streaming formats — classic `function_call` + `response.function_call_arguments.*` and extended `custom_tool_call` + `response.custom_tool_call_input.*`. Both must be mapped to OpenAI `tool_calls`. Stream mapper processes both. OmniRoute only handles `function_call` — `custom_tool_call` is Ungate-specific.

**MiniMax reasoning:** MiniMax M2.7 streams `<think>`/`</think>` tags as reasoning content. Split tags across chunks are reassembled via `pendingTag` state in `minimax-stream-handler.ts`. Cursor renders this as collapsed "Planning next moves" (non-expandable). The stream parser only handles those tags. There is no separate non-streaming reasoning parser.

**Cursor architectural constraint:** Requests go through Cursor backend (`api2.cursor.sh`), not from the local machine. This means localhost never works as OpenAI Base URL — a public tunnel is always required. Cursor 3.0 regression: built-in model names can bypass the custom base URL entirely, requiring custom model IDs from Ungate's model registry.

**Reasoning budget:** a mapping stores `null` or one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, `persistent`. Seeded Claude rows use `null`, `medium` and `high` on ids such as `sonnet-4.6` and `sonnet-4.6-high`. Cursor can drop that trailing tier and send the effort separately. Recovery reattaches a suffix only when it equals that row's own budget; the first matching row by `sortOrder` wins. On the Claude path a string budget becomes adaptive thinking plus `output_config.effort` for `low`, `medium`, `high`, `xhigh` and `max`. A numeric budget and every other stored tier are ignored there. On the OpenAI-mapped path the stored budget fills `reasoning.effort` only when the client did not already send `reasoning.effort` or `reasoning_effort`.
