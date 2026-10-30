import * as fs from 'node:fs';

import { LOG_LIMITS } from '@ungate/shared';

/** Read only complete UTF-8 lines; an unfinished write is retried on the next poll. */
export class LogFileReader {
	private file: string | null = null;
	private offset = 0;
	private skippingLongLine = false;

	read(file: string): string[] {
		if (file !== this.file) {
			this.file = file;
			this.offset = 0;
			this.skippingLongLine = false;
		}
		try {
			const fd = fs.openSync(file, 'r');
			try {
				const size = fs.fstatSync(fd).size;
				if (size < this.offset) {
					this.offset = 0;
					this.skippingLongLine = false;
				}
				const start = Math.max(this.offset, size - LOG_LIMITS.readChunkBytes);
				const skipped = start > this.offset || this.skippingLongLine;
				const bytes = Buffer.alloc(size - start);
				const read = fs.readSync(fd, bytes, 0, bytes.length, start);
				const chunk = bytes.subarray(0, read);
				const end = chunk.lastIndexOf(10);
				if (end < 0) {
					// Bound work even if a process emits a line larger than the read budget.
					if (chunk.length === LOG_LIMITS.readChunkBytes) {
						this.offset = start + read;
						this.skippingLongLine = true;
					}

					return [];
				}
				this.offset = start + end + 1;
				this.skippingLongLine = false;
				const begin = skipped ? chunk.indexOf(10) + 1 : 0;

				return chunk
					.subarray(begin, end + 1)
					.toString('utf8')
					.split(/\r?\n/)
					.filter((line) => line.trim());
			} finally {
				fs.closeSync(fd);
			}
		} catch {
			// The process may not have created its log yet, or may be rotating it.
			return [];
		}
	}
}
