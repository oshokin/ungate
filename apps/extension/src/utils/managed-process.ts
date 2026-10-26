import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
					'powershell.exe',
					[
						'-NoProfile',
						'-NonInteractive',
						'-Command',
						`Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object ExecutablePath,CommandLine | ConvertTo-Json -Compress`
					],
					{ encoding: 'utf8', timeout: 3000, windowsHide: true }
				);
				const result = JSON.parse(raw) as { ExecutablePath?: string; CommandLine?: string };

				return result.ExecutablePath?.toLowerCase() === executable.toLowerCase() && !!result.CommandLine?.includes(marker);
			}
			const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 3000 }).trim();

			return command.startsWith(`${executable} `) && command.includes(marker);
		} catch {
			return false;
		}
	}
}

export function getCloudflaredBinPath(): string {
	return path.join(os.homedir(), '.ungate', 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
}
