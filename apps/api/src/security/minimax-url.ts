import { lookup } from 'node:dns/promises';

import { MINIMAX_BASE_URLS } from '@ungate/shared';

import { isPublicIpAddress } from './outbound-request';

const KNOWN_ORIGINS = new Set(Object.values(MINIMAX_BASE_URLS).map((value) => new URL(value).origin));

export async function validateMiniMaxBaseUrl(value: string): Promise<string> {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error('MiniMax base URL is invalid');
	}
	if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
		throw new Error('MiniMax base URL must be HTTPS without credentials or a fragment');
	}
	if (KNOWN_ORIGINS.has(url.origin)) return url.href.replace(/\/+$/, '');
	if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost')) {
		throw new Error('MiniMax base URL must use a public host');
	}
	const addresses = await lookup(url.hostname, { all: true, verbatim: true }).catch(() => []);
	if (addresses.length === 0 || addresses.some(({ address }) => !isPublicIpAddress(address))) {
		throw new Error('MiniMax base URL must resolve only to public addresses');
	}

	return url.href.replace(/\/+$/, '');
}
