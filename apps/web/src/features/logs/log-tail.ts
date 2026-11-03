/** Pixel bounds for the resizable log panel. */
export const LOG_PANEL = {
	/** Height used before the user drags the panel. */
	defaultHeight: 288,
	/** Smallest height the drag handle can set. */
	minHeight: 192,
	/** Largest height the drag handle can set. */
	maxHeight: 720,
	/** Keyboard resize step. */
	resizeStep: 16,
	/** Keyboard resize step with the larger modifier. */
	largeResizeStep: 48,
	/** Distance from the bottom that still counts as following the tail. */
	tailThreshold: 24
} as const;

export function countNewEntryIds(previous: string[], current: string[], historyExpanded = false): number {
	if (previous.length === 0 || current.length === 0) return 0;
	const known = new Set(previous);
	// A larger display limit prepends old history; only count unseen entries after its overlap.
	const overlap = historyExpanded ? current.findIndex((id) => known.has(id)) : 0;

	return current.slice(Math.max(0, overlap)).reduce((count, id) => count + (known.has(id) ? 0 : 1), 0);
}
