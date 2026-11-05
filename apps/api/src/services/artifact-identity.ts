import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

let cachedDigest: string | null | undefined;

/** SHA-256 of the JavaScript entry Node is executing. */
export function runningApiArtifactDigest(): string | null {
	if (cachedDigest !== undefined) return cachedDigest;
	try {
		cachedDigest = createHash('sha256').update(readFileSync(process.argv[1])).digest('hex');
	} catch {
		cachedDigest = null;
	}

	return cachedDigest;
}
