import { createHash } from 'node:crypto';

/** Codex item types whose call_id must fit the upstream length limit. */
const CALL_ITEM_TYPES = new Set(['function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output']);
/** Upstream maximum length of one Codex call_id. */
export const MAX_CODEX_CALL_ID_CHARS = 64;
/** Hex characters of SHA-256 kept when a call_id is shortened. */
export const CALL_ID_HASH_HEX_CHARS = 16;
/** Prefix kept so prefix, underscore and hash still fit in the upstream limit. */
export const CALL_ID_PREFIX_CHARS = MAX_CODEX_CALL_ID_CHARS - CALL_ID_HASH_HEX_CHARS - 1;

export function normalizeCodexCallId(id: string): string {
	if (id.length <= MAX_CODEX_CALL_ID_CHARS) {
		return id;
	}

	return `${id.slice(0, CALL_ID_PREFIX_CHARS)}_${createHash('sha256').update(id).digest('hex').slice(0, CALL_ID_HASH_HEX_CHARS)}`;
}

// Upstream constrains call_id to 1-64 characters with no character-set rule. An empty id is
// dropped rather than synthesized: every empty id would hash to the same value and cross-pair
// unrelated calls, and an unpaired output is already discarded downstream.
export function remapCodexCallIds(items: Record<string, unknown>[]): Record<string, unknown>[] {
	const remapped: Record<string, unknown>[] = [];

	for (const item of items) {
		if (typeof item.type !== 'string' || !CALL_ITEM_TYPES.has(item.type)) {
			remapped.push(item);
			continue;
		}

		if (typeof item.call_id !== 'string') {
			remapped.push(item);
			continue;
		}

		if (item.call_id === '') {
			continue;
		}

		remapped.push({ ...item, call_id: normalizeCodexCallId(item.call_id) });
	}

	return remapped;
}
