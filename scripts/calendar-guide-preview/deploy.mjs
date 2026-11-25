// Provision only this pilot's Worker and D1. The invite file contains a hash, never a login link.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../..');
const name = 'veyro-kalenderguide-test';
const remoteConfig = path.join(directory, '.remote.toml');
const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token } = process.env;
if (!/^[a-f\d]{32}$/i.test(account || '') || !token) throw new Error('Cloudflare account and API token required.');
const base = `https://api.cloudflare.com/client/v4/accounts/${account}`;

async function api(endpoint, method = 'GET', body, allowMissingWorker = false) {
  const response = await fetch(base + endpoint, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  const result = await response.json();
  if (allowMissingWorker && result.errors?.some(e => e.code === 10007)) return null;
  if (!response.ok || !result.success) {
    const codes = (result.errors || []).map(e => e.code).join(',');
    throw new Error(`Pilot API ${method} ${endpoint.split('?')[0]} returned ${response.status} (${codes}).`);
  }
  return result.result;
}
function wrangler(...args) {
  execFileSync(path.join(root, 'node_modules/.bin/wrangler'), [...args, '--config', remoteConfig], { cwd: root, stdio: 'inherit' });
}
const databases = await api('/d1/database?name=' + name);
const database = databases.find(db => db.name === name) || await api('/d1/database', 'POST', { name });
if (database.name !== name || !/^[a-f\d-]{36}$/i.test(database.uuid)) throw new Error('Invalid pilot database.');
const template = readFileSync(path.join(directory, 'wrangler.toml'), 'utf8');
if (!template.includes(`name = "${name}"`) || !template.includes(`database_name = "${name}"`) || /^(routes|route)\s*=/m.test(template)) throw new Error('Unexpected pilot configuration.');
writeFileSync(remoteConfig, template.replace('00000000-0000-4000-8000-000000000001', database.uuid));
const temporary = mkdtempSync(path.join(tmpdir(), 'veyro-calendar-'));
try {
  wrangler('d1', 'migrations', 'apply', name, '--remote');
  wrangler('d1', 'execute', name, '--remote', '--file', path.join(directory, 'seed.sql'));
  const invite = JSON.parse(readFileSync(path.join(directory, 'invite.json'), 'utf8'));
  const expiry = Math.floor(Date.parse(invite.expiresAt) / 1000);
  if (!/^[a-f\d]{64}$/.test(invite.sha256) || !Number.isSafeInteger(expiry)) throw new Error('Invalid pilot invitation.');
  await api(`/d1/database/${database.uuid}/query`, 'POST', {
    sql: "INSERT OR IGNORE INTO aj_login_tokens(token_hash,email,expires_at) SELECT ?, 'testperson@example.invalid', ? WHERE ? > unixepoch()",
    params: [invite.sha256, expiry, expiry],
  });
  const keys = ['AJ_CALENDAR_TOKEN_KEY', 'AJ_OUTBOX_KEY'];
  const secrets = await api(`/workers/scripts/${name}/secrets`, 'GET', undefined, true);
  const args = [];
  if (secrets === null) {
    const file = path.join(temporary, 'keys.json');
    writeFileSync(file, JSON.stringify(Object.fromEntries(keys.map(key => [key, randomBytes(32).toString('base64')]))), { mode: 0o600 });
    args.push('--secrets-file', file);
  } else if (!keys.every(key => secrets.some(secret => secret.name === key))) {
    throw new Error('Pilot Worker exists with missing encryption secrets. Restore its original keys before deploying.');
  }
  wrangler('deploy', ...args);
} finally {
  rmSync(remoteConfig, { force: true });
  rmSync(temporary, { recursive: true, force: true });
}
