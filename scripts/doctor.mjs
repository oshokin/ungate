import { readFileSync } from 'node:fs';

const expected = readFileSync(new URL('../.nvmrc', import.meta.url), 'utf8').trim();
const major = expected.split('.')[0];
if (process.versions.node.split('.')[0] !== major) {
	console.error(`Development requires Node ${major}.x (${expected} in .nvmrc). Current: ${process.versions.node}`);
	process.exitCode = 1;
} else console.log(`Node ${process.versions.node}; use corepack pnpm to select the packageManager version from package.json.`);
