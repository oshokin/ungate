import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { baseDir } = vi.hoisted(() => {
	// Vitest evaluates hoisted factories before static imports.
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const nodeFs = require('node:fs') as typeof import('node:fs');
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const nodeOs = require('node:os') as typeof import('node:os');
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const nodePath = require('node:path') as typeof import('node:path');

	return { baseDir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ungate-runtime-state-')) };
});

vi.mock('../../src/runtime-state/config', () => ({
	config: {
		baseDir,
		paths: {
			stateFilePath: path.join(baseDir, 'runtime-state.json')
		}
	}
}));

vi.mock('../../src/utils/cross-process-lock', () => ({
	CrossProcessLock: { acquire: vi.fn(() => Promise.resolve(() => {})) }
}));

import { RuntimeStateFileStore } from '../../src/runtime-state/file-store';

describe('RuntimeStateFileStore corruption handling', () => {
	beforeEach(() => {
		fs.rmSync(baseDir, { recursive: true, force: true });
		fs.mkdirSync(baseDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(baseDir, { recursive: true, force: true });
	});

	it('uses defaults only when the runtime state file is absent', () => {
		expect(RuntimeStateFileStore.read().api.status).toBe('stopped');
	});

	it('throws on corrupt state instead of silently returning defaults', () => {
		fs.writeFileSync(path.join(baseDir, 'runtime-state.json'), '{not json', { mode: 0o600 });

		expect(() => RuntimeStateFileStore.read()).toThrow('Cannot read runtime state');
	});

	it('quarantines corrupt state under the mutation lock and does not overwrite it', async () => {
		const statePath = path.join(baseDir, 'runtime-state.json');
		fs.writeFileSync(statePath, '{not json', { mode: 0o600 });

		await expect(RuntimeStateFileStore.mutate((state) => state)).rejects.toThrow('Cannot read runtime state');
		expect(fs.existsSync(statePath)).toBe(false);
		expect(fs.readdirSync(baseDir).some((name) => name.startsWith('runtime-state.json.corrupt-'))).toBe(true);
	});
});
