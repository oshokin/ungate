# Subscription Usage

The dashboard reuses connected credentials; no additional login or API key is
requested. It shows subscription snapshots, not request history or local costs.

Refresh is manual by default. Enable **Automatically refresh** for background
updates even when the dashboard is closed. The application-wide interval defaults
to **60 seconds**, accepts whole seconds from **15–3600**, and saves on blur or
Enter; Escape restores the saved value. With automatic refresh enabled, each
connected provider has an independent **Show in status bar** checkbox, all off
by default. Disabling automatic refresh hides items without forgetting selections.

Each provider item shows its most restrictive reported basic window, using its
actual duration and conservatively rounded percentage **left**. Additional pools
remain in Usage and the tooltip. Stale figures are marked explicitly. Reset dates
describe usage windows, not subscription expiry; disconnected accounts are omitted.

One extension-host snapshot feeds both views. Only the runtime leader polls
providers; other windows read the API's memory cache. Manual refresh shares
server-side single-flight and rate limiting. No usage history is persisted.

## Provider sources and limits

- **ChatGPT / Codex:** existing OAuth token and account ID, first-party Codex
  usage endpoint. This internal interface is account-dependent; window duration
  and reset time come from the response.
- **Claude:** existing OAuth token and OAuth usage endpoint. This internal
  interface depends on scopes. Recognized five-hour and weekly windows appear
  separately.
- **MiniMax Global:** official M Plan remains endpoint and existing key. Only
  explicitly reported percentages are shown; undocumented time/count fields
  are not converted into invented limits.
- **MiniMax China or custom URL:** unsupported until the corresponding contract
  is verified. Credentials are not forwarded across regions.

A failed or missing response is not shown as zero. Last update time, refresh
failures and stale data are explicit. Live provider credentials were unavailable
during development; successful access is confirmed only by the account's response.

See [runtime and operations](runtime-and-operations.md) for shared-service and
recovery behavior, or return to the [README](../README.md).
