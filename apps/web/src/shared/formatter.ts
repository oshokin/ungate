/** Threshold at which a latency switches from milliseconds to seconds. */
const MILLISECONDS_PER_SECOND = 1000;

export class Formatter {
	static number(value: number): string {
		return value.toLocaleString();
	}

	static cost(value: number): string {
		return `$${value.toFixed(2)}`;
	}

	static date(timestamp: number): string {
		return new Date(timestamp).toLocaleString();
	}

	static time(timestamp: number): string {
		return new Date(timestamp).toLocaleTimeString('en-US', {
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	static latency(ms: number | null): string {
		if (ms === null) {
			return '';
		}

		if (ms < MILLISECONDS_PER_SECOND) {
			return `${ms}ms`;
		}

		return `${(ms / MILLISECONDS_PER_SECOND).toFixed(1)}s`;
	}
}
