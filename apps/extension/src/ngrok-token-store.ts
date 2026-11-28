const SECRET_KEY = 'ungate.ngrokAuthToken';
/** Rejects a pasted value that cannot be an ngrok authtoken. */
const MAX_TOKEN_LENGTH = 512;

/** SecretStorage view the token store needs. Tests pass a fake; production passes ExtensionContext.secrets. */
export interface NgrokSecretStorage {
	get(key: string): Thenable<string | undefined>;
	store(key: string, value: string): Thenable<void>;
}

/** Secret storage for a TunnelManager built without an extension context. */
export class UnavailableNgrokSecrets implements NgrokSecretStorage {
	get(): Thenable<string | undefined> {
		return Promise.resolve(undefined);
	}

	store(): Thenable<void> {
		return Promise.resolve();
	}
}

/**
 * The ngrok authtoken never enters the settings API. That route is reachable through the public
 * tunnel, so the token lives in the extension's secret storage. The dashboard receives it only
 * to show the same masked field as the Ungate API key.
 */
export class NgrokTokenStore {
	constructor(private readonly secrets: NgrokSecretStorage) {}

	async read(): Promise<string | null> {
		const stored = await this.secrets.get(SECRET_KEY);
		const token = stored?.trim();
		if (!token) return null;

		return token;
	}

	async isSet(): Promise<boolean> {
		const token = await this.read();

		return token !== null;
	}

	async save(token: string): Promise<void> {
		const trimmed = token.trim();

		if (!trimmed || trimmed.length > MAX_TOKEN_LENGTH) {
			throw new Error('The ngrok authtoken is empty or too long.');
		}

		await this.secrets.store(SECRET_KEY, trimmed);
	}
}
