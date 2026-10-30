import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface RuntimeInfo {
	version: string;
	napi: number;
	abi: string;
	platform: string;
	arch: string;
	execPath: string;
}

type Diagnostic = (message: string) => void;

/** Resolve a standalone Node executable; the SQLite N-API prebuild is load-tested separately. */
export class NodeResolver {
	static resolve(overridePath?: string, log: Diagnostic = () => {}): string {
		const configured = overridePath?.trim().replace(/^"(.*)"$/, '$1');
		const candidates = configured ? [configured] : this.getCandidates();
		for (const candidate of candidates) {
			try {
				const info = this.inspect(candidate);
				log(`[runtime] Using Node.js ${info.version} (${info.platform}-${info.arch}, Node-API ${info.napi}): ${info.execPath}`);

				return info.execPath;
			} catch (error) {
				log(`[runtime] Rejected ${candidate}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (configured)
			throw new Error(
				'The configured Node.js executable cannot run Ungate. Choose a Node.js 24 LTS executable, or clear ungate.nodePath and UNGATE_NODE_BIN to use automatic detection. See Logs for the reason.'
			);
		throw new Error(
			'Node.js was not found or is incompatible. Install Node.js 24 LTS, completely quit and reopen Cursor, or choose the Node.js executable. See Logs for the checked locations.'
		);
	}

	static inspect(runtime: string): RuntimeInfo {
		const paths = this.paths();
		if (!['node', 'node.exe'].includes(paths.basename(runtime).toLowerCase()))
			throw new Error(
				'Choose node.exe on Windows or the node executable on Linux/macOS; shell scripts and editor executables are not supported.'
			);
		const script =
			'JSON.stringify({version:process.versions.node,napi:Number(process.versions.napi),abi:process.versions.modules,platform:process.platform,arch:process.arch,execPath:process.execPath,electron:process.versions.electron})';
		const result = cp.spawnSync(runtime, ['-p', script], {
			encoding: 'utf8',
			timeout: 3000,
			maxBuffer: 65536,
			windowsHide: true,
			shell: false
		});
		if (result.error)
			throw new Error(`Cannot execute Node.js (${(result.error as NodeJS.ErrnoException).code ?? result.error.message}).`);
		if (result.status !== 0) throw new Error(`Node.js probe exited with status ${result.status}.`);
		let raw: unknown;
		try {
			raw = JSON.parse(result.stdout.trim());
		} catch {
			throw new Error('Node.js did not return a valid runtime report.');
		}
		if (!raw || typeof raw !== 'object') throw new Error('Invalid Node.js runtime report.');
		const info = raw as Record<string, unknown>;
		if (typeof info.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(info.version) || Number(info.version.split('.')[0]) < 22)
			throw new Error(
				`Node.js ${typeof info.version === 'string' ? info.version : 'unknown'} is unsupported; version 22 or newer is required. Node.js 24 LTS is recommended.`
			);
		if (
			!Number.isInteger(info.napi) ||
			Number(info.napi) < 10 ||
			typeof info.abi !== 'string' ||
			info.electron ||
			!['win32', 'linux', 'darwin'].includes(String(info.platform)) ||
			!['x64', 'arm64'].includes(String(info.arch)) ||
			typeof info.execPath !== 'string' ||
			!paths.isAbsolute(info.execPath)
		)
			throw new Error(
				'A standalone x64/arm64 Node.js with Node-API 10 or newer (Node.js 22.14+ or 24 LTS) is required on Windows, Linux or macOS.'
			);

		return {
			version: info.version,
			napi: Number(info.napi),
			abi: info.abi,
			platform: String(info.platform),
			arch: String(info.arch),
			execPath: info.execPath
		};
	}

	private static paths(): typeof path.win32 {
		return process.platform === 'win32' ? path.win32 : path.posix;
	}

	private static env(name: string): string | undefined {
		const key =
			process.platform === 'win32' ? Object.keys(process.env).find((entry) => entry.toLowerCase() === name.toLowerCase()) : name;

		return key ? process.env[key] : undefined;
	}

	private static getCandidates(): string[] {
		const paths = this.paths();
		const home = os.homedir();
		const windows = process.platform === 'win32';
		const binary = windows ? 'node.exe' : 'node';
		const candidates: string[] = ['node'];
		const add = (candidate: string | undefined): void => {
			if (candidate && fs.existsSync(candidate)) candidates.push(candidate);
		};
		const join = (...parts: string[]) => paths.join(...parts);
		const fromEnv = (key: string, ...parts: string[]) => {
			const value = this.env(key);
			if (value) add(join(value, ...parts));
		};
		const versions = (directory: string, suffix: string[]) => {
			try {
				const entries = fs
					.readdirSync(directory)
					.filter((entry) => /^v?\d+\.\d+\.\d+$/.test(entry))
					.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
				for (const entry of entries) add(join(directory, entry, ...suffix, binary));
			} catch {
				/* Missing/unreadable manager directories do not hide other installations. */
			}
		};
		if (paths.basename(process.execPath).toLowerCase() === binary) add(process.execPath);
		for (const directory of (this.env('PATH') ?? '').split(windows ? ';' : ':')) {
			if (paths.isAbsolute(directory)) add(join(directory, binary));
		}
		if (windows) {
			for (const key of ['ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)']) fromEnv(key, 'nodejs', binary);
			fromEnv('LOCALAPPDATA', 'Programs', 'nodejs', binary);
			fromEnv('NVM_SYMLINK', binary);
			const nvmRoots = [
				this.env('NVM_HOME'),
				this.env('APPDATA') ? join(this.env('APPDATA')!, 'nvm') : undefined,
				this.env('LOCALAPPDATA') ? join(this.env('LOCALAPPDATA')!, 'nvm') : undefined
			];
			for (const directory of nvmRoots) if (directory) versions(directory, []);
			add(join(home, 'scoop', 'apps', 'nodejs-lts', 'current', binary));
			add(join(home, 'scoop', 'apps', 'nodejs', 'current', binary));
		} else {
			for (const directory of process.platform === 'darwin'
				? ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
				: ['/usr/local/bin', '/usr/bin', '/bin', '/snap/bin'])
				add(join(directory, binary));
			versions(join(this.env('NVM_DIR') ?? join(home, '.nvm'), 'versions', 'node'), ['bin']);
			versions(join(this.env('ASDF_DATA_DIR') ?? join(home, '.asdf'), 'installs', 'nodejs'), ['bin']);
		}
		add(join(this.env('VOLTA_HOME') ?? join(home, '.volta'), 'bin', binary));
		fromEnv('FNM_MULTISHELL_PATH', ...(windows ? [] : ['bin']), binary);
		const fnmRoots = [
			this.env('FNM_DIR'),
			windows && this.env('APPDATA') ? join(this.env('APPDATA')!, 'fnm') : undefined,
			windows && this.env('LOCALAPPDATA') ? join(this.env('LOCALAPPDATA')!, 'fnm') : undefined,
			!windows ? join(home, '.local', 'share', 'fnm') : undefined
		];
		for (const directory of fnmRoots)
			if (directory) versions(join(directory, 'node-versions'), windows ? ['installation'] : ['installation', 'bin']);
		const seen = new Set<string>();

		return candidates.filter((candidate) => {
			const key = windows ? candidate.toLowerCase() : candidate;
			if (seen.has(key)) return false;
			seen.add(key);

			return true;
		});
	}
}
