import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { RuntimeStateStore } from '../runtime-state';

const execFile = promisify(cp.execFile);
const BUNDLED_VERSION = '13.0.3';
const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux', 'win32']);
const SUPPORTED_ARCHITECTURES = new Set(['arm64', 'x64']);

interface InstallCallbacks {
	onLog(level: 'info' | 'warn' | 'error', message: string): void;
}

interface RuntimeTarget {
	readonly platform: string;
	readonly arch: string;
	readonly isMusl: boolean;
}

export class BetterSqlite3Installer {
	static readBundledVersion(apiDir: string): string {
		const packagePath = path.join(apiDir, 'node_modules', 'better-sqlite3', 'package.json');
		const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { version?: string };

		if (!pkg.version) throw new Error('[native] better-sqlite3 package.json is missing version');

		return pkg.version;
	}

	static getBinaryPath(apiDir: string, runtime = process.execPath): string {
		const sqliteDir = fs.realpathSync(path.join(apiDir, 'node_modules', 'better-sqlite3'));
		const target = this.inspectRuntime(runtime);

		if (!SUPPORTED_PLATFORMS.has(target.platform) || !SUPPORTED_ARCHITECTURES.has(target.arch)) {
			throw new Error(
				`[native] better-sqlite3 ${BUNDLED_VERSION} has no bundled prebuild for ${target.platform}-${target.arch}. ` +
					'Use x64 or arm64 on glibc/musl Linux, macOS or Windows.'
			);
		}

		const platform = target.platform === 'linux' && target.isMusl ? 'linuxmusl' : target.platform;

		return path.join(sqliteDir, 'prebuilds', `${platform}-${target.arch}.node`);
	}

	static resolveBindingPath(apiDir: string, runtime = process.execPath): string {
		return this.getBinaryPath(apiDir, runtime);
	}

	static async ensureInstalled(apiDir: string, runtime: string, callbacks: InstallCallbacks): Promise<void> {
		if (RuntimeStateStore.isApiStartSuppressed()) {
			const runtimeState = RuntimeStateStore.read();
			throw new Error(runtimeState.api.lastError ?? '[native] better-sqlite3 bundled prebuild failed to load');
		}

		const version = this.readBundledVersion(apiDir);
		if (version !== BUNDLED_VERSION) {
			throw new Error(`[native] Expected better-sqlite3 ${BUNDLED_VERSION}, but the bundle contains ${version}`);
		}

		const binaryPath = this.getBinaryPath(apiDir, runtime);
		const binaryExists = fs.existsSync(binaryPath);
		const isLoadable = binaryExists ? await this.tryLoad(runtime, apiDir, binaryPath, callbacks) : false;

		if (!isLoadable) {
			const message = `[native] better-sqlite3 bundled prebuild failed to load: ${binaryPath}`;

			await RuntimeStateStore.suppressApiAutoStart(message);
			throw new Error(message);
		}

		callbacks.onLog('info', `[native] better-sqlite3 ${version} bundled prebuild is ready`);
	}

	private static inspectRuntime(runtime: string): RuntimeTarget {
		const script =
			"JSON.stringify({platform:process.platform,arch:process.arch,isMusl:process.platform==='linux'&&!process.report.getReport().header.glibcVersionRuntime})";
		const result = cp.spawnSync(runtime, ['-p', script], { encoding: 'utf8', timeout: 5000, windowsHide: true });

		if (result.error) throw result.error;
		if (result.status !== 0) throw new Error(result.stderr.trim() || `Failed to inspect runtime: ${runtime}`);

		return JSON.parse(result.stdout.trim()) as RuntimeTarget;
	}

	private static async tryLoad(
		runtime: string,
		apiDir: string,
		bindingPath: string,
		callbacks: InstallCallbacks
	): Promise<boolean> {
		const bindingLiteral = JSON.stringify(bindingPath);
		const script = `const Database=require('better-sqlite3'); const db=new Database(':memory:', { nativeBinding: ${bindingLiteral} }); db.pragma('journal_mode = WAL'); db.close();`;

		try {
			await execFile(runtime, ['-e', script], { cwd: apiDir });

			return true;
		} catch (error) {
			const stderrRaw = error instanceof Error && 'stderr' in error ? error.stderr : '';
			const stderr = typeof stderrRaw === 'string' ? stderrRaw.trim() : '';

			if (stderr) callbacks.onLog('warn', `[native] ${stderr}`);

			return false;
		}
	}
}
