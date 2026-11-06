import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

import { isPublicIpAddress } from './outbound-request';

export async function validateMiniMaxBaseUrl(value: string): Promise<string> {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error('MiniMax base URL is invalid');
	}
	if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
		throw new Error('MiniMax base URL must be HTTPS without credentials or a fragment');
	}
	if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost')) {
		throw new Error('MiniMax base URL must use a public host');
	}
	const hostname = url.hostname.replace(/^\[|\]$/g, '');
	const addresses = isIP(hostname)
		? [{ address: hostname }]
		: await lookup(hostname, { all: true, verbatim: true }).catch(() => []);
	if (addresses.length === 0 || addresses.some(({ address }) => !isPublicIpAddress(address))) {
		throw new Error('MiniMax base URL must resolve only to public addresses');
	}

	return url.href.replace(/\/+$/, '');
}

/**
 * Resolve immediately before connecting, then connect to that exact approved IP.
 * Keep the original hostname for TLS certificate verification, SNI and Host.
 * Never follow redirects or consult proxy environment variables.
 */
export const fetchMiniMax: typeof fetch = async (input, init = {}) => {
	const url = new URL(input instanceof Request ? input.url : input);
	await validateMiniMaxBaseUrl(url.href);
	if (init.body != null && typeof init.body !== 'string') throw new Error('Unsupported MiniMax request body');
	const hostname = url.hostname.replace(/^\[|\]$/g, '');
	const addresses = isIP(hostname)
		? [{ address: hostname, family: isIP(hostname) }]
		: await lookup(hostname, { all: true, verbatim: true });
	if (!addresses.length || addresses.some(({ address }) => !isPublicIpAddress(address))) {
		throw new Error('MiniMax destination must be public');
	}
	const address = addresses[0];

	return new Promise<Response>((resolve, reject) => {
		const req = request(
			url,
			{
				method: init.method ?? 'GET',
				headers: Object.fromEntries(new Headers(init.headers)),
				signal: init.signal ?? undefined,
				agent: false,
				lookup: (_hostname, options, callback) => {
					if (options.all) callback(null, [address]);
					else callback(null, address.address, address.family);
				}
			},
			(res) => {
				try {
					const status = res.statusCode ?? 502;
					if (status >= 300 && status < 400) {
						res.destroy();
						reject(new Error('MiniMax redirects are not allowed'));

						return;
					}
					const headers = new Headers();
					for (const [key, value] of Object.entries(res.headers)) {
						if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
					}
					const noBody = [204, 205, 304].includes(status) || init.method === 'HEAD';
					if (noBody) res.resume();
					resolve(new Response(noBody ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status, headers }));
				} catch (error) {
					res.destroy();
					reject(error instanceof Error ? error : new Error('Invalid MiniMax response'));
				}
			}
		);
		req.on('error', reject);
		req.end(init.body ?? undefined);
	});
};
