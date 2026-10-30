import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as yauzl from 'yauzl';

import { dashboardActions } from '../../packages/shared/src/schemas/actions';
import { UNGATE_VERSION } from '../../packages/shared/src/service';

import { repoDir } from './process';

/** Validate actual ZIP bytes, not the directory that we hoped to package. */
export async function verifyPackage(file: string): Promise<void> {
	const entries = new Map<string, Buffer>();
	await new Promise<void>((resolve, reject) => {
		yauzl.open(file, { lazyEntries: true }, (error, zip) => {
			if (error || !zip) {
				reject(error ?? new Error('Missing VSIX'));

				return;
			}
			const fail = (cause: Error) => {
				zip.close();
				reject(cause);
			};
			zip.on('error', fail);
			zip.on('end', resolve);
			zip.on('entry', (entry: yauzl.Entry) => {
				if (entry.fileName.endsWith('/')) {
					zip.readEntry();

					return;
				}
				if (
					entries.has(entry.fileName) ||
					entry.fileName.includes('..') ||
					entry.fileName.startsWith('/') ||
					entry.uncompressedSize > 20 * 1024 * 1024
				) {
					fail(new Error(`Unsafe VSIX entry: ${entry.fileName}`));

					return;
				}
				zip.openReadStream(entry, (cause, stream) => {
					if (cause || !stream) {
						fail(cause ?? new Error('Missing archive entry'));

						return;
					}
					const chunks: Buffer[] = [];
					stream.on('data', (chunk: Buffer) => {
						chunks.push(chunk);
					});
					stream.on('error', fail);
					stream.on('end', () => {
						entries.set(entry.fileName, Buffer.concat(chunks));
						zip.readEntry();
					});
				});
			});
			zip.readEntry();
		});
	});
	for (const required of [
		'extension/package.json',
		'extension/dist/extension.js',
		'extension/bundled/api/bundle/main.cjs',
		'extension/bundled/api/drizzle/_0010.sql',
		'extension/bundled/web/dist/index.html',
		'extension/bundled/api/node_modules/better-sqlite3/lib/database.js',
		'extension/bundled/api/node_modules/better-sqlite3/prebuilds/linux-x64.node',
		'extension/bundled/api/node_modules/node-addon-api/package.json',
		'extension/readme.md',
		'extension/changelog.md'
	]) {
		if (!entries.has(required)) throw new Error(`Missing packaged file: ${required}`);
	}
	for (const platform of ['darwin', 'linux', 'linuxmusl', 'win32']) {
		for (const arch of ['x64', 'arm64']) {
			const native = `extension/bundled/api/node_modules/better-sqlite3/prebuilds/${platform}-${arch}.node`;
			if (!entries.has(native)) throw new Error(`Missing packaged SQLite prebuild: ${platform}-${arch}`);
		}
	}

	// vsce normalizes LICENSE to LICENSE.txt in current package output.
	const license = entries.get('extension/LICENSE.txt') ?? entries.get('extension/LICENSE');
	if (!license?.equals(readFileSync(join(repoDir, 'LICENSE')))) throw new Error('Packaged license does not match source');
	for (const name of entries.keys())
		if (
			(/\.(?:node|db|sqlite|pem)$/.test(name) &&
				!/^extension\/bundled\/api\/node_modules\/better-sqlite3\/prebuilds\/(?:darwin|linux|linuxmusl|win32)-(?:arm64|x64)\.node$/.test(
					name
				)) ||
			/(?:^|\/)\.env(?:$|\.)/.test(name) ||
			name.includes('/src/') ||
			name.includes('/tests/')
		)
			throw new Error(`Unexpected private or development file in VSIX: ${name}`);
	const source = JSON.parse(readFileSync(join(repoDir, 'apps/extension/package.json'), 'utf8')) as {
		version: string;
		publisher: string;
		name: string;
	};
	const manifest = JSON.parse(entries.get('extension/package.json')!.toString()) as {
		version: string;
		publisher: string;
		name: string;
		extensionKind: string[];
		contributes: { commands: { command: string; title: string }[] };
	};
	if (
		manifest.version !== UNGATE_VERSION ||
		manifest.version !== source.version ||
		manifest.publisher !== source.publisher ||
		manifest.name !== source.name ||
		JSON.stringify(manifest.extensionKind) !== '["ui"]'
	)
		throw new Error('Packaged identity, version or extension host does not match source');
	const definitions = manifest.contributes.commands;
	for (const action of Object.values(dashboardActions)) {
		if (!definitions.some((entry) => entry.command === action.command && entry.title === action.title))
			throw new Error(`Missing or inconsistent command: ${action.command}`);
	}
	if (definitions.some((entry) => /toggleKeyFix|useCursorModels|useUngateModels/.test(entry.command)))
		throw new Error('Obsolete routing commands in VSIX');
	for (const [packaged, local] of [
		['extension/dist/extension.js', 'apps/extension/dist/extension.js'],
		['extension/bundled/api/bundle/main.cjs', 'apps/api/bundle/main.cjs']
	]) {
		const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
		if (digest(entries.get(packaged)!) !== digest(readFileSync(join(repoDir, local))))
			throw new Error(`Stale packaged build: ${packaged}`);
	}
	const html = entries.get('extension/bundled/web/dist/index.html')!.toString();
	for (const match of html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g))
		if (!entries.has(`extension/bundled/web/dist${match[1]}`)) throw new Error(`Missing web asset: ${match[1]}`);
	console.log(
		JSON.stringify({
			check: 'vsix',
			status: 'PASS',
			files: entries.size,
			version: source.version,
			identity: `${source.publisher}.${source.name}`,
			hashesMatch: true
		})
	);
}
