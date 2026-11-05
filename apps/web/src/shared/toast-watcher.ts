const watchedMessages: Record<string, string | undefined> = {};

/** Returns true only when a source transitions to a new non-empty message. */
export function shouldAnnounceToast(source: string, message: string | null): boolean {
	if (!message) {
		delete watchedMessages[source];

		return false;
	}
	if (watchedMessages[source] === message) return false;
	watchedMessages[source] = message;

	return true;
}
