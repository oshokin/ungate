import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, UNGATE_DIR } from '../fs-access';

/** 256-bit administrative capability, persisted as hexadecimal. */
const ADMIN_TOKEN_BYTES = 32;
/** Random suffix prevents concurrent publishers from sharing a staging path. */
const TOKEN_STAGING_NONCE_BYTES = 8;
const ADMIN_TOKEN_PATTERN = new RegExp(`^[a-f0-9]{${ADMIN_TOKEN_BYTES * 2}}$`);

/** A separate local capability: never use the public model key to administer Ungate. */
export function getAdminToken(): string {
	if (process.env.UNGATE_ADMIN_TOKEN) return process.env.UNGATE_ADMIN_TOKEN;
	const dir = path.join(os.homedir(), UNGATE_DIR);
	fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
	const target = path.join(dir, 'admin-token');
	const temporary = `${target}.${process.pid}.${randomBytes(TOKEN_STAGING_NONCE_BYTES).toString('hex')}`;
	try {
		fs.writeFileSync(temporary, randomBytes(ADMIN_TOKEN_BYTES).toString('hex'), { flag: 'wx', mode: PRIVATE_FILE_MODE });
		try {
			// Publish complete bytes atomically, even when two windows start together.
			fs.linkSync(temporary, target);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		}
	} finally {
		fs.rmSync(temporary, { force: true });
	}
	const token = fs.readFileSync(target, 'utf8').trim();
	if (!ADMIN_TOKEN_PATTERN.test(token))
		throw new Error(`Invalid Ungate administration token. Restore ~/${UNGATE_DIR}/admin-token.`);

	return token;
}
