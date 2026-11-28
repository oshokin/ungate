/** Read endpoint addresses only from ngrok's JSON tunnel-start records. */
export class NgrokUrl {
	static read(line: string): string | null {
		const trimmed = line.trim();

		if (trimmed.startsWith('{')) {
			try {
				const parsed = JSON.parse(trimmed) as { url?: unknown; msg?: unknown };
				// Other records contain URLs for updates, login and errors, not a tunnel.
				if (parsed.msg !== 'started tunnel') return null;
				const direct = typeof parsed.url === 'string' ? parsed.url : null;

				return NgrokUrl.normalize(direct);
			} catch {
				return null;
			}
		}

		// Production launches with JSON logs; do not discover addresses in prose.
		return null;
	}

	private static normalize(value: string | null): string | null {
		if (!value) return null;

		try {
			const url = new URL(value);

			return url.protocol === 'https:' &&
				!url.username &&
				!url.password &&
				!url.port &&
				url.pathname === '/' &&
				!url.search &&
				!url.hash
				? url.origin
				: null;
		} catch {
			return null;
		}
	}
}
