import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const result = spawnSync(
	process.execPath,
	[
		'--import',
		pathToFileURL(require.resolve('tsx')).href,
		fileURLToPath(new URL('./build-package/main.ts', import.meta.url)),
		...process.argv.slice(2)
	],
	{ stdio: 'inherit', env: process.env }
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
