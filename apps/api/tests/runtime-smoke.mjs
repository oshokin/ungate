// Run after building shared and API: node apps/api/tests/runtime-smoke.mjs
// A real child, real HTTP and real SQLite; no provider traffic and no user database.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'ungate-http-smoke-'));
const admin = randomBytes(32).toString('hex');
const child = spawn(process.execPath, [process.env.UNGATE_SMOKE_ENTRY || fileURLToPath(new URL('../dist/main.js', import.meta.url))], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: { ...process.env, DB_PATH: join(dir, 'data.db'), PORT: '0', UNGATE_ADMIN_TOKEN: admin },
  stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
child.stdout.on('data', (bytes) => { log += bytes.toString(); });
child.stderr.on('data', (bytes) => { log += bytes.toString(); });
try {
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`API startup timeout: ${log}`)), 10000);
    child.once('error', reject);
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`API exited (${code}): ${log}`)); });
    child.stdout.on('data', () => {
      const match = /listening on localhost:(\d+)/.exec(log);
      if (match) { clearTimeout(timeout); resolve(Number(match[1])); }
    });
  });
  const call = (path, token, method = 'GET', body) => fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000)
  });
  let checks = 0;
  for (const path of ['/settings', '/usage']) {
    const preflight = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'OPTIONS', headers: { Origin: 'vscode-webview://smoke', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
    assert.equal(preflight.status, 204); checks++;
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*'); checks++;
  }
  const usageResponse = await call('/usage', admin);
  const usage = await usageResponse.json();
  assert.equal(usage.providers.length, 3); checks++;
  assert.ok(usage.providers.every(provider => provider.status === 'not_connected')); checks++;
  assert.equal((await call('/analytics', admin)).status, 404); checks++;
  assert.equal((await call('/analytics/requests', admin)).status, 404); checks++;

  for (const path of ['/settings', '/auth/claude/status', '/auth/openai/status', '/usage']) {
    assert.equal((await call(path)).status, 403); checks++;
  }
  const response = await call('/settings', admin);
  assert.equal(response.status, 200); checks++;
  const settings = await response.json();
  assert.ok(settings.apiKey.length >= 32); checks++;
  assert.equal((await call('/settings', settings.apiKey)).status, 403); checks++;
  assert.equal((await call('/v1/models')).status, 403); checks++;
  assert.equal((await call('/v1/models', settings.apiKey)).status, 200); checks++;
  for (const apiKey of [null, '', '   ']) { assert.equal((await call('/settings', admin, 'POST', { apiKey })).status, 400); checks++; }
  const rotated = randomBytes(32).toString('hex');
  assert.equal((await call('/settings', admin, 'POST', { apiKey: rotated })).status, 200); checks++;
  assert.equal((await call('/v1/models', settings.apiKey)).status, 403); checks++;
  assert.equal((await call('/v1/models', rotated)).status, 200); checks++;
  const health = await (await call('/health')).json();
  assert.equal(health.service, 'ungate'); checks++;
  assert.equal(health.status, 'ok'); checks++;
  assert.equal(health.pid, undefined); checks++;
  const adminHealth = await (await call('/admin/health', admin)).json();
  assert.equal(adminHealth.pid, child.pid); checks++;
  assert.equal(adminHealth.version, JSON.parse(readFileSync(new URL('../../extension/package.json', import.meta.url), 'utf8')).version); checks++;
  assert.equal(adminHealth.protocolVersion, 3); checks++;
  assert.equal((await call('/admin/shutdown', undefined, 'POST')).status, 403); checks++;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  assert.equal((await call('/admin/shutdown', admin, 'POST')).status, 200); checks++;
  assert.equal(await exited, 0); checks++;
  console.log(JSON.stringify({ result: 'PASS', checks, binding: '127.0.0.1', providersCalled: false, userDatabaseTouched: false }));
} finally {
  child.kill();
  rmSync(dir, { recursive: true, force: true });
}
