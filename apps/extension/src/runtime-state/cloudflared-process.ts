import { LOOPBACK_HOST } from '@ungate/shared';

/** Origin matching complements, never replaces, executable and launch-marker ownership. */
export class CloudflaredProcess {
	static servesApiPort(command: string, port: number | null): boolean {
		const args = command
			.split(/\s+|\0/)
			.filter(Boolean)
			.map((arg) => arg.replace(/^["']|["']$/g, ''));

		return args.some((arg, index) => {
			const value = arg.startsWith('--url=') ? arg.slice('--url='.length) : args[index - 1] === '--url' ? arg : null;
			if (!value) return false;

			return port === null ? /^http:\/\/127\.0\.0\.1:\d+$/.test(value) : value === `http://${LOOPBACK_HOST}:${port}`;
		});
	}
}
