import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const DEFAULT_NODE_COMMAND = 'node';
// Node ABI 127 = Node 22, 137 = Node 24, 141 = Node 25, 147 = Node 26
// (nodejs/node abi_version_registry). Anything else cannot load our native bindings.
const SUPPORTED_NODE_ABIS: Record<string, true> = { '127': true, '137': true, '141': true, '147': true };
const SUPPORTED_NODE_VERSIONS = '22, 24, 25 or 26';

interface RuntimeInfo {
	abi: string;
	platform: string;
	arch: string;
}

export class NodeResolver {
	static resolve(overridePath?: string): string {
		if (overridePath) {
			if (this.isSupported(overridePath)) {
				return overridePath;
			}

			throw new Error(`[native] UNGATE_NODE_BIN must point to Node ${SUPPORTED_NODE_VERSIONS}: ${overridePath}`);
		}

		const candidates = this.getCandidates();

		for (const candidate of candidates) {
			if (this.isSupported(candidate)) {
				return candidate;
			}
		}

		throw new Error(
			`[native] No supported Node runtime found. Install Node ${SUPPORTED_NODE_VERSIONS}, or set UNGATE_NODE_BIN to one.`
		);
	}

	static inspect(runtime: string): RuntimeInfo {
		const result = cp.spawnSync(
			runtime,
			['-p', 'JSON.stringify({ abi: process.versions.modules, platform: process.platform, arch: process.arch })'],
			{ encoding: 'utf8', timeout: 5000, windowsHide: true }
		);

		if (result.error) {
			throw result.error;
		}

		if (result.status !== 0) {
			throw new Error(result.stderr.trim() || `Failed to inspect runtime: ${runtime}`);
		}

		return JSON.parse(result.stdout.trim()) as RuntimeInfo;
	}

	private static getCandidates(): string[] {
		const candidates: string[] = [];
		const seen = new Set<string>();
		const homeDir = os.homedir();
		const binaryName = process.platform === 'win32' ? 'node.exe' : 'node';

		this.push(candidates, seen, DEFAULT_NODE_COMMAND);
		this.push(candidates, seen, process.env.UNGATE_NODE_BIN);
		this.push(candidates, seen, this.getEditorRuntime(binaryName));

		if (process.platform === 'darwin') {
			this.push(candidates, seen, '/opt/homebrew/bin/node');
			this.push(candidates, seen, '/usr/local/bin/node');
			this.push(candidates, seen, '/usr/bin/node');
		}

		if (process.platform === 'linux') {
			this.push(candidates, seen, '/usr/local/bin/node');
			this.push(candidates, seen, '/usr/bin/node');
			this.push(candidates, seen, '/bin/node');
			this.push(candidates, seen, '/snap/bin/node');
		}

		if (process.platform === 'win32') {
			this.push(candidates, seen, process.env.NVM_SYMLINK ? path.join(process.env.NVM_SYMLINK, binaryName) : undefined);
			this.push(candidates, seen, process.env.NVM_HOME ? path.join(process.env.NVM_HOME, binaryName) : undefined);
			this.push(
				candidates,
				seen,
				process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', binaryName) : undefined
			);
			this.push(
				candidates,
				seen,
				process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'nodejs', binaryName) : undefined
			);
			this.push(
				candidates,
				seen,
				process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'nodejs', binaryName) : undefined
			);
			this.pushFromDir(candidates, seen, process.env.NVM_HOME ?? '', binaryName);
		}

		this.push(candidates, seen, path.join(homeDir, '.volta', 'bin', binaryName));
		this.push(candidates, seen, path.join(homeDir, '.asdf', 'shims', binaryName));
		this.pushFromDir(candidates, seen, path.join(homeDir, '.nvm', 'versions', 'node'), binaryName);
		this.pushFromDir(candidates, seen, path.join(homeDir, '.asdf', 'installs', 'nodejs'), binaryName);

		return candidates;
	}

	/**
	 * The Node runtime the editor is itself running on, but only when that runtime
	 * is a plain `node` binary this extension is able to spawn.
	 *
	 * In a remote window — SSH, WSL, a dev container or Codespaces — the extension
	 * host is forked from the editor server's own Node, which lives at
	 * `~/.cursor-server/bin/<commit>/node` or the VS Code equivalent. That build
	 * follows the editor's Node version rather than the machine's, so it carries a
	 * supported ABI even on a host whose only system Node is too old to load our
	 * native bindings. Without this candidate such a host has no usable runtime at
	 * all, because `node` on PATH and every fixed system location below resolve to
	 * that same too-old Node.
	 *
	 * A desktop window runs the extension host inside Electron instead, so there
	 * `process.execPath` is the editor executable: spawning it would open a second
	 * editor window instead of reporting an ABI. Comparing the file name against the
	 * Node binary name keeps the Electron case out, and desktop installs go on
	 * resolving through the system candidates.
	 */
	private static getEditorRuntime(binaryName: string): string | undefined {
		if (path.basename(process.execPath) !== binaryName) {
			return undefined;
		}

		return process.execPath;
	}

	private static push(candidates: string[], seen: Set<string>, candidate: string | undefined): void {
		if (!candidate) {
			return;
		}

		if (seen.has(candidate)) {
			return;
		}

		seen.add(candidate);
		candidates.push(candidate);
	}

	private static pushFromDir(candidates: string[], seen: Set<string>, dir: string, binaryName: string): void {
		if (!dir || !fs.existsSync(dir)) {
			return;
		}

		const entries = fs.readdirSync(dir).sort().reverse();

		for (const entry of entries) {
			this.push(candidates, seen, path.join(dir, entry, 'bin', binaryName));
		}
	}

	private static isSupported(candidate: string): boolean {
		try {
			return SUPPORTED_NODE_ABIS[this.inspect(candidate).abi] === true;
		} catch {
			return false;
		}
	}
}
