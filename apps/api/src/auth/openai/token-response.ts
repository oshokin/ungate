import { MILLISECONDS_PER_SECOND } from '@ungate/shared';

import { OpenAILoginError } from './login-error';

export const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
/** ECMAScript Date TimeClip range, not an OAuth provider policy. */
const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;

export async function readTokenResponse(response: Response): Promise<Record<string, unknown>> {
	const invalid = () => new OpenAILoginError('invalid_token_response');
	if (Number(response.headers.get('content-length')) > MAX_TOKEN_RESPONSE_BYTES) {
		void response.body?.cancel().catch(() => {});
		throw invalid();
	}
	if (!response.body) throw invalid();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_TOKEN_RESPONSE_BYTES) {
				void reader.cancel().catch(() => {});
				throw invalid();
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	let payload: unknown;
	try {
		payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
	} catch {
		throw invalid();
	}
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalid();
	const tokens = payload as Record<string, unknown>;
	const expiresAt = typeof tokens.expires_in === 'number' ? Date.now() + tokens.expires_in * MILLISECONDS_PER_SECOND : undefined;
	if (
		typeof tokens.access_token !== 'string' ||
		!tokens.access_token.trim() ||
		(tokens.refresh_token !== undefined && (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token.trim())) ||
		(tokens.id_token !== undefined && typeof tokens.id_token !== 'string') ||
		(tokens.expires_in !== undefined &&
			(typeof tokens.expires_in !== 'number' ||
				!Number.isFinite(tokens.expires_in) ||
				tokens.expires_in <= 0 ||
				!Number.isSafeInteger(Math.ceil(expiresAt!)) ||
				expiresAt! > MAX_DATE_TIMESTAMP_MS))
	)
		throw invalid();

	return tokens;
}
