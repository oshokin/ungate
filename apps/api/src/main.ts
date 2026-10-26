// Detached API must survive the owning extension host closing its stdout pipes.
for (const stream of [process.stdout, process.stderr]) {
	stream.on('error', (error: NodeJS.ErrnoException) => {
		if (error.code !== 'EPIPE') throw error;
	});
}

import { startServer } from './server';

startServer().catch((err) => {
	console.error(err);
	process.exit(1);
});
