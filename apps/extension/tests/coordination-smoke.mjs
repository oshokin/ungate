// Build the fixture first; see docs/audit-20261023/REPORT.ru.md.
// Tests actual filesystem coordination in eight independent Node processes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import { runtimeStateSchema } from '@ungate/shared';

const fixture = resolve(process.argv[2] || join(tmpdir(), 'ungate-coordination-worker.cjs'));
const directory = mkdtempSync(join(tmpdir(), 'ungate-coordination-smoke-'));
/** @type {import('node:child_process').ChildProcess[]} */
const children = [];
try {
	await Promise.all(
		Array.from(
			{ length: 8 },
			(_, index) =>
				new Promise((done, reject) => {
					const child = spawn(process.execPath, [fixture, directory, `worker-${index}`], { stdio: ['ignore', 'ignore', 'pipe'] });
					children.push(child);
					let stderr = '';
					child.stderr.on('data', (bytes) => {
						stderr += String(bytes);
					});
					const timer = setTimeout(() => {
						child.kill();
						reject(new Error('Worker timeout'));
					}, 30000);
					child.once('error', (error) => {
						clearTimeout(timer);
						reject(error);
					});
					child.once('exit', (code) => {
						clearTimeout(timer);
						if (code === 0) done();
						else reject(new Error(`Worker ${index} exited ${code}: ${stderr}`));
					});
				})
		)
	);
	const state = runtimeStateSchema.parse(JSON.parse(readFileSync(join(directory, 'runtime-state.json'), 'utf8')));
	assert.equal(Object.keys(state.clients).length, 400);
	console.log(JSON.stringify({ result: 'PASS', processes: 8, concurrentStateUpdates: 400, liveClients: 400 }));
} finally {
	for (const child of children) if (child.exitCode === null) child.kill();
	rmSync(directory, { recursive: true, force: true });
}
