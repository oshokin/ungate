# Ungate — my fork based on 1.7.14

Use Claude and ChatGPT/Codex subscriptions or a MiniMax API key in Cursor's native chat through a local proxy and a public tunnel. This is my fork of [orchidfiles/ungate](https://github.com/orchidfiles/ungate), not an official Marketplace release. Provider access and limits depend on the connected account or plan; this does not turn a subscription into unrestricted API access.

## Why this fork

The original extension worked unreliably in my setup, and its routing, process lifecycle and interaction with Cursor were difficult to understand and troubleshoot. I audited and refactored the project, fixed the failures I encountered, and added the behavior, diagnostics and safeguards I considered missing.

## Features

- Reworked API and tunnel lifecycle management so local and Remote SSH windows share state safely without unexpectedly stopping active services.
- Corrected provider routing and request/stream conversion for Claude, ChatGPT/Codex and MiniMax, including tool calls and reasoning variants.
- Simplified and hardened the Cursor integration by removing unsupported key/database manipulation and making model configuration explicit.
- Redesigned the dashboard around connection management, subscription usage and actionable logs; removed request tracking, price estimates and speculative analytics.
- Hardened credentials, local storage and verified cross-platform dependency packaging.
- Modernized dependencies and added unit, integration, process and browser regression coverage.

The dashboard contains **Connection**, **Usage** and **Logs**. Analytics, request history, hypothetical savings and model-price calculations have been removed.

## Requirements

- Cursor desktop; install Ungate locally even for Remote SSH.
- Standalone x64/arm64 Node.js with Node-API 10 (Node 22.14+); **Node.js 24 LTS recommended**. Ungate discovers Node but does not install it.
- A connected Claude or ChatGPT/Codex account, or a MiniMax API key, and a public tunnel: Cursor's backend cannot reach localhost.

See [runtime setup and troubleshooting](docs/runtime-and-operations.md) for supported platforms, Node selection and Remote SSH caveats.

## Install

1. Stop shared API and tunnel in the previous build. Back up `~/.ungate` with services stopped: the upgrade migration removes the old request-history table. Account credentials, application settings and model mappings are preserved.
2. Install the supplied VSIX locally through **Extensions → Install from VSIX**, then reload the window. Install a supported standalone Node.js runtime yourself if needed; startup validates it and selects a bundled SQLite prebuild.
3. Open **Ungate → Connection**, connect a provider and start the tunnel.
4. Copy the tunnel URL including `/v1` into **Cursor Settings → Models → Override OpenAI Base URL**. Enable the override and paste the saved Ungate API key into Cursor's OpenAI API Key field.
5. Choose a custom model ID configured under **Providers & models**. **Open Cursor Models** navigates to Cursor settings; it does not change the route or key automatically.

## Security and limitations

The model API key is mandatory and separate from provider credentials and the local administration token. Keep it private: the tunnel exposes model endpoints publicly. Provider credentials are plaintext in `~/.ungate`, protected by owner-only filesystem permissions—not against same-user malware or privileged access.

Closing a window leaves shared services running; use **Ungate: Stop Shared API and Tunnel** to stop them. A green status does not prove a request's route or guarantee zero Cursor billing. Quick Tunnels have no uptime guarantee; streaming depends on the tunnel service. See [operations and security boundaries](docs/runtime-and-operations.md).

## Develop and package

Use Node 24 (`.nvmrc`) and the pnpm version pinned in `package.json`:

```sh
nvm install
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm browser:install
corepack pnpm package
```

The verified VSIX is written to `apps/extension/out/ungate-1.7.14.vsix`. Builds do not install or publish automatically. Task equivalents are `task setup`, `task check` and `task package`; see [development and packaging](docs/development.md) for prerequisites, faster iteration and acceptance limits.

## Documentation

- [Runtime and operations](docs/runtime-and-operations.md): Node troubleshooting, credentials, shared services, SSH and dashboard controls.
- [Subscription Usage](docs/subscription-usage.md): refresh, status-bar widgets and provider limitations.
- [Provider protocols](docs/provider-protocols.md): routing, endpoint and tool compatibility boundaries.
- [Caching and accounting](docs/claude-caching.md): policies, reported counters and verification limits.
- [Cursor compatibility evidence](docs/cursor-compatibility.md): build-specific observations and historical checks.
- [Development and packaging](docs/development.md): test pipeline and VSIX verification.

## Credits

Ungate retains its upstream MIT license. Build/task, package-verification and lock patterns were adapted from [Cursor Chat Transit](https://github.com/oshokin/cursor-chat-transit).
