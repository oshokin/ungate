# Changelog

## 1.7.14 - 2026-10-25 (oshokin fork)

- Preserve independently resizable API/tunnel logs, saved panel heights, initial tail positioning and unread-entry counts from the user's 2026-10-30 source archive alongside the dashboard settings and refactoring.
- Reset paused log following after Clear so a delayed history snapshot opens at the latest entry.
- Resume the tail when a retained dashboard becomes visible; do not count older history loaded by a larger display limit as new entries, including when a live entry announces the preference first.
- Verify pointer/keyboard resizing, height bounds and reset, page re-entry and webview reload persistence in the real browser regression suite. Release identity remains 1.7.14.
- Clean WebUI output before building so repeated packaging does not retain obsolete hashed JavaScript assets.

- Incorporate upstream 1.7.14, Remote SSH dashboard port mapping, and preservation of parallel Claude tool calls.
- Protect model traffic with API keys and management routes with a separate local capability; bind administration to IPv4 loopback.
- Move dashboard requests through a validated extension-host bridge so the webview never receives the administrative token.
- Coordinate API and tunnel processes across Cursor windows with lifecycle locks, leader recovery, explicit replacement, and reliable Stop all behavior.
- Add release and protocol compatibility checks with recovery actions for an outdated shared API.
- Remove the Cursor database reader, downloaded sqlite3 CLI, OpenAI key-toggle loop, billing guard, and their compatibility migrations.
- Replace routing toggles with explicit Models navigation and concise `Ready`, `Connecting`, and `Offline` connection status.
- Remove request analytics, history, cost estimates, and charts; add memory-only subscription usage with explicit unavailable and error states.
- Add provider model discovery and reconciliation while preserving user-defined model mappings.
- Harden OAuth refresh, Codex usage and reasoning handling, and interrupted Claude, MiniMax, and Codex streams.
- Redesign the dashboard around Connection, Usage, Logs, responsive settings, and editor theme tokens.
- Verify downloaded native artifacts against pinned SHA-256 allowlists before installation or execution.
- Add portable Node 24 build and CI pipelines, isolated VSIX staging and verification, packaged API smoke tests, process coordination tests, and browser regressions.
- Replace the obsolete Node module-ABI allowlist with standalone Node and Node-API 10 checks matching the bundled SQLite prebuilds.
- Fix nvm-windows version paths; discover later PATH entries, fnm installations and case-insensitive Windows environment keys.
- Add a validated, machine-local Node executable picker and an explicit recovery action without restarting an active shared API.
- Keep probe timeouts, direct executable invocation and hidden Windows consoles; remove the duplicate unbounded runtime-path probe.
- Separate runtime and SQLite diagnostic categories and keep component tags out of user-facing errors.
- Render API/tunnel logs with native editor colors; share their rendering and verify visible error text across themes.
- Remove the independent Skeleton/Wintry palette and unused dependencies. All dashboard panels and controls now use the editor theme.
- Fix provider authentication, Usage, model families/selection, discovery notices, inputs, selects, radio controls and tooltips in dark, light and both high-contrast themes.
- Use a native themed removal dialog with keyboard focus containment and Escape cancellation.
- Extend browser regression checks to all provider screens, model editing, settings, Usage, removal and tooltips; include live theme changes, missing optional tokens and an opposite OS color preference.

- Keep both extension and bundled API release identity at 1.7.14; use only the workspace pnpm pin and lockfile, removing the obsolete per-extension lockfile.
- Pair quiet-button hover foreground and background; bound overflow menus/tooltips and reflow narrow headers and version controls.
- Use associated, hoverable native popover tooltips with Escape dismissal and explicit Windows forced-colors boundaries.
- Share a bounded, complete-line process log reader that preserves UTF-8/CRLF across polling boundaries.
- Consolidate dashboard transport limits, lifecycle timing, log retention constants, source state and copy-feedback teardown.
- Add the user-level logs.maxEntries preference (500 by default, 100–5000) without restarting shared services.
- Skip malformed shared-log records and tolerate concurrent file pruning.
- Include web unit tests in the root test command and verify all eight platform/architecture SQLite prebuilds in the packaged VSIX.
- Expand browser checks to sparse high-contrast tokens, adversarial secondary-button colors, narrow open panels and forced-colors.

## 1.7.13 - 2026-10-07

- Add GPT-6 Astra with standard and priority tiers
- Fix Cursor MCP tools not reaching Claude
- Fix `GenerateImage` and Semble search tools not reaching Claude
- Rewrite README
- Add contributing guide, security policy, and issue templates

## 1.7.12 - 2026-08-26

- Verify SHA-256 checksums for all native binary downloads (`cloudflared`, `better-sqlite3`, `sqlite3`) before execution
- Fix API server failing to start in Docker/Remote-SSH containers by accepting the editor's Node executable as a runtime candidate
- Fix selecting unsupported Node runtimes (e.g. Node 23) when a compatible Node version is available

## 1.7.11 - 2026-08-16

- Fix 400 on long chats by clamping Codex tool call IDs to 64 characters and keeping call/output pairs paired
- Recover tunnel state orphaned by a window that died without shutting the tunnel down

## 1.7.10 - 2026-08-14

- Fix interrupted Claude tool streams being truncated or partially executed; raise thinking default to 32k tokens

## 1.7.9 - 2026-08-13

- Fix 400 on accepting a Cursor plan with Claude models by sanitizing tool ids from plan history (`functions.X:1` → `functions_X_1`)

## 1.7.8 - 2026-08-10

- Fix 413 on multi-image Cursor requests by raising the request body limit to 256 MiB
- Check the API key before the body is parsed so unauthorized requests are not buffered

## 1.7.7 - 2026-08-07

- Fix API server failing to start on Node 26 by bumping better-sqlite3 to 12.11.1
- Drop Node 20 and 23 support; supported runtimes: Node 22, 24, 26

## 1.7.6 - 2026-08-06

- Fix GPT-5.6 priority-tier models failing when Cursor strips the reasoning tier from the model id

## 1.7.5 - 2026-07-29

- Add GPT-5.6 Sol, Terra, and Luna support with configurable reasoning and OpenAI service tiers
- Seed six focused medium-effort defaults covering normal and priority service
- Preserve the selected dashboard page, settings provider/model, and per-page scroll position across webview reloads

## 1.7.4 - 2026-07-27

- Fix adding custom models from dashboard returning 400
- Fix native binding loading failure on first run after upgrade
- Show API error details in dashboard when saving settings fails

## 1.7.3 - 2026-06-25

- Fix Anthropic provider errors with non-JSON bodies so upstream failures return a normal error response instead of crashing the API

## 1.7.2 - 2026-06-25

- Add Opus-4.8 model support
- Map reasoning tiers to adaptive thinking + effort for Opus 4.7/4.8 (previously dropped)
- Fix Codex (GPT-5.5) tool calls failing with "Missing required parameter: 'tools[0].name'" by flattening tools to Responses API format

## 1.7.1 - 2026-05-25

- Update changelog

## 1.7.0 - 2026-05-25

- Add Windows support

## 1.6.0 - 2026-05-19

- Sync API, tunnel, and OpenAI key-fix settings across all open Cursor windows
- Show the same API and tunnel logs in every dashboard window, with live updates and shared clear actions
- OpenAI key-fix is off by default; enable it from the dashboard or status bar if you want Ungate to keep `OpenAI API Key` enabled in Cursor
- Fix OpenAI key-fix so it turns the key back on after Cursor disables it, including when the extension starts with key-fix already enabled

## 1.5.2 - 2026-04-27

- Add GPT-5.5 and Opus-4.7 model support
- Preserve user-defined model mappings when adding new default models
- Support `xhigh` reasoning tier in model settings

## 1.5.1 - 2026-04-25

- Start quick tunnel with `--config /dev/null` to avoid Cloudflare 404 from local `~/.cloudflared/config.yml` ingress rules

## 1.5.0 - 2026-04-25

- Keep OpenAI API Key enabled when Cursor turns it off on its own
- Add on/off controls for this behavior in the status bar tooltip and dashboard

## 1.4.1 - 2026-04-22

- Fix Node 24 startup by updating bundled `better-sqlite3` and packaged API dependencies

## 1.4.0 - 2026-04-20

- Redesign provider settings and model management flow
- Add status bar hover tooltip with API state, tunnel URL, and quick actions
- Refactor extension module layout to simplify controller and lifecycle handling
- Upgrade analytics with provider and model filters, improved OpenAI stream accounting, and aggregated token timelines

## 1.3.2 - 2026-04-15

- Refactor API internals for auth, proxy helpers, stream mapping, and OpenAI chat orchestration
- Add local build, install, and debug instructions to README

## 1.3.0 - 2026-04-04

- Add ChatGPT OAuth authentication
- Add GPT and Codex model support through the model registry
- Track OpenAI usage in analytics and provider settings alongside Claude and MiniMax

## 1.2.0 - 2026-04-04

- Add custom model registry with editable model IDs
- Add dedicated `model_mappings` storage and settings UI CRUD for model mappings
- Document Cursor 3.0 bug where built-in model names can bypass `OpenAI Base URL` and hit the real provider API directly
- Fix MiniMax streaming tool call argument assembly so tools and planning mode work correctly

## 1.1.0 — 2026-04-03

- `MiniMax-M2.7` model support
- MiniMax Base URL selector: `Global`, `China`, `Custom`
- MiniMax streaming separates `<think>...</think>` reasoning from the final response
- Provider-aware analytics for Claude and MiniMax

## 1.0.1 — 2026-04-02

- Fix tunnel restart loop
- Add Stop button while tunnel is starting

## 1.0.0 — 2026-03-31

- OAuth login via Claude account
- Cloudflare quick tunnel for public URL
- OpenAI-compatible proxy
- Request log with token/cost tracking
- Web dashboard: analytics, logs, settings, tunnel control
- Models: Claude Sonnet 4.6, Opus 4.6, Haiku 4.5
