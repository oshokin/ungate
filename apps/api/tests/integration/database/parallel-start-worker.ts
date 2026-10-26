import { Settings } from '../../../src/database/app-settings';
import { getSqlite } from '../../../src/database';

const settings = Settings.get();
const sqlite = getSqlite();
const integrity = sqlite.pragma('integrity_check', { simple: true });
const rowCount = sqlite.prepare('SELECT COUNT(*) AS count FROM app_settings WHERE id = 1').get() as { count: number };

process.stdout.write(JSON.stringify({ apiKey: settings.apiKey, integrity, rowCount: rowCount.count }));
