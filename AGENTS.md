# Ungate — architecture and project structure

## Purpose

Ungate is a Cursor extension that lets you use Claude, ChatGPT, and MiniMax subscriptions instead of paying for API tokens. It consists of a VS Code extension, a local HTTP proxy (Fastify), a Svelte WebUI, and a shared types/constants library. The primary user value is using a subscription through Cursor's native chat, not exposing a generic proxy for arbitrary providers.

Scope: one monorepo with the extension, proxy, and web UI. Tunnel integration is part of the product because Cursor cannot reach `localhost` from its backend. Hosted deployment, custom domains, and external key-management infrastructure are out of scope.

## Monorepo (pnpm workspace)

```
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

Cursor → Cloudflare Tunnel → Ungate API → Provider API. Cursor cannot call localhost, so a public tunnel URL is required. Ungate listens on a custom OpenAI Base URL, transforms requests into the target provider format and back.

## apps/api — proxy server

Fastify v5 server, spawned by the extension as a child Node.js process. CORS is handled globally via `@fastify/cors`. Both the extension and the API are bundled with `tsup` (CJS) — production entry point is `bundle/main.cjs`, dev entry point is `dist/main.js`.

**Entry points:**

- `/v1/chat/completions` — OpenAI-compatible endpoint, accepts requests from Cursor
- `/v1/messages` — Anthropic-compatible endpoint (direct proxy)
- `/usage`, `/usage/refresh` — normalized subscription snapshots (separate admin capability)
- `/auth/*` — OAuth and provider management routes (admin capability)
- `/v1/models` — model list
- `/settings` — settings (admin capability)

**Architecture:**

- `src/server.ts` — Fastify initialization, plugin registration
- `src/config.ts` — static configuration (URLs, OAuth, beta parameters)
- `src/plugins/auth.ts` — preHandler for API-key authentication

**Routing (`src/routes/`):**

- `openai.ts` — main router: determines provider by model (MiniMax → mapped → Claude). Branch order matters and must stay consistent.
- `anthropic.ts` — direct proxy to Anthropic API with OAuth token
- `usage.ts`, `auth.ts`, `health.ts`, `models.ts`, `settings.ts`

**Provider selection (`src/orchestration/openai/model-routing.ts`):**

- MiniMax: model name prefix or `model_mappings` entry pointing to MiniMax upstream
- OpenAI-mapped: `model_mappings` entry pointing to OpenAI (ChatGPT Codex)
- Claude (Anthropic): default fallback path
- Each model ID maps to one provider (configured per-row in `model_mappings`), not a global setting.

**Proxy clients (`src/proxy/`):**

- `anthropic-client.ts` — requests to Anthropic Claude Code API via OAuth. Tool name mapping (Cursor → Claude Code), 401 retry with token refresh, 400 error diagnostics, logging for rare `illegal value` errors
- `openai-client.ts` — requests to ChatGPT Codex API (`/responses`). Streaming format converter for both `function_call` and `custom_tool_call` variants
- `minimax-client.ts` — requests to MiniMax API
- `proxy-client.ts` — wrapper
- `tool-mapper.ts` — bidirectional tool name mapping (Cursor ↔ Claude Code)
- `request-builder.ts` — request body preparation for Claude Code (headers, stainless headers, beta params)

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

- `openai-stream-handler.ts` — reverse tool name mapping in streams
- `minimax-stream-handler.ts` — MiniMax streaming with `<think>`/`</think>` tag parsing (split tags across chunks via `pendingTag` state)

**Codex responses (`src/proxy/responses-stream-mapper/`):**

- SSE stream parsing from ChatGPT Codex `/responses` into OpenAI chat.completion.chunk
- Handles both streaming variants: `function_call` + `response.function_call_arguments.*` and `custom_tool_call` + `response.custom_tool_call_input.*`
- `stream-state.ts`, `stream-openai-chunks.ts`, `responses-event-router.ts`, `stream-assistant-text.ts`, `process-responses-chunk.ts`, `stream-diagnostics.ts`

**Codex input normalization (`src/proxy/responses-input-normalizer/`):**

- OpenAI chat completion → Codex `/responses` payload transformation
- `input-shape.ts`, `build-body.ts`, `input-text.ts`, `resolve-model.ts`, `types.ts`

**Database (`src/database/`):**

- SQLite via Drizzle ORM + better-sqlite3
- Tables: `app_settings` (port, apiKey, quiet, extraInstruction, claudeCliVersionMode, claudeCliVersionCustom), `provider_settings` (per-provider OAuth tokens, refresh tokens, expiry), `model_mappings` (id, label, provider, upstreamModel, reasoningBudget)
- Migrations: `apps/api/drizzle/` — idempotent (`CREATE TABLE IF NOT EXISTS`, `INSERT OR IGNORE`). Generated with `pnpm drizzle-kit generate --name <index>` (config: `prefix: 'none'`); files are named `_0000.sql`, `_0001.sql`, …
- Model registry: `model_mappings` is the single source of truth for model routing. Default models are seeded by migration `_0002.sql` only — there are no runtime defaults in code.
- Databases on disk: `~/.ungate/data.db` (production default) and `~/.ungate/data-dev.db` (used when `DB_PATH=$HOME/.ungate/data-dev.db` is set in dev). Always verify which database the running API process is using before debugging analytics or auth.

**Types (`src/types/`):**

- `openai.ts`, `anthropic.ts`, `anthropic-stream.ts`, `proxy.ts`, `auth.ts`

**Tools (`src/tools/`):**

- `translator.ts` — tool name translation in responses
- `normalizer.ts` — parameter normalization (string→array)

**Response headers (`src/metrics/`):** request identifiers and diagnostics only; no request persistence.

**Auth (`src/auth/`):**

- OAuth PKCE flow for Anthropic: `startLogin()` generates verifier/challenge, `completeLogin()` exchanges code for tokens. Manual `CODE#STATE` entry required (Anthropic rejects localhost redirect_uri for claude.ai OAuth).

## apps/extension — VS Code extension

User entry point. Manages the API server and tunnel lifecycle.

- `extension.ts` — activate/deactivate
- `extension-controller.ts` — main controller: manages dashboard, typed actions, heartbeat and runtime state sync
- `api-server.ts` — start/stop Node.js API as child process. Production: `cp.spawn(runtime, ['bundle/main.cjs'])`. Dev: `cp.spawn('node', ['-r', 'source-map-support/register', 'dist/main.js'])`. Port detected from stdout via `localhost:(\d+)` regex
- `tunnel-manager.ts` — Cloudflare tunnel (cloudflared) management. Quick tunnel only, no named tunnel config (avoids 404 conflicts). Not auto-started, only on explicit user action. Auto-restarts on port change if already running
- `dashboard.ts` — WebView dashboard (Svelte UI). Reads `index.html` from `web/dist/`, rewrites `/assets/` to `vscode-resource:` URIs, injects `window.__PORT__`. Handshake: frontend sends `webview-ready` before extension sends initial state
- `extension-status-bar.ts` — status bar (API + tunnel state)
- `extension-commands.ts`, shared `schemas/actions.ts` — action catalog, command IDs, allowlist and results
- `shared-service-controller.ts` — serialized lifecycle actions in the requesting window, authenticated API replacement and same-port tunnel preservation
- `local-api.ts` — release/protocol health checks; old APIs are rejected by the management bridge
- `cursor-settings.ts` — capability-checked Models navigation, with explicit fallback; no routing setter or private storage access
- `runtime-state/` — multi-window coordination via file-based state. Windows heartbeat, leader election, command queue

**Native dependencies:**

- cloudflared: binary downloaded to `~/.ungate/bin/`, managed by tsup bundling
- Every standalone download goes through `utils/verified-artifact.ts`: one pinned upstream URL plus a SHA-256 allowlist per platform/arch. Bytes are hashed while streaming into a staging directory and compared with `timingSafeEqual`; nothing is copied, chmod-ed or executed before the digest matches, and staging is deleted on failure
- better-sqlite3 13.0.3 ships N-API prebuilds inside its npm package for x64/arm64 on glibc Linux, musl Linux, macOS and Windows. Packaging includes all eight prebuilds; startup selects the target using the spawned Node runtime's platform/libc/arch and load-tests it. Unsupported tuples fail closed without downloading or compiling native code
- cloudflared 2026.8.2 remains a standalone verified download. Its managed binary carries a `<binary>.sha256` stamp in `~/.ungate/bin/`; an unstamped or mismatched binary is never executed
- There is no manual native-binary drop-in override

**Logs:**

- Two ring buffers (500 entries each): API (stdout/stderr) and tunnel (stderr)
- Health check against `/health` every second, three states: running, stopped, error

## Dashboard transport and packaging

The dashboard communicates through a validated postMessage bridge (`dashboard-api-bridge.ts`), which sends allowlisted operations to IPv4 loopback from the local extension host. The webview does not receive the administrative token and has `connect-src 'none'`. Do not restore browser localhost fetches or general URL forwarding. CORS is registered before administration auth, so legitimate preflight is answered while actual management requests still require the capability.

Analytics, estimated prices and request persistence were removed. `_0010.sql` drops only the old request-history table. Protocol usage fields remain for compatible model responses. Subscription snapshots are memory-only, account-bound, and must display absent, failed or unsupported data explicitly.

Use Node 24 and `corepack pnpm` for development. `task setup`, `task check`, and `task package` delegate to package scripts. The normal package pipeline validates types, lint, tests, HTTP/process/browser regressions, then stages and checks actual VSIX bytes. Only an explicitly requested install command invokes Cursor. Build and package commands are sequential, not parallel Task dependencies.

## apps/web — Svelte Web UI

Dashboard for managing providers, tunnel, settings.

- Svelte 5 (runes), SvelteKit-like structure
- `src/shared/api.ts`, `dashboard-client.ts` — typed client over extension messages
- `src/shared/vscode.ts` — `acquireVsCodeApi()` singleton
- `src/features/settings/` — settings and providers (settings-store, settings-ui-store, provider-store)
- `src/features/tunnel/` — tunnel management (tunnel-store)
- `src/features/usage/` — account subscription windows; no local token/cost analytics
- `src/features/logs/` — log viewer (logs-store)

## packages/shared — shared library

Types, constants, Zod schemas, helpers.

- `src/types/` — `settings.ts`, `runtime.ts`, `tunnel.ts`,  `log.ts`
- `src/constants/` — `routes.ts`
- `src/enums/` — `common.ts`
- `src/helpers/` — `claude-cli.ts` (`ClaudeCliVersion`), `model-provider.ts`, `provider-labels.ts`, `utils.ts`
- `src/schemas/` — `runtime.ts`
- `src/guards/` — `settings.ts`
- Two entry points: `index.ts` (server-side) and `frontend.ts` (browser-safe subset)

## Key mechanisms

**Claude OAuth authentication:** acquires token via Anthropic OAuth PKCE flow, stores in SQLite. Refreshes token on 401. Anthropic requires Claude Code request fingerprint: `?beta=true` URL suffix, `User-Agent` with `claude-cli/<version> (external, claude-vscode, agent-sdk/0.2.7)` (`<version>` from `claudeCliVersionMode` / `claudeCliVersionCustom` in `app_settings`, default stable `2.1.9`), full `x-stainless-*` headers, `anthropic-dangerous-direct-browser-access: true`, three `anthropic-beta` feature flags (oauth, claude-code, interleaved-thinking). Headers built in `RequestBuilder.getClaudeOAuthHeaders()`. Dashboard: Provider → Claude → Claude Code version. Manual `CODE#STATE` entry required — Anthropic does not accept localhost as redirect_uri for claude.ai OAuth.

**System prompt conflict:** Claude Code's system prompt describing tools conflicts with Cursor's actual `input_schema`. The prompt must be minimal — identity only — and delegate tool shape to `input_schema`. The `extraInstruction` field in `app_settings` reinforces this priority. Full removal breaks API contract (empty blocks error), long prompts cause `invalid arguments` on large plans.

**Tool mapping:** Cursor tool names (Shell, LS, StrReplace) are mapped to Claude Code names (Bash, Glob, Edit) on outbound requests and reverse-mapped in responses. Required for Anthropic OAuth whitelist — Anthropic validates tool names server-side and only allows standard Claude Code names. Mapping covers: Bash↔Shell, Read↔Read, Write↔Write, Edit↔StrReplace, Edit↔Delete, Glob↔LS, Grep↔Grep, WebFetch↔WebFetch, WebSearch↔WebSearch.

**Multi-window:** multiple Cursor windows sync via a file-based runtime state in `~/.ungate/`. One window is the leader (monitors shared services), others read state. Detached API and verified tunnel survive window changes; Stop Shared API and Tunnel is explicit. The extension is local UI-only, including Remote SSH windows. Heartbeat-based liveness, command queue for coordinated actions (start/restart/stop tunnel, restart API). Tunnel identity is persisted as PID, executable and unique log marker; lifecycle operations are serialized.

**Cursor navigation:** The old key-fix and routing mode commands were removed. Do not read/write Cursor SQLite or call its key toggle. The legacy runtime `keyFix.enabled` field remains only for old-window compatibility and is set false on bootstrap. Models navigation checks the runtime command registry and calls `aiSettings.action.open` with `models` when available; this is a private Cursor integration, not a stable setter contract.

**API upgrades:** `/health` exposes release and protocol identity. The webview bridge rejects incompatible APIs before management HTTP requests. Recovery actions remain available without a healthy API. Explicit replacement runs from the requesting extension bundle under `commands.lock` and `api-start.lock`; it must not downgrade a newer service or restart a same-port cloudflared process. Stop all suppresses auto-start before shutdown and remains effective on reload.

**Codex streaming variants:** ChatGPT Codex `/responses` has two tool streaming formats — classic `function_call` + `response.function_call_arguments.*` and extended `custom_tool_call` + `response.custom_tool_call_input.*`. Both must be mapped to OpenAI `tool_calls`. Stream mapper processes both. OmniRoute only handles `function_call` — `custom_tool_call` is Ungate-specific.

**MiniMax reasoning:** MiniMax M2.7 streams `<think>`/`</think>` tags as reasoning content. Split tags across chunks are reassembled via `pendingTag` state in `minimax-stream-handler.ts`. Cursor renders this as collapsed "Planning next moves" (non-expandable). Non-streaming responses use `【 Reasoning: ... 】` / `<output>` format (separate parser, not yet implemented).

**Cursor architectural constraint:** Requests go through Cursor backend (`api2.cursor.sh`), not from the local machine. This means localhost never works as OpenAI Base URL — a public tunnel is always required. Cursor 3.0 regression: built-in model names can bypass the custom base URL entirely, requiring custom model IDs from Ungate's model registry.

**Reasoning budget tiers:** `null` (no extended thinking), `medium`, `high`. Default model IDs use the base name (e.g. `sonnet-4.6`); extended-reasoning variants use `-medium` and `-high` suffixes (e.g. `sonnet-4.6-medium`, `sonnet-4.6-high`). The tier is encoded in the model ID; Cursor strips the suffix when forwarding, so the tier must be recovered from the suffix before the request is sent upstream.
