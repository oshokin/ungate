import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const repoDir = resolve(import.meta.dirname, '../..');

export function runNode(args: string[], cwd = repoDir, environment: NodeJS.ProcessEnv = {}): void {
	const result = spawnSync(process.execPath, args, { cwd, env: { ...process.env, ...environment }, stdio: 'inherit' });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`Command failed (${result.status ?? result.signal}): node ${args.join(' ')}`);
}

export function runPnpm(args: string[], cwd = repoDir): void {
	const cli = process.env.npm_execpath;
	if (!cli || !existsSync(cli)) throw new Error('Run this task through corepack pnpm, for example: corepack pnpm package');
	runNode([cli, ...args], cwd);
}
