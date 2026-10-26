import { createHash, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import { Readable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';

const USER_AGENT = 'ungate-extension';
const SHA256_HEX_LENGTH = 64;
const STAMP_SUFFIX = '.sha256';
export const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;

export interface PinnedArtifact {
	/** Absolute upstream release URL. Must point at an immutable, versioned artifact. */
	readonly url: string;
	/** Lowercase hex SHA-256 of the exact upstream bytes. */
	readonly sha256: string;
}

/**
 * Downloads pinned upstream artifacts and refuses to hand anything back until the
 * bytes hash to the expected SHA-256. Nothing is copied, chmod-ed or executed by
 * this module: callers only ever see a staging path that already passed verification.
 */
export class VerifiedArtifact {
	/**
	 * Streams `artifact` to `destPath` while hashing, then verifies the digest.
	 * On any failure the partial file is removed and the error is rethrown, so a
	 * rejected download can never leave a usable file behind.
	 */
	static async download(artifact: PinnedArtifact, destPath: string, maxBytes = MAX_ARTIFACT_BYTES): Promise<void> {
		const expected = this.parseDigest(artifact.sha256);
		const response = await fetch(artifact.url, {
			headers: { 'User-Agent': USER_AGENT },
			redirect: 'follow',
			signal: AbortSignal.timeout(120000)
		});

		if (!response.ok) {
			throw new Error(`Download failed for ${artifact.url}: HTTP ${response.status}`);
		}

		if (!response.body) {
			throw new Error(`Download failed for ${artifact.url}: empty response body`);
		}

		const hash = createHash('sha256');
		let received = 0;
		const destination = fs.createWriteStream(destPath);

		try {
			await pipeline(
				Readable.fromWeb(response.body),
				async function* (source: AsyncIterable<Uint8Array>) {
					for await (const chunk of source) {
						received += chunk.byteLength;
						if (received > maxBytes) throw new Error(`Installer download exceeds ${maxBytes}-byte size limit`);
						hash.update(chunk);
						yield chunk;
					}
				},
				destination
			);

			const actual = hash.digest();

			if (!timingSafeEqual(actual, expected)) {
				throw new Error(
					`Checksum mismatch for ${artifact.url}: expected sha256 ${artifact.sha256}, got ${actual.toString('hex')}. ` +
						'The artifact was rejected and discarded.'
				);
			}
		} catch (error) {
			destination.destroy();
			await finished(destination).catch(() => {});
			fs.rmSync(destPath, { force: true });
			throw error;
		}
	}

	/**
	 * Fail-closed error for a host tuple that has no pinned artifact. Unknown
	 * tuples must never trigger a download, so the message has to tell the user
	 * what is supported and how to work around the gap.
	 */
	static unsupportedError(subject: string, tuple: string, supported: readonly string[], remedy: string): Error {
		return new Error(
			`${subject} has no pinned, checksum-verified artifact for ${tuple}. ` +
				`Supported: ${[...supported].sort().join(', ')}. ${remedy}`
		);
	}

	private static parseDigest(sha256: string): Buffer {
		if (sha256.length !== SHA256_HEX_LENGTH || !/^[0-9a-f]+$/.test(sha256)) {
			throw new Error(`Malformed pinned SHA-256 digest: ${sha256}`);
		}

		return Buffer.from(sha256, 'hex');
	}
}

/**
 * Records which pinned artifact produced a managed binary in `~/.ungate/bin`.
 * Installs made before artifact pinning existed carry no stamp, so they are
 * treated as unverified and replaced instead of reused.
 */
export class InstallStamp {
	/** The recorded digest, or `null` when the binary carries no stamp at all. */
	static read(binaryPath: string): string | null {
		try {
			return fs.readFileSync(`${binaryPath}${STAMP_SUFFIX}`, 'utf8').trim();
		} catch {
			return null;
		}
	}

	static matches(binaryPath: string, artifact: PinnedArtifact): boolean {
		return this.read(binaryPath) === artifact.sha256;
	}

	static write(binaryPath: string, artifact: PinnedArtifact): void {
		fs.writeFileSync(`${binaryPath}${STAMP_SUFFIX}`, artifact.sha256, 'utf8');
	}
}
