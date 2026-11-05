export interface DedupeToast {
	message: string;
	tone: string;
	action?: { label: string };
}

export function sameToast(left: DedupeToast, right: DedupeToast): boolean {
	return left.message === right.message && left.tone === right.tone && left.action?.label === right.action?.label;
}
