import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { bin, install, Tunnel } from 'cloudflared';

import { PRIVATE_FILE_MODE, QUICK_TUNNEL_CONFIG, QUICK_TUNNEL_CONFIG_NAME, UNGATE_DIR } from '@ungate/shared';

const port = process.argv[2] ?? process.env.PORT ?? '4783';

if (!existsSync(bin)) {
	console.log('[tunnel] installing cloudflared...');
	await install(bin);
	console.log('[tunnel] cloudflared installed');
}

const ungateDir = join(homedir(), UNGATE_DIR);
const configPath = join(ungateDir, QUICK_TUNNEL_CONFIG_NAME);
mkdirSync(ungateDir, { recursive: true });
writeFileSync(configPath, QUICK_TUNNEL_CONFIG, { mode: PRIVATE_FILE_MODE });

const tunnel = Tunnel.quick(`http://localhost:${port}`, {
	'--config': configPath,
	'--edge-ip-version': '4'
});

tunnel.once('url', (url: string) => {
	console.log(`[tunnel] URL: ${url}`);
});

tunnel.once('error', (error: Error) => {
	console.error(`[tunnel] error: ${error.message}`);
	process.exit(1);
});

tunnel.once('exit', (code: number | null) => {
	if (code !== 0) {
		console.error(`[tunnel] exited with code ${code}`);
		process.exit(code ?? 1);
	}
});
