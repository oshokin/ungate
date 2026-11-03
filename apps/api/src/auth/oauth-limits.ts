import { minutesToMilliseconds, secondsToMilliseconds } from 'date-fns';

/** Bound for one token exchange or refresh. The browser is waiting on this call. */
export const OAUTH_HTTP_TIMEOUT_MS = secondsToMilliseconds(10);

/** How long a started login, including the local Codex callback, stays valid. */
export const OAUTH_LOGIN_TTL_MS = minutesToMilliseconds(10);

/** Used when a token response omits expires_in. OAuth access tokens are commonly one hour. */
export const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
