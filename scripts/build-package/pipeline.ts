import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { repoDir, runNode, runPnpm } from './process';
import { verifyPackage } from './verify';

export function build(): void {
	runNode(['scripts/doctor.mjs']);
	for (const name of ['@ungate/dev-kit', '@ungate/shared', '@ungate/api', '@ungate/web', 'ungate'])
		runPnpm(['--filter', name, 'run', 'build']);
	runPnpm(['--filter', '@ungate/api', 'run', 'build:bundle']);
}

export function check(): void {
	build();
	runPnpm(['--filter', 'ungate', 'exec', 'tsc', '--noEmit', '-p', 'tsconfig.build.json']);
	runPnpm(['--filter', '@ungate/scripts', 'exec', 'tsc', '--noEmit', '-p', 'tsconfig.json']);
	runPnpm(['--filter', '@ungate/web', 'run', 'check']);
	runPnpm(['-r', 'run', 'lint']);
	runPnpm(['--filter', 'ungate', 'test']);
	runPnpm(['--filter', '@ungate/api', 'test']);
	runPnpm(['--filter', '@ungate/web', 'test']);
	runNode(['apps/api/tests/runtime-smoke.mjs']);
	runPnpm([
		'--filter',
		'@ungate/api',
		'exec',
		'esbuild',
		'../extension/tests/fixtures/coordination-worker.ts',
		'--bundle',
		'--platform=node',
		'--format=cjs',
		`--outfile=${join(tmpdir(), 'ungate-coordination-worker.cjs')}`
	]);
	runNode(['apps/extension/tests/coordination-smoke.mjs', join(tmpdir(), 'ungate-coordination-worker.cjs')]);
	if (!process.env.UNGATE_CHROMIUM_EXECUTABLE_PATH)
		runPnpm(['--filter', '@ungate/scripts', 'exec', 'playwright', 'install', 'chromium']);
	runPnpm(['--filter', '@ungate/scripts', 'run', 'test:dashboard']);
}

export async function packageVsix(): Promise<string> {
	const extension = join(repoDir, 'apps/extension');
	const manifest = JSON.parse(readFileSync(join(extension, 'package.json'), 'utf8')) as { version: string };
	const directory = mkdtempSync(join(tmpdir(), 'ungate-vsix-'));
	const stage = join(directory, 'extension');
	mkdirSync(stage);
	const candidate = join(directory, 'candidate.vsix');
	const outputDir = join(extension, 'out');
	mkdirSync(outputDir, { recursive: true });
	const output = join(outputDir, `ungate-${manifest.version}.vsix`);
	try {
		for (const name of ['package.json', '.vscodeignore', 'resources', 'dist'])
			cpSync(join(extension, name), join(stage, name), { recursive: true });
		for (const name of ['LICENSE', 'README.md', 'CHANGELOG.md']) cpSync(join(repoDir, name), join(stage, name));
		cpSync(join(repoDir, 'apps/api/bundle'), join(stage, 'bundled/api/bundle'), { recursive: true });
		cpSync(join(repoDir, 'apps/api/drizzle'), join(stage, 'bundled/api/drizzle'), { recursive: true });
		cpSync(join(repoDir, 'apps/web/dist'), join(stage, 'bundled/web/dist'), { recursive: true });
		const requireApi = createRequire(join(repoDir, 'apps/api/package.json'));
		const native = dirname(requireApi.resolve('better-sqlite3/package.json'));
		const addonApi = dirname(createRequire(join(native, 'package.json')).resolve('node-addon-api/package.json'));
		for (const [name, source] of [
			['better-sqlite3', native],
			['node-addon-api', addonApi]
		]) {
			const target = join(stage, 'bundled/api/node_modules', name);
			cpSync(source, target, { recursive: true, dereference: true });
			for (const development of ['build', 'deps', 'src', 'docs', 'test', 'tests', 'benchmark'])
				rmSync(join(target, development), { recursive: true, force: true });
		}
		writeFileSync(
			join(stage, 'bundled/build-info.json'),
			JSON.stringify({ version: manifest.version, node: process.versions.node, builtAt: new Date().toISOString() }, null, 2)
		);
		const requireExtension = createRequire(join(extension, 'package.json'));
		const vsceRoot = dirname(requireExtension.resolve('@vscode/vsce/package.json'));
		const vsce = JSON.parse(readFileSync(join(vsceRoot, 'package.json'), 'utf8')) as { bin: { vsce: string } };
		runNode([join(vsceRoot, vsce.bin.vsce), 'package', '--no-dependencies', '--out', candidate], stage);
		await verifyPackage(candidate);
		const binding = join(native, 'prebuilds', `${process.platform}-${process.arch}.node`);
		runNode(['apps/api/tests/runtime-smoke.mjs'], repoDir, {
			UNGATE_SMOKE_ENTRY: join(stage, 'bundled/api/bundle/main.cjs'),
			UNGATE_BETTER_SQLITE3_NATIVE_BINDING: binding,
			DRIZZLE_PATH: join(stage, 'bundled/api/drizzle')
		});
		const pending = join(outputDir, `.ungate-${process.pid}.pending`);
		try {
			copyFileSync(candidate, pending);
			renameSync(pending, output);
		} finally {
			rmSync(pending, { force: true });
		}
		console.log(`Package verified: ${output}`);

		return output;
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
