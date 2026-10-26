import { describe, expect, it } from 'vitest';

import { parseClaudeUsage, parseMiniMaxUsage, parseOpenAiUsage } from 'src/usage/parsers';

describe('provider subscription snapshots', () => {
	it('keeps separate Claude windows and a genuine zero', () => {
		const windows = parseClaudeUsage({
			five_hour: { utilization: 0, resets_at: '2026-10-24T01:00:00Z' },
			seven_day: { utilization: 45 },
			seven_day_opus: null
		});
		expect(windows).toHaveLength(2);
		expect(windows[0]).toMatchObject({ usedPercent: 0, remainingPercent: 100, resetsAt: '2026-10-24T01:00:00.000Z' });
		expect(windows[1].resetsAt).toBeNull();
	});
	it('uses Codex window durations and reset epoch instead of assumed five-hour labels', () => {
		const windows = parseOpenAiUsage({
			rate_limit: {
				primary_window: { used_percent: 25, limit_window_seconds: 3600, reset_at: 1792792800 },
				secondary_window: { used_percent: 80, limit_window_seconds: 604800 }
			}
		});
		expect(windows[0]).toMatchObject({ label: 'Codex · 1 hours', usedPercent: 25, remainingPercent: 75 });
		expect(windows[1].label).toBe('Codex · 7 days');
	});
	it('does not invent allowance from missing or malformed fields', () => {
		expect(parseOpenAiUsage({ rate_limit: { primary_window: { used_percent: '20' } } })).toEqual([]);
		expect(parseClaudeUsage({ five_hour: {} })).toEqual([]);
		expect(parseClaudeUsage(null)).toEqual([]);
	});
	it('uses only explicit MiniMax percentages and does not interpret undocumented time fields', () => {
		const windows = parseMiniMaxUsage({
			model_remains: [{ model_name: 'MiniMax', current_interval_remaining_percent: 60, remains_time: 12345 }]
		});
		expect(windows[0]).toMatchObject({ usedPercent: 40, remainingPercent: 60, resetsAt: null, windowSeconds: null });
		expect(
			parseMiniMaxUsage({
				model_remains: [{ model_name: 'M', current_interval_total_count: 100, current_interval_usage_count: 50 }]
			})
		).toEqual([]);
	});
	it('rejects application-level MiniMax errors inside HTTP 200', () => {
		expect(() => parseMiniMaxUsage({ base_resp: { status_code: 1004 } })).toThrow();
	});
});
