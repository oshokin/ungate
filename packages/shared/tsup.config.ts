import { defineConfig, type Options } from 'tsup';

const shared: Omit<Options, 'entry'> = {
	outDir: 'lib',
	tsconfig: 'tsconfig.build.json',
	format: ['esm', 'cjs'],
	target: 'node22',
	bundle: true,
	splitting: false,
	sourcemap: true,
	dts: true,
	clean: false,
	outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' })
};

/** Separate entries so tsup does not emit a shared declaration chunk. The package script clears lib first. */
export default defineConfig([
	{ ...shared, entry: ['src/index.ts'] },
	{ ...shared, entry: ['src/frontend.ts'] }
]);
