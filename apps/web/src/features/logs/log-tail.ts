export const LOG_PANEL = {
	defaultHeight: 288,
	minHeight: 192,
	maxHeight: 720,
	resizeStep: 16,
	largeResizeStep: 48,
	tailThreshold: 24
} as const;

export function countNewEntryIds(previous: string[], current: string[], historyExpanded = false): number {
	if (previous.length === 0 || current.length === 0) return 0;
	const known = new Set(previous);
	// A larger display limit prepends old history; only count unseen entries after its overlap.
	const overlap = historyExpanded ? current.findIndex((id) => known.has(id)) : 0;

	return current.slice(Math.max(0, overlap)).reduce((count, id) => count + (known.has(id) ? 0 : 1), 0);
}
