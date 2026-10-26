declare module 'tar' {
	import type { Writable } from 'node:stream';
	export function extract(options: { cwd: string }): Writable;
}
