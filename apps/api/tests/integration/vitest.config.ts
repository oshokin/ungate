import baseConfig from '@ungate/dev-kit/vitest';
import { mergeConfig } from 'vitest/config';

export default mergeConfig(baseConfig, {
	resolve: {
		tsconfigPaths: true
	},
	test: {
		dir: 'tests/integration',
		fileParallelism: false,
		silent: 'passed-only',
		include: ['tests/integration/**/*.test.ts'],
		setupFiles: ['tests/integration/vitest.setup.ts'],
		globalSetup: ['tests/integration/global-setup.ts'],
		server: {
			deps: {
				external: ['better-sqlite3']
			}
		}
	}
});
