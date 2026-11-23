import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeBatch } from '../scripts/customer-provisioning.mjs';
import { updateOwnerEmail } from '../scripts/customer-email-update.mjs';

const provision = {
  version: 1, system: 'aj', plan: 'starter', amount: 0,
  operationId: 'local_provisioning_1', subscriptionId: 'agreement_local_test_customer',
  email: 'original@example.test', name: 'Workshop Owner', company: 'Test Workshop',
  cvr: '12345678', city: 'Test City', agreementNote: 'Local complimentary agreement.',
  documentSha256: 'd'.repeat(64), websiteUrl: 'https://aj.veyro.dk', websiteAdminUrl: 'https://aj.veyro.dk/admin',
};
const newEmail = 'replacement@example.test';
const colleague = 'colleague@example.test';
const payloadHash = 'f'.repeat(64);
const authTables = ['sessions', 'login_tokens', 'aj_sessions', 'aj_login_tokens'];
let db, change;

async function query(request) {
  if (!request.batch) return [{ results: db.prepare(request.sql).all(...(request.params ?? [])) }];
  db.exec('BEGIN');
  try {
    const results = request.batch.map(q => ({ results: db.prepare(q.sql).all(...(q.params ?? [])) }));
    db.exec('COMMIT');
    return results;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
function addCredentials(email, key = email) {
  db.prepare("INSERT INTO sessions(id_hash,email,csrf_token,expires_at,created_at) VALUES(?,?,'csrf',unixepoch()+3600,unixepoch())").run(key, email);
  db.prepare('INSERT INTO login_tokens(token_hash,email,expires_at,created_at) VALUES(?,?,unixepoch()+3600,unixepoch())').run(key, email);
  db.prepare('INSERT INTO aj_sessions(token_hash,email,expires_at) VALUES(?,?,unixepoch()+3600)').run(key, email);
  db.prepare('INSERT INTO aj_login_tokens(token_hash,email,expires_at) VALUES(?,?,unixepoch()+3600)').run(key, email);
}
const rows = table => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all();

beforeEach(async () => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(migrations).filter(f => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(name, migrations), 'utf8'));
  }
  await query({ batch: writeBatch(provision, 'a'.repeat(64)) });
  db.prepare("INSERT INTO aj_staff(name,email,role) VALUES('Colleague',?,'staff')").run(colleague);
  db.exec(`
    UPDATE aj_staff SET calendar_token_hash='personal-owner-calendar' WHERE role='owner';
    UPDATE aj_settings SET workshop_email='shared@example.test', booking_enabled=1;
    UPDATE aj_services SET duration_minutes=45,active=1 WHERE id=1;
    INSERT INTO aj_hours(staff_id,weekday,start_minute,end_minute) VALUES(1,1,540,960);
    INSERT INTO aj_bookings(id,service_id,service_name,staff_id,staff_name,start_at,end_at,local_date,local_weekday,
      local_start,local_end,name,email,phone,manage_token_hash,mutation_id)
      VALUES('appointment',1,'Olieskift',1,'Workshop Owner',unixepoch('now','+7 days'),unixepoch('now','+7 days')+2700,
        date('now','+7 days'),1,540,585,'Visitor','visitor@example.test','12345678','private-management-link','mutation');
  `);
  for (const email of [provision.email, newEmail, colleague]) addCredentials(email);
  change = { operationId: 'local_email_update_1', newEmail, expiresAt: Math.floor(Date.now()/1000)+3600 };
});
afterEach(() => db.close());

describe('existing workshop owner login email change', () => {
  it('changes both login identities in place, preserving the agreement, bookings and other mechanic', async () => {
    const customer = rows('customers')[0];
    const [owner, other] = rows('aj_staff');
    const keepTables = ['subscriptions', 'aj_bookings', 'aj_hours', 'aj_settings'];
    const before = keepTables.map(rows);
    await updateOwnerEmail(query, provision, change, payloadHash);
    expect(rows('customers')).toHaveLength(1);
    expect(rows('customers')[0]).toMatchObject({ id: customer.id, email: newEmail, name: customer.name });
    expect(rows('aj_staff')).toEqual([{ ...owner, email: newEmail, calendar_token_hash: null }, other]);
    expect(keepTables.map(rows)).toEqual(before);
    for (const table of authTables) expect(rows(table).map(r => r.email)).toEqual([colleague]);
    addCredentials(newEmail, 'new-session');
    await updateOwnerEmail(query, provision, change, payloadHash);
    for (const table of authTables) expect(rows(table).map(r => r.email)).toEqual([colleague, newEmail]);
  });

  it('does not sign the owner out when the requested address is already in use by that same owner', async () => {
    const before = ['aj_staff', ...authTables].map(rows);
    await updateOwnerEmail(query, provision, { ...change, newEmail: provision.email }, payloadHash);
    expect(['aj_staff', ...authTables].map(rows)).toEqual(before);
  });

  it('rolls back identity and credential changes if a legacy address collides after preflight', async () => {
    const queryWithRace = async request => {
      if (request.batch?.some(statement => /^UPDATE customers/i.test(statement.sql))) {
        db.prepare('INSERT INTO customers(email,name,created_at,updated_at) VALUES(?,?,1,1)').run(newEmail.toUpperCase(), 'Concurrent customer');
      }
      return query(request);
    };
    const before = ['aj_staff', ...authTables].map(rows);
    await expect(updateOwnerEmail(queryWithRace, provision, change, payloadHash)).rejects.toThrow();
    expect(rows('customers').map(c => c.email)).toEqual([provision.email, newEmail.toUpperCase()]);
    expect(['aj_staff', ...authTables].map(rows)).toEqual(before);
  });

  it.each(['customers', 'aj_staff'])('rejects a destination that belongs to another %s row without changing either identity', async table => {
    if (table === 'customers') {
      db.prepare('INSERT INTO customers(email,name,created_at,updated_at) VALUES(?,?,1,1)').run(newEmail.toUpperCase(), 'Another customer');
    } else {
      db.prepare("UPDATE aj_staff SET email=? WHERE role='staff'").run(newEmail);
    }
    const tables = ['customers','aj_staff','customer_provisioning_operations',...authTables];
    const before = tables.map(rows);
    await expect(updateOwnerEmail(query, provision, change, payloadHash)).rejects.toThrow();
    expect(tables.map(rows)).toEqual(before);
  });
});
