import baseConfig from '@ungate/dev-kit/vitest';
import { mergeConfig } from 'vitest/config';

export default mergeConfig(baseConfig, {
	resolve: {
		tsconfigPaths: true
	},
	test: {
		dir: 'tests/unit',
		server: {
			deps: {
				external: ['better-sqlite3']
			}
		}
	}
});
