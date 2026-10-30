import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LOG_LIMITS } from '@ungate/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LogFileReader } from '../../src/utils/log-file-reader';

let directory: string;
let file: string;
beforeEach(() => {
	directory = fs.mkdtempSync(join(tmpdir(), 'ungate-log-reader-'));
	file = join(directory, 'api.log');
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

describe('process log reader', () => {
	it('waits for a full line, normalizes Windows CRLF, and never replays a consumed line', () => {
		const reader = new LogFileReader();
		fs.writeFileSync(file, 'ready\r\npart');
		expect(reader.read(file)).toEqual(['ready']);
		expect(reader.read(file)).toEqual([]);
		fs.appendFileSync(file, 'ial\r\n');
		expect(reader.read(file)).toEqual(['partial']);
		expect(reader.read(file)).toEqual([]);
	});
	it('preserves a Cyrillic UTF-8 character split across writes', () => {
		const reader = new LogFileReader();
		const text = Buffer.from('Ошибка запуска\n');
		fs.writeFileSync(file, text.subarray(0, 1));
		expect(reader.read(file)).toEqual([]);
		fs.appendFileSync(file, text.subarray(1));
		expect(reader.read(file)).toEqual(['Ошибка запуска']);
	});
	it('recovers from an absent file, truncation, and a different process file', () => {
		const reader = new LogFileReader();
		expect(reader.read(file)).toEqual([]);
		fs.writeFileSync(file, 'original long message\n');
		expect(reader.read(file)).toEqual(['original long message']);
		fs.writeFileSync(file, 'new\n');
		expect(reader.read(file)).toEqual(['new']);
		const next = join(directory, 'tunnel.log');
		fs.writeFileSync(next, 'next process\n');
		expect(reader.read(next)).toEqual(['next process']);
	});
	it('bounds reading and skips the partial leading line after falling behind', () => {
		const reader = new LogFileReader();
		fs.writeFileSync(file, `${'x'.repeat(LOG_LIMITS.readChunkBytes + 10)}\nrecent\n`);
		expect(reader.read(file)).toEqual(['recent']);
	});
	it('does not publish the tail of an oversized unfinished line as a new message', () => {
		const reader = new LogFileReader();
		fs.writeFileSync(file, 'x'.repeat(LOG_LIMITS.readChunkBytes));
		expect(reader.read(file)).toEqual([]);
		fs.appendFileSync(file, 'end\nvalid\n');
		expect(reader.read(file)).toEqual(['valid']);
	});
});
