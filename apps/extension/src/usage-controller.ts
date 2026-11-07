import { USAGE_REFRESH, type UsagePreferences, type UsageState, type SubscriptionUsage } from '@ungate/shared/frontend';
import * as vscode from 'vscode';

export function usagePreferences(): UsagePreferences {
	const configuration = vscode.workspace.getConfiguration('ungate');
	const read = <T>(key: string) => configuration.inspect<T>(`usage.${key}`)?.globalValue;
	const interval = read<number>('intervalSeconds');

	return {
		autoRefresh: read<boolean>('autoRefresh') === true,
		intervalSeconds:
			Number.isInteger(interval) && interval! >= USAGE_REFRESH.minSeconds && interval! <= USAGE_REFRESH.maxSeconds
				? interval!
				: USAGE_REFRESH.defaultSeconds,
		widgets: {
			claude: read<boolean>('widgets.claude') === true,
			openai: read<boolean>('widgets.openai') === true,
			minimax: read<boolean>('widgets.minimax') === true
		}
	};
}

/** One sequential polling loop per extension host; only the existing runtime leader refreshes providers. */
export class UsageController {
	state: UsageState = { data: null, preferences: usagePreferences(), loading: false, error: null, nextUpdate: null };
	private timer: ReturnType<typeof setTimeout> | null = null;
	private abort: AbortController | null = null;
	private flight: Promise<UsageState> | null = null;
	private generation = 0;
	private disposed = false;
	private failures = 0;
	constructor(
		private readonly read: (refresh: boolean, signal: AbortSignal) => Promise<SubscriptionUsage>,
		private readonly leader: () => boolean,
		private readonly publish: (state: UsageState) => void
	) {}

	configure(): void {
		this.cancel();
		this.state = { ...this.state, preferences: usagePreferences(), loading: false, nextUpdate: null };
		this.publish(this.state);
		if (this.state.preferences.autoRefresh) void this.load(this.leader());
	}

	async savePreferences(patch: Record<string, unknown>): Promise<void> {
		for (const [key, value] of Object.entries(patch))
			await vscode.workspace.getConfiguration('ungate').update(`usage.${key}`, value, vscode.ConfigurationTarget.Global);
		this.configure();
	}

	load(refresh = false): Promise<UsageState> {
		if (this.disposed) return Promise.resolve(this.state);
		if (this.flight) return this.flight;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		const generation = this.generation;
		const abort = new AbortController();
		this.abort = abort;
		this.state = { ...this.state, loading: true, error: null, nextUpdate: null };
		this.publish(this.state);
		const flight = this.read(refresh, abort.signal)
			.then((data) => {
				if (generation !== this.generation) return this.state;
				// Cache-only followers and manual reads must age snapshots against the configured cadence.
				const maxAge = this.state.preferences.intervalSeconds * 1000;
				data = {
					providers: data.providers.map((provider) => {
						const fetched = provider.fetchedAt ? Date.parse(provider.fetchedAt) : NaN;
						const age = Date.now() - fetched;

						return { ...provider, stale: provider.stale || (Number.isFinite(fetched) && (age < 0 || age >= maxAge)) };
					})
				};
				this.failures = data.providers.some((provider) => provider.status === 'error') ? this.failures + 1 : 0;
				this.state = { ...this.state, data };

				return this.state;
			})
			.catch((error: unknown) => {
				if (generation !== this.generation) return this.state;
				this.failures++;
				this.state = {
					...this.state,
					error: error instanceof Error ? error.message : String(error),
					data: this.state.data
						? { providers: this.state.data.providers.map((provider) => ({ ...provider, stale: true })) }
						: null
				};

				return this.state;
			})
			.finally(() => {
				if (generation !== this.generation) return;
				this.flight = null;
				this.abort = null;
				this.state = { ...this.state, loading: false };
				if (this.state.preferences.autoRefresh && !this.disposed) {
					const interval = this.state.preferences.intervalSeconds;
					const retry = Math.max(0, ...(this.state.data?.providers.map((provider) => provider.retryAfterSeconds ?? 0) ?? []));
					const delay = Math.max(interval * Math.min(2 ** this.failures, 8), retry) * 1000;
					this.state.nextUpdate = new Date(Date.now() + delay).toISOString();
					this.timer = setTimeout(() => void this.load(this.leader()), delay);
					this.timer.unref?.();
				}
				this.publish(this.state);
			});
		this.flight = flight;

		return flight;
	}

	invalidate(): void {
		this.cancel();
		this.state = { ...this.state, data: null, loading: false, nextUpdate: null };
		this.publish(this.state);
		void this.load(false);
	}

	private cancel(): void {
		this.generation++;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.abort?.abort();
		this.abort = null;
		this.flight = null;
	}

	dispose(): void {
		this.disposed = true;
		this.cancel();
	}
}
