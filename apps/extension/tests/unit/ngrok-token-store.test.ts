import { describe, expect, it } from 'vitest';

import { NgrokTokenStore, type NgrokSecretStorage } from '../../src/ngrok-token-store';

function memorySecrets(): NgrokSecretStorage & { values: Map<string, string> } {
	const values = new Map<string, string>();

	return {
		values,
		get: (key) => Promise.resolve(values.get(key)),
		store: (key, value) => {
			values.set(key, value);

			return Promise.resolve();
		}
	};
}

describe('NgrokTokenStore', () => {
	it('saves a trimmed token and reports only whether one exists', async () => {
		const secrets = memorySecrets();
		const store = new NgrokTokenStore(secrets);
		const initiallySet = await store.isSet();
		expect(initiallySet).toBe(false);
		await store.save('  token-value  ');
		const stored = await store.read();
		expect(stored).toBe('token-value');
		const saved = await store.isSet();
		expect(saved).toBe(true);
		expect(secrets.values.size).toBe(1);
	});

	it('rejects an empty token', async () => {
		const store = new NgrokTokenStore(memorySecrets());
		await expect(store.save('   ')).rejects.toThrow('empty');
	});
});
