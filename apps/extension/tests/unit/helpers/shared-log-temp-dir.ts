import * as os from 'node:os';
import * as path from 'node:path';

export const sharedLogTestBaseDir = path.join(os.tmpdir(), `ungate-shared-log-store-${process.pid}`);
export const sharedLogTestDir = path.join(sharedLogTestBaseDir, 'logs');
