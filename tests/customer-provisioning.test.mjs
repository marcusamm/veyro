// All identities, credentials and databases here are synthetic and local-only.
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openPayload, publicProvisionKey, sealPayload, validatePayload, writeBatch } from '../scripts/customer-provisioning.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = path.join(ROOT, 'scripts/customer-provisioning.mjs');
const token = 'synthetic-provisioning-test-key-not-a-real-secret';
const fixture = () => ({
  version: 1, system: 'aj', plan: 'starter', amount: 0,
  operationId: 'local-test-operation', subscriptionId: 'agreement_local_test_customer',
  email: 'owner@example.test', name: 'Test Owner', company: 'Test Company', cvr: '12345678', city: 'Test City',
  agreementNote: 'Synthetic free agreement. No billing.', documentSha256: 'a'.repeat(64),
  websiteUrl: 'https://aj.veyro.dk', websiteAdminUrl: 'https://aj.veyro.dk/admin',
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
});
const cleanup = [];
afterEach(() => { for (const p of cleanup.splice(0)) rmSync(p, { recursive: true, force: true }); });

function database(filename = ':memory:') {
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys=ON');
  for (const file of ['0001_initial.sql', '0004_offers.sql', '0019_aj_booking.sql', '0020_complimentary_subscriptions.sql']) db.exec(readFileSync(path.join(ROOT, 'migrations', file), 'utf8'));
  return db;
}
function executeBatch(db, queries) {
  db.exec('BEGIN');
  try { for (const q of queries) db.prepare(q.sql).all(...q.params); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
function insertCustomer(db, overrides = {}) {
  const p = { ...fixture(), ...overrides };
  db.prepare('INSERT INTO customers (email,name,company,cvr,city,stripe_customer_id,created_at,updated_at) VALUES (?,?,?,?,?,?,1,1)')
    .run(p.email, p.name, p.company, p.cvr, p.city, overrides.stripe ?? null);
}
function cliFixture(p = fixture()) {
  const dir = mkdtempSync(path.join(tmpdir(), 'veyro-provision-test-'));
  cleanup.push(dir);
  const dbFile = path.join(dir, 'database.sqlite');
  const db = database(dbFile);
  const payloadFile = path.join(dir, 'payload.json');
  writeFileSync(payloadFile, JSON.stringify(sealPayload(publicProvisionKey(token), p)));
  const preload = path.join(dir, 'mock-cloudflare.mjs');
  writeFileSync(preload, `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.env.LOCAL_TEST_DB);
    db.exec('PRAGMA foreign_keys=ON');
    let wrote = false;
    globalThis.fetch = async (url, init) => {
      if (!url.startsWith('https://api.cloudflare.com/client/v4/accounts/') || !url.endsWith('/query')) throw new Error('Unexpected network request');
      const body = JSON.parse(init.body);
      if (body.batch?.some(q => /^INSERT INTO customers/.test(q.sql)) && !wrote) {
        wrote = true;
        if (process.env.LOCAL_TEST_RACE_SQL) db.exec(process.env.LOCAL_TEST_RACE_SQL);
      }
      const queries = body.batch ?? [body];
      try {
        if (body.batch) db.exec('BEGIN');
        const result = queries.map(q => ({ success: true, results: db.prepare(q.sql).all(...(q.params ?? [])) }));
        if (body.batch) db.exec('COMMIT');
        return new Response(JSON.stringify({ success: true, result }), { status: 200 });
      } catch {
        if (body.batch) db.exec('ROLLBACK');
        return new Response(JSON.stringify({ success: false, result: [] }), { status: 400 });
      }
    };
  `);
  const run = extraEnv => spawnSync(process.execPath, ['--import', preload, SCRIPT, payloadFile], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '', CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: 'synthetic-account', LOCAL_TEST_DB: dbFile, ...extraEnv },
  });
  return { db, run, payloadFile };
}

describe('encrypted customer provisioning', () => {
  it('round-trips privately with randomized ciphertext and authenticates both key and payload', () => {
    const p = fixture(), key = publicProvisionKey(token), one = sealPayload(key, p), two = sealPayload(key, p);
    expect(openPayload(token, one)).toEqual(p);
    expect(one.ciphertext).not.toBe(two.ciphertext);
    expect(JSON.stringify(one)).not.toContain(p.email);
    expect(() => openPayload('another-synthetic-test-key-at-least-twenty', one)).toThrow();
    const bytes = Buffer.from(one.ciphertext, 'base64'); bytes[0] ^= 1;
    expect(() => openPayload(token, { ...one, ciphertext: bytes.toString('base64') })).toThrow();
  });
  it('accepts only the authorized free plan and site, with a bounded expiration', () => {
    const p = fixture();
    expect(validatePayload(p)).toBe(p);
    for (const change of [{ amount: 29900 }, { plan: 'business' }, { system: 'other' }, { websiteAdminUrl: 'https://example.test' }, { expiresAt: 1 }, { expiresAt: p.expiresAt + 86400 }, { email: 'OWNER@example.test' }]) {
      expect(() => validatePayload({ ...p, ...change })).toThrow();
    }
  });
  it('creates and verifies exactly one non-billing customer and an isolated site owner', () => {
    const { db, run } = cliFixture();
    const before = db.prepare('SELECT * FROM aj_settings').all();
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"verified":true');
    expect(result.stdout).not.toContain('owner@example.test');
    const sub = db.prepare('SELECT * FROM subscriptions').get();
    expect(sub).toMatchObject({ plan: 'starter', amount: 0, billing_mode: 'complimentary', status: 'active', price_id: null, item_id: null, current_period_end: null });
    expect(db.prepare('SELECT stripe_customer_id FROM customers').get().stripe_customer_id).toBeNull();
    expect(db.prepare('SELECT role,active FROM aj_staff').get()).toEqual({ role: 'owner', active: 1 });
    expect(db.prepare('SELECT * FROM aj_settings').all()).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM customer_provisioning_operations').get().n).toBe(1);
    db.close();
  });
  it('replaying the completed operation never reactivates a canceled agreement or revoked owner', () => {
    const { db, run } = cliFixture();
    expect(run().status).toBe(0);
    db.exec("UPDATE subscriptions SET status='canceled'; UPDATE aj_staff SET active=0;");
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('no changes or reactivation');
    expect(result.stdout).not.toContain('"verified":true');
    expect(db.prepare('SELECT status FROM subscriptions').get().status).toBe('canceled');
    expect(db.prepare('SELECT active FROM aj_staff').get().active).toBe(0);
    db.close();
  });
  it('refuses an existing Stripe customer without clearing billing data or adding site access', () => {
    const { db, run } = cliFixture();
    insertCustomer(db, { stripe: 'cus_synthetic_only' });
    const before = db.prepare('SELECT * FROM customers').all();
    expect(run().status).toBe(1);
    expect(db.prepare('SELECT * FROM customers').all()).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM subscriptions').get().n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM aj_staff').get().n).toBe(0);
    db.close();
  });
  it('refuses an existing mismatched identity without modifying it', () => {
    const { db, run } = cliFixture();
    insertCustomer(db, { cvr: '87654321' });
    const before = db.prepare('SELECT * FROM customers').all();
    expect(run().status).toBe(1);
    expect(db.prepare('SELECT * FROM customers').all()).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM aj_staff').get().n).toBe(0);
    db.close();
  });
  it('rejects a legacy uppercase customer address instead of making a duplicate', () => {
    const { db, run } = cliFixture();
    insertCustomer(db, { email: 'OWNER@example.test' });
    expect(run().status).toBe(1);
    expect(db.prepare('SELECT email FROM customers').all()).toEqual([{ email: 'OWNER@example.test' }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM subscriptions').get().n).toBe(0);
    db.close();
  });
  it('promotes an existing staff member when all three active staff slots are occupied', () => {
    const { db, run } = cliFixture();
    const insert = db.prepare("INSERT INTO aj_staff (name,email,role,active) VALUES (?,?,'staff',1)");
    insert.run('Existing Test Owner', 'owner@example.test');
    insert.run('Test Colleague One', 'one@example.test');
    insert.run('Test Colleague Two', 'two@example.test');
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM aj_staff').get().n).toBe(3);
    expect(db.prepare("SELECT role,active FROM aj_staff WHERE email='owner@example.test'").get()).toEqual({ role: 'owner', active: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM aj_staff WHERE role='staff'").get().n).toBe(2);
    db.close();
  });
  it('rolls back all provisioning writes when the customer identity changes after preflight', () => {
    const { db, run } = cliFixture();
    insertCustomer(db);
    const result = run({ LOCAL_TEST_RACE_SQL: "UPDATE customers SET cvr='87654321'" });
    expect(result.status).toBe(1);
    expect(db.prepare('SELECT cvr FROM customers').get().cvr).toBe('87654321');
    for (const table of ['subscriptions', 'aj_staff', 'customer_provisioning_operations']) expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n).toBe(0);
    db.close();
  });
  it('rolls back site access if billing is attached concurrently after preflight', () => {
    const { db, run } = cliFixture();
    insertCustomer(db);
    expect(run({ LOCAL_TEST_RACE_SQL: "UPDATE customers SET stripe_customer_id='cus_concurrent_test'" }).status).toBe(1);
    expect(db.prepare('SELECT stripe_customer_id FROM customers').get().stripe_customer_id).toBe('cus_concurrent_test');
    for (const table of ['subscriptions', 'aj_staff', 'customer_provisioning_operations']) expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n).toBe(0);
    db.close();
  });
  it('the schema rejects paid prices and renewal schedules on complimentary rows', () => {
    const db = database();
    executeBatch(db, writeBatch(fixture(), 'b'.repeat(64)));
    for (const set of ["amount=29900", "price_id='price_test'", "item_id='si_test'", 'current_period_end=123456', 'payment_failed=1']) {
      expect(() => db.exec(`UPDATE subscriptions SET ${set}`)).toThrow('INVALID_COMPLIMENTARY_SUBSCRIPTION');
    }
    expect(db.prepare('SELECT amount FROM subscriptions').get().amount).toBe(0);
    db.close();
  });
});
