import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { UNGATE_DIR } from '@ungate/shared';

import { PROCESS_PROBE_TIMEOUT_MS } from './process-limits';

/** PID alone is not ownership: check both the executable and a unique per-launch argument. */
export class ManagedProcess {
	static isAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);

			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code !== 'ESRCH';
		}
	}

	static matches(pid: number | undefined, executable: string, marker: string | undefined): boolean {
		if (!pid || !Number.isInteger(pid) || pid <= 0 || !marker) return false;
		try {
			if (process.platform === 'linux') {
				const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');

				return fs.realpathSync(`/proc/${pid}/exe`) === fs.realpathSync(executable) && args.includes(marker);
			}
			if (process.platform === 'win32') {
				const raw = execFileSync(
					process.env.SystemRoot
						? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
						: 'powershell.exe',
					[
						'-NoProfile',
						'-NonInteractive',
						'-Command',
						`Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object ExecutablePath,CommandLine | ConvertTo-Json -Compress`
					],
					{ encoding: 'utf8', timeout: PROCESS_PROBE_TIMEOUT_MS, windowsHide: true }
				);
				const result = JSON.parse(raw) as { ExecutablePath?: string; CommandLine?: string };

				return result.ExecutablePath?.toLowerCase() === executable.toLowerCase() && !!result.CommandLine?.includes(marker);
			}
			const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
				encoding: 'utf8',
				timeout: PROCESS_PROBE_TIMEOUT_MS
			}).trim();
			const resolvedExecutable = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
				encoding: 'utf8',
				timeout: PROCESS_PROBE_TIMEOUT_MS
			}).trim();

			return (
				!!command &&
				!!resolvedExecutable &&
				fs.realpathSync(resolvedExecutable) === fs.realpathSync(executable) &&
				command.includes(marker)
			);
		} catch {
			return false;
		}
	}
}

export function getCloudflaredBinPath(): string {
	return path.join(os.homedir(), UNGATE_DIR, 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
}
