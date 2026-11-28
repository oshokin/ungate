/** Extract ngrok's actionable reason without treating its help links as endpoints. */
export function ngrokFailure(lines: readonly string[]): string | null {
	let reason: string | null = null;
	let code: string | null = null;
	for (const line of lines) {
		let text: string;
		try {
			const raw = JSON.parse(line) as Record<string, unknown>;
			if (!['eror', 'error', 'crit', 'fatal'].includes(String(raw.lvl))) continue;
			text = typeof raw.err === 'string' ? raw.err : typeof raw.msg === 'string' ? raw.msg : '';
		} catch {
			if (!/^ERROR:\s*/.test(line)) continue;
			text = line.replace(/^ERROR:\s*/, '');
		}
		code ??= /\bERR_NGROK_\d+\b/.exec(text)?.[0] ?? null;
		reason ??=
			text
				.split(/\r?\n/)
				.map((part) => part.trim())
				.find((part) => part.length > 0 && !/^https?:\/\//i.test(part) && !/^ERR_NGROK_\d+$/.test(part)) ?? null;
	}

	return reason || code ? `ngrok: ${reason ?? 'Tunnel failed'}${code ? ` (${code})` : ''}` : null;
}

/** Redact credentials before errors or journal entries cross the extension boundary. */
export function redactNgrokToken(text: string, token?: string | null): string {
	return (token ? text.replaceAll(token, '[redacted]') : text).replace(
		/((?:authtoken|NGROK_AUTHTOKEN)\s*[=:]\s*)[^\s,;"']+/gi,
		'$1[redacted]'
	);
}
