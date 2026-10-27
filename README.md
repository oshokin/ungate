# Ungate — my fork based on 1.7.14

Use connected Claude, ChatGPT/Codex and MiniMax accounts in Cursor's native chat through a local proxy and a public tunnel. This is my fork of [orchidfiles/ungate](https://github.com/orchidfiles/ungate), not an official Marketplace release.

## Why this fork

The original extension worked unreliably in my setup, and its routing, process lifecycle and interaction with Cursor were difficult to understand and troubleshoot. I audited and refactored the project, fixed the failures I encountered, and added the behavior, diagnostics and safeguards I considered missing.

The main changes in this fork are:

- Reworked API and tunnel lifecycle management so local and Remote SSH windows share state safely without unexpectedly stopping active services.
- Corrected provider routing and request/stream conversion for Claude, ChatGPT/Codex and MiniMax, including tool calls and reasoning variants.
- Simplified and hardened the Cursor integration by removing unsupported key/database manipulation and making model configuration explicit.
- Redesigned the dashboard around connection management, subscription usage and actionable logs; removed request tracking, price estimates and speculative analytics.
- Hardened credentials, local storage, artifact downloads and native dependency packaging, including verified cross-platform `better-sqlite3` prebuilds.
- Modernized the dependencies, build and packaging pipeline, and added broader unit, integration, process and browser regression coverage.

The dashboard contains **Connection**, **Usage** and **Logs**. Analytics, request history, hypothetical savings and model-price calculations have been removed.

## Install

1. Stop shared API and tunnel in the previous build. Back up `~/.ungate` with services stopped: the upgrade migration removes the old request-history table. Account credentials, application settings and model mappings are preserved.
2. Install the supplied VSIX locally through **Extensions → Install from VSIX**, then reload the window. Node.js is required for the API; the existing verified native installer selects a supported host runtime.
3. Open **Ungate → Connection**, connect a provider and start the tunnel.
4. Copy the tunnel URL including `/v1` into **Cursor Settings → Models → Override OpenAI Base URL**. Enable the override and paste the saved Ungate API key into Cursor's OpenAI API Key field.
5. Choose a custom model ID configured under **Providers & models**. **Open Cursor Models** navigates to Cursor settings; it does not change the route or key automatically.

The model API key is mandatory. It authenticates model requests and is separate from provider credentials and the local administration capability.

Provider credentials are stored as plaintext in the local SQLite database under `~/.ungate`, protected with owner-only filesystem permissions. This protects against other OS users, not compromise of the same local user account, malware running as that user, or privileged access.

## Cursor models and SSH

To use built-in Cursor models, open **Cursor Models**, disable Cursor's Base URL override and select the built-in model. The misleading **Use Cursor Models**, **Use Ungate Models** and **Toggle OpenAI Key Fix** commands have been removed, together with the background SQLite reader and toggle loop. Automatic Base URL assignment and independent simultaneous routes are not implemented; no supported public setter/request-routing hook has been confirmed.

Install Ungate on the desktop client for Remote SSH. It runs in the local UI extension host, and local and SSH windows for the same local account share API and tunnel state. There is no requirement to keep another local project window open just to run the proxy. A live Remote SSH acceptance test is still required on the installed Cursor version.

Closing or reloading a window leaves shared services running and preserves the tunnel URL. **Restart Tunnel** creates a new connector; copy its newly reported URL into Cursor if it changes. **Restart Shared API** replaces the API from the requesting window and preserves a same-port tunnel. A mismatched API produces an **Update shared API** banner, not an unsupported Usage request. No automatic restart interrupts active chats. Use **Ungate: Stop Shared API and Tunnel** to stop them explicitly. Unknown legacy processes are not killed by name.

Cursor controls requests that do not reach Ungate. A green status is not evidence of a particular request's route or a guarantee of zero Cursor billing. Cloudflare documents that Quick Tunnels do not support SSE and have no uptime guarantee; native-chat streaming still depends on the tunnel service.

## Dashboard actions

**Models** and **Reload window** are in the header and editor toolbar. The **More actions** menu contains API restart, tunnel restart, tunnel-only stop, and **Stop API and tunnel · all windows**. Destructive shared actions explain their scope before execution. Advanced server settings and provider details are collapsed by default; the UI uses VS Code theme tokens.

A stopped shared service stays stopped across window reloads until explicitly started. Account Usage errors do not disable Connection, Logs or recovery actions. Matching release and protocol identities are required for management requests; older windows cannot use a newer API or downgrade it through the new lifecycle controller. Reload old extension windows after installing an update.

## Subscription Usage

The panel reuses connected credentials. It does not ask for another login or API key.

| Provider | Source | Limits |
| --- | --- | --- |
| ChatGPT / Codex | Existing OAuth token and account ID, first-party Codex usage endpoint | Internal backend interface; availability is account-dependent. Window duration and reset time come from the response. |
| Claude | Existing OAuth token, OAuth usage endpoint | Internal interface and scope-dependent access. Recognized five-hour and weekly windows are displayed separately. |
| MiniMax Global | Official M Plan remains endpoint, existing key | Only explicitly reported percentages are displayed. Undocumented time/count fields are not converted into invented limits. |
| MiniMax China or custom URL | No cross-region credential forwarding | Usage is marked unsupported until the corresponding contract is verified. |

A failed or missing response is not displayed as zero. The panel shows last update time, refresh failures and stale data explicitly. Live provider credentials were unavailable during development; successful access for an individual account is confirmed only by that account's response.

## Develop and package

Use Node 24 (`.nvmrc`) and the pnpm version pinned in `package.json`. Production API runtime support is separate from the development toolchain.

```sh
nvm install
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm browser:install
corepack pnpm package
```

If Linux browser dependencies are missing, install them explicitly with `corepack pnpm --filter @ungate/scripts exec playwright install --with-deps chromium`. Browser installation is a development requirement; VSIX users do not need Playwright.

With [Task](https://taskfile.dev/docs/installation) installed:

```sh
task setup
task check
task package
```

`Taskfile.yml` delegates to the same package scripts. Ordered operations run sequentially. The normal `package` command builds, checks types, lints, runs API/extension tests, exercises HTTP and real-process coordination, runs the built dashboard in Chromium, stages a clean extension, verifies actual VSIX entries and hashes, and smoke-tests the bundled API before publishing the artifact to `apps/extension/out/ungate-1.7.14.vsix`.

`corepack pnpm package:vsix` is a faster build-and-package command for iteration; it does not replace the complete `package` checks. `task install` explicitly runs checks and installs the verified package using Cursor CLI. Builds do not install or publish automatically.

An existing compatible browser can be selected with `UNGATE_CHROMIUM_EXECUTABLE_PATH`; `UNGATE_CHROMIUM_ARGS` accepts a JSON array for constrained test environments. The default uses Playwright's Chromium. No browser binary is shipped in VSIX.

The Node packaging pipeline replaces platform-specific shell copies. The legacy `scripts/build-package/run.sh` delegates to the same pipeline. Windows and macOS execution still require acceptance testing; Linux validation is recorded in the report.

## Credits

Ungate retains its upstream MIT license. Build/task, package-verification and lock patterns were adapted from [Cursor Chat Transit](https://github.com/oshokin/cursor-chat-transit). Selected protocol and authentication improvements were adapted from [inudder/ungate](https://github.com/inudder/ungate).
