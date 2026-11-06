export const LOGIN_ERROR_MESSAGES = Object.freeze({
	network_error: 'Could not connect to OpenAI. Check your connection and start sign-in again.',
	timeout: 'OpenAI took too long to respond. Start sign-in again.',
	authorization_rejected: 'OpenAI rejected the sign-in. Start sign-in again to get a new authorization code.',
	provider_unavailable: 'OpenAI is temporarily unavailable. Wait a moment, then start sign-in again.',
	invalid_token_response: 'OpenAI returned an invalid sign-in response. Start sign-in again.',
	unexpected_error: 'Sign-in could not be completed. Start sign-in again.'
});

export type LoginErrorCode = keyof typeof LOGIN_ERROR_MESSAGES;

export class OpenAILoginError extends Error {
	constructor(public readonly code: LoginErrorCode) {
		super(LOGIN_ERROR_MESSAGES[code]);
		this.name = 'OpenAILoginError';
	}
}
