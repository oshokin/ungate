import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type * as vscode from 'vscode';

/** Exact identity of the API bytes shipped by this extension build. */
export function apiArtifactDigest(context: vscode.ExtensionContext): string | undefined {
	if (!context.extensionPath) return undefined;
	const bundledEntry = path.join(context.extensionPath, 'bundled', 'api', 'bundle', 'main.cjs');
	const entry = fs.existsSync(bundledEntry) ? bundledEntry : path.join(context.extensionPath, '..', 'api', 'dist', 'main.js');

	try {
		return createHash('sha256').update(fs.readFileSync(entry)).digest('hex');
	} catch {
		return undefined;
	}
}
