import { MAX_MODEL_ID_CHARS } from 'src/schemas/proxy-requests';

import type { DiscoveredModel } from '@ungate/shared';

/** Largest catalog response body accepted from one provider page. */
const MAX_RESPONSE_BYTES = 1024 * 1024;
/** Models retained from one provider catalog. */
export const MAX_MODELS = 1000;
/** Catalog pages followed before discovery stops. */
export const MAX_PAGES = 10;

export interface ProviderCatalog {
	models: DiscoveredModel[];
	catalogComplete: boolean;
}

export class CatalogHttpError extends Error {
	constructor(readonly status: number) {
		super(`Provider catalog returned HTTP ${status}`);
	}
}

export async function readJson(response: Response): Promise<unknown> {
	if (!response.ok) {
		await response.body?.cancel();
		throw new CatalogHttpError(response.status);
	}

	const reader = response.body?.getReader();
	if (!reader) throw new Error('Provider catalog response has no body');
	const chunks: Uint8Array[] = [];
	let bytes = 0;

	try {
		while (true) {
			const part = await reader.read();
			if (part.done) break;
			bytes += part.value.byteLength;
			if (bytes > MAX_RESPONSE_BYTES) {
				await reader.cancel();
				throw new Error('Provider catalog response exceeds 1 MiB');
			}
			chunks.push(part.value);
		}
	} finally {
		reader.releaseLock();
	}

	return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export function model(id: unknown, label: unknown): DiscoveredModel | null {
	if (typeof id !== 'string') return null;
	const upstreamModel = id.trim();
	if (!upstreamModel || upstreamModel.length > MAX_MODEL_ID_CHARS) return null;
	const displayLabel = typeof label === 'string' && label.trim() ? label.trim().slice(0, MAX_MODEL_ID_CHARS) : upstreamModel;

	return { id: upstreamModel, label: displayLabel, upstreamModel };
}

export function uniqueModels(models: DiscoveredModel[]): DiscoveredModel[] {
	const unique = new Map<string, DiscoveredModel>();
	for (const item of models) {
		if (!unique.has(item.upstreamModel)) unique.set(item.upstreamModel, item);
		if (unique.size >= MAX_MODELS) break;
	}

	return [...unique.values()];
}
