# Runtime and operations

See the [README installation steps](../README.md#install) first.

## Node.js startup on Windows, macOS and Linux

The API needs standalone x64/arm64 Node.js with Node-API 10 (Node 22.14+);
Node.js 24 LTS is recommended. Cursor's embedded Electron Node is not used as
a separate server runtime. Ungate discovers Node; it does not install it.

If Node is missing, install [Node.js 24 LTS](https://nodejs.org/en/download),
completely quit Cursor and reopen it. A window reload may retain the old
application environment. If an installed runtime is not detected, use
**Choose Node.js** in the error banner or **Ungate: Choose Node.js Executable**.
Select `node.exe` on Windows (often `C:\Program Files\nodejs\node.exe`) or
`node` on Linux/macOS. Validation precedes saving the canonical path in the
local machine setting `ungate.nodePath`; cancellation or failure preserves it.

Selection order is explicit local `ungate.nodePath`, then `UNGATE_NODE_BIN`,
then automatic discovery. Workspace settings cannot override the executable.
Discovery checks PATH, standard OS installations, nvm/nvm-windows, fnm, Volta
and Unix asdf without launching a shell. An invalid explicit override fails
instead of silently choosing another runtime. SQLite is load-tested before startup.

PowerShell diagnostics:

```powershell
where.exe node
node -p "JSON.stringify({version:process.version,napi:process.versions.napi,exe:process.execPath})"
```

macOS/Linux diagnostics:

```sh
command -v node
node -p 'JSON.stringify({version:process.version,napi:process.versions.napi,exe:process.execPath})'
```

SQLite prebuilds ship in the VSIX. Supported targets are x64/arm64 Windows,
macOS, glibc Linux and musl Linux; startup selects the runtime's platform,
architecture and libc. Unsupported targets fail closed, without native builds
or downloads. Cloudflared is downloaded separately and SHA-256 verified.

## Credentials and local administration

Claude uses OAuth with manual `CODE#STATE` entry. ChatGPT/Codex uses OAuth
with a local callback on port **1455**. MiniMax uses an API key and an official
Global or China base URL, not OAuth.

The production database is `~/.ungate/data.db`; development uses a separate
database only when `DB_PATH` is explicitly set. Credentials are plaintext with
owner-only permissions, not protection against same-user malware or privileged
access. Back up `~/.ungate` with services stopped before upgrades: migration
removes request history but preserves accounts, settings and model mappings.

The API listens on IPv4 loopback. The dashboard sends validated allowlisted
messages to the local extension host, which authenticates administration
requests. The webview has neither direct HTTP access nor the administration
token. The public tunnel exposes model endpoints authenticated by the model
API key. `/health` is unauthenticated; management requires a separate token.

## Cursor models, tunnels and Remote SSH

Cursor's backend cannot reach localhost; a public tunnel is required. Start
the tunnel explicitly. To use built-in Cursor models, open **Cursor Models**,
disable the Base URL override and select the built-in model. Automatic Base URL
assignment and independent simultaneous routes are not implemented; no public
setter/request-routing hook has been confirmed. The misleading **Use Cursor
Models**, **Use Ungate Models** and **Toggle OpenAI Key Fix** commands, background
SQLite reader and toggle loop were removed.

Install Ungate on the desktop client for Remote SSH. It runs in the local UI
extension host; local and SSH windows for the same local account share API and
tunnel state. No second local project window is required. Live Remote SSH
acceptance still needs verification on the installed Cursor version.

Closing or reloading a window leaves shared services and the tunnel URL intact.
**Restart Tunnel** creates a new connector; copy its newly reported URL into
Cursor if it changes. **Restart Shared API** replaces the API from the
requesting window and preserves a same-port tunnel. A mismatch produces an
**Update shared API** banner, not an unsupported Usage request. No automatic
restart interrupts active chats. **Ungate: Stop Shared API and Tunnel** stops
them explicitly; unknown legacy processes are not killed by name.

Cursor controls requests that do not reach Ungate. A green status does not
prove a request's route or guarantee zero Cursor billing. Cloudflare documents
that Quick Tunnels do not support SSE and have no uptime guarantee; native-chat
streaming still depends on the tunnel service.

## Dashboard actions and logs

**Models** and **Reload window** appear in the header and editor toolbar.
**More actions** contains API restart, tunnel restart, tunnel-only stop and
**Stop API and tunnel · all windows**. Destructive actions explain their scope.
Advanced server settings and provider details are collapsed by default.

A stopped service stays stopped across reloads until explicitly started.
Usage errors do not disable Connection, Logs or recovery actions. Management
requires matching release/protocol identities. Older windows cannot use a newer
API or downgrade it through the new lifecycle controller; reload old extension
windows after installing updates.

Startup log tags are `[runtime]` (Node discovery), `[sqlite]` (native module)
and `[process]` (server lifecycle); user-facing errors omit component tags.
**Ungate › Logs: Max Entries** (`ungate.logs.maxEntries`) controls recent entries
per source: default **500**, range **100–5000**. This applies across local and
SSH windows without restarting services, independently of journal-file retention.

```json
{
  "ungate.logs.maxEntries": 1000
}
```

Both log panels resize independently by drag handle or keyboard: Up/Down,
Shift for larger steps, Home/End for bounds. Heights survive page changes and
webview reloads; **Reset height** restores defaults. Opening Logs or revealing
the retained dashboard starts at the latest entry. Scrolling up pauses following
and counts new entries; clicking the count returns to the tail. **Clear** starts
a new following session even if the next update is a history snapshot. Increasing
the limit loads older history without counting it as new; live entries still count.

The dashboard, including auth, Usage, model tables, controls, tooltips, dialogs
and logs, uses paired VS Code theme tokens, not a Skeleton/Wintry palette.
Editor theme changes update the panel and native controls independently of OS
color preference. Browser audits cover controls, menus and tooltips at 320,
420 and 580 CSS pixels, keyboard focus, Escape dismissal and viewport bounds.
Windows forced-colors is tested separately from editor high-contrast themes.
