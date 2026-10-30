import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { build, check, packageVsix } from './pipeline';
import { runPnpm } from './process';

const [operation = 'package', ...args] = process.argv.slice(2);
if (
	!['browser', 'build', 'check', 'test', 'package', 'vsix'].includes(operation) ||
	args.some((arg) => arg !== '--install') ||
	args.length > 1 ||
	(args.length && !['package', 'vsix'].includes(operation))
) {
	console.error('Usage: corepack pnpm <build|check|package|package:vsix> [--install]');
	process.exitCode = 2;
} else {
	try {
		if (operation === 'browser') {
			if (process.env.UNGATE_CHROMIUM_EXECUTABLE_PATH) {
				if (!existsSync(process.env.UNGATE_CHROMIUM_EXECUTABLE_PATH))
					throw new Error('UNGATE_CHROMIUM_EXECUTABLE_PATH does not exist');
				console.log('Using the explicitly configured Chromium executable.');
			} else runPnpm(['--filter', '@ungate/scripts', 'exec', 'playwright', 'install', 'chromium']);
		} else if (operation === 'test') {
			runPnpm(['--filter', 'ungate', 'test']);
			runPnpm(['--filter', '@ungate/api', 'test']);
			runPnpm(['--filter', '@ungate/web', 'test']);
		} else if (operation === 'build') build();
		else if (operation === 'check') check();
		else {
			if (operation === 'package') check();
			else build();
			const file = await packageVsix();
			if (args.includes('--install')) {
				const result =
					process.platform === 'win32'
						? spawnSync(
								'cmd.exe',
								['/d', '/v:off', '/s', '/c', 'cursor.cmd --install-extension "%UNGATE_VSIX_INSTALL_PATH%" --force'],
								{ stdio: 'inherit', windowsVerbatimArguments: true, env: { ...process.env, UNGATE_VSIX_INSTALL_PATH: file } }
							)
						: spawnSync('cursor', ['--install-extension', file, '--force'], { stdio: 'inherit' });
				if (result.error || result.status !== 0) throw result.error ?? new Error('Cursor installation failed');
			}
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
