import { createServer, type Server, type ServerResponse } from 'node:http';

import { LOOPBACK_HOST, sleep } from '@ungate/shared';
import { OAUTH_LOGIN_TTL_MS } from 'src/auth/oauth-limits';
import { config } from 'src/config';
import { logger } from 'src/utils/logger';

export class OpenAICallbackServer {
	private static callbackServer: Server | null = null;
	private static callbackShutdownAbort: AbortController | null = null;

	public static async start(
		onCallback: (
			requestUrl: string | undefined,
			path: string,
			response: ServerResponse,
			stop: () => Promise<void>
		) => Promise<void>
	): Promise<void> {
		await this.stop();

		const callbackUrl = new URL(config.openai.oauth.redirectUri);
		const port = parseInt(callbackUrl.port, 10);
		const path = callbackUrl.pathname;
		const server = createServer((request, response) => {
			void Promise.resolve()
				.then(() => onCallback(request.url, path, response, () => this.stop(server)))
				.catch(async () => {
					logger.error('OpenAI OAuth callback failed. Please restart login.');
					if (!response.destroyed && !response.writableEnded) {
						if (response.headersSent) {
							response.destroy();
						} else {
							response.writeHead(500, {
								'Content-Type': 'text/html; charset=utf-8',
								'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
								'Cache-Control': 'no-store'
							});
							response.end('<html><body><h1>Login failed</h1><p>Please close this window and try again.</p></body></html>');
						}
					}
					await this.stop(server);
				})
				.catch(() => {});
		});

		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(port, LOOPBACK_HOST, () => {
				server.off('error', reject);
				resolve();
			});
		});

		this.callbackServer = server;
		if (this.callbackShutdownAbort) {
			this.callbackShutdownAbort.abort();
		}

		this.callbackShutdownAbort = new AbortController();
		const shutdownSignal = this.callbackShutdownAbort.signal;
		void sleep(OAUTH_LOGIN_TTL_MS, shutdownSignal)
			.then(() => this.stop(server))
			.catch(() => {});
	}

	public static async stop(expectedServer?: Server): Promise<void> {
		if (expectedServer && this.callbackServer !== expectedServer) return;
		if (this.callbackShutdownAbort) {
			this.callbackShutdownAbort.abort();
			this.callbackShutdownAbort = null;
		}

		if (!this.callbackServer) {
			return;
		}

		const server = this.callbackServer;
		this.callbackServer = null;
		await new Promise<void>((resolve) => {
			server.close(() => {
				resolve();
			});
		});
	}
}
