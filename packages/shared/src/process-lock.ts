import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from './fs-access';

function inaccessible(error: unknown): boolean {
	return ['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '');
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);

		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== 'ESRCH';
	}
}

/**
 * Lamport bakery lock on a local filesystem. The unique directory name publishes
 * process identity in the SAME atomic operation that publishes "choosing".
 * Missing tickets mean choosing, never stale. Only positively dead processes
 * are reaped, and paths are never reused, so competing reapers cannot unlink a
 * successor. PID reuse conservatively delays recovery; it cannot steal a lock.
 * The parent directory is permanent (removing it would introduce an ABA race).
 * Requires a local filesystem with coherent directory enumeration and atomic
 * mkdir/rename, and all participants in the same host PID namespace. Network
 * filesystems and concurrent legacy binaries are not supported.
 */
export class ProcessLockAttempt {
	private readonly root: string;
	private readonly name = `${process.pid}-${randomUUID()}`;
	private readonly entry: string;
	private ticket = 0;
	private published = false;
	private released = false;

	constructor(target: string) {
		// Old binaries do not participate in the bakery protocol. Never silently
		// bypass their locks, including ownerless publication/recovery windows.
		if (fs.existsSync(target) || fs.existsSync(`${target}.recovery`)) {
			throw new Error(`Legacy lock requires stopping all Ungate processes and removing it: ${target}`);
		}
		this.root = `${target}.tickets`;
		fs.mkdirSync(this.root, { recursive: true, mode: PRIVATE_DIR_MODE });
		this.entry = path.join(this.root, this.name);
		fs.mkdirSync(this.entry, { mode: PRIVATE_DIR_MODE });
	}

	private entries(): string[] {
		return fs.readdirSync(this.root).filter((name) => /^[1-9]\d*-[0-9a-f-]{36}$/.test(name));
	}

	private read(name: string): number | null | 'inaccessible' {
		try {
			const value = Number(fs.readFileSync(path.join(this.root, name, 'ticket'), 'utf8'));
			if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid process lock ticket');

			return value;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
			if (inaccessible(error)) return 'inaccessible';
			throw error;
		}
	}

	tryAcquire(): boolean {
		if (this.released) throw new Error('Process lock attempt already released');
		if (!this.ticket) {
			let maximum = 0;
			for (const name of this.entries()) {
				const ticket = this.read(name);
				// An unreadable published ticket may exceed every readable ticket.
				// Do not publish a number based on an incomplete maximum.
				if (ticket === 'inaccessible') return false;
				maximum = Math.max(maximum, ticket ?? 0);
			}
			this.ticket = maximum + 1;
			if (!Number.isSafeInteger(this.ticket)) throw new Error('Process lock ticket overflow');
			// Publication is atomic: an interrupted write remains "choosing".
			fs.writeFileSync(path.join(this.entry, 'pending'), String(this.ticket), { mode: PRIVATE_FILE_MODE, flag: 'wx' });
			fs.renameSync(path.join(this.entry, 'pending'), path.join(this.entry, 'ticket'));
			this.published = true;
		}
		// Publication failures propagate, and retrying the same attempt must
		// never enter the critical section with an unpublished ticket.
		if (!this.published) throw new Error('Process lock ticket publication failed');
		for (const name of this.entries()) {
			if (name === this.name) continue;
			const pid = Number(name.slice(0, name.indexOf('-')));
			if (!alive(pid)) {
				try {
					fs.rmSync(path.join(this.root, name), { recursive: true, force: true });
				} catch (error) {
					// Concurrent Windows readers/reapers can temporarily deny deletion.
					// Keep the entry and let the caller's bounded poll retry.
					if (inaccessible(error)) return false;
					throw error;
				}
				continue;
			}
			const ticket = this.read(name);
			// A concurrently released entry is harmless; treating it as choosing
			// merely defers acquisition until the next poll.
			if (ticket === null || ticket === 'inaccessible' || ticket < this.ticket || (ticket === this.ticket && name < this.name))
				return false;
		}

		return true;
	}

	release(): void {
		if (this.released) return;
		this.released = true;
		fs.rmSync(this.entry, { recursive: true, force: true });
	}
}
