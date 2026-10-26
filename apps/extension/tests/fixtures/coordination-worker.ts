import * as path from 'node:path';

import { config } from '../../src/runtime-state/config';
import { RuntimeStateStore } from '../../src/runtime-state/runtime-state-store';

const directory = process.argv[2];
const workerId = process.argv[3];
config.baseDir = directory;
config.paths.stateFilePath = path.join(directory, 'runtime-state.json');

async function run(): Promise<void> {
	await RuntimeStateStore.touchClient(workerId);
	for (let index = 0; index < 50; index++) {
		await RuntimeStateStore.enqueueCommand({
			id: `${workerId}-${index}`,
			action: 'clear-logs',
			originWindowId: workerId,
			createdAt: Date.now()
		});
	}
}
void run().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
