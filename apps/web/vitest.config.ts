import { fileURLToPath } from 'node:url';

import base from '@ungate/dev-kit/vitest';
import { mergeConfig } from 'vitest/config';

export default mergeConfig(base, {
	resolve: {
		alias: { $shared: fileURLToPath(new URL('./src/shared', import.meta.url)) }
	},
	test: {
		dir: 'tests',
		pool: 'threads'
	}
});
