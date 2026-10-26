import { defineConfig } from 'tsup';

export default defineConfig({
	entry: ['src/index.ts', 'src/frontend.ts'],
	outDir: 'lib',
	tsconfig: 'tsconfig.build.json',
	format: ['esm', 'cjs'],
	target: 'node22',
	bundle: true,
	splitting: false,
	sourcemap: true,
	clean: true,
	dts: true,
	outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' })
});
