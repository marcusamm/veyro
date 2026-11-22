// Calendar authorization and rendering against real SQLite migrations and Veyro session middleware.
// This intentionally stops before 0020: calendar access does not depend on complimentary billing.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { html } from 'hono/html';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessionMiddleware } from '../src/lib/session.ts';
import { render } from '../src/render.ts';
import calendarRoute from '../src/routes/booking-calendar.ts';
import { bookingAdminUrl, calendarSelection, getBookingCalendarAccess, getBookingCalendarAccessForCustomer, loadBookingCalendar, validCalendarContract } from '../src/lib/booking-calendar.ts';
import { copenhagenInstants, zonedParts } from '../src/aj/store.ts';

let sqlite, db, app, env;
const now = () => Math.floor(Date.now() / 1000);
const day = '2030-03-31'; // Copenhagen daylight-saving transition; local day is 23 hours.
const month = '2030-03';
const calendarPath = `/konto/kalender?month=${month}&day=${day}`;
function adapter(database) {
  const statement = (sql, values = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => database.prepare(sql).get(...values) ?? null,
    all: async () => ({ results: database.prepare(sql).all(...values), success: true }),
    run: async () => { const result = database.prepare(sql).run(...values); return { success: true, meta: { changes: result.changes } }; },
  });
  return { prepare: sql => statement(sql) };
}
function customer(id, email, contract = true) {
  sqlite.prepare('INSERT INTO customers(id,email,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, email, email, now(), now());
  if (contract) sqlite.prepare('INSERT INTO subscriptions(id,customer_id,status,plan,amount,started_at,current_period_end,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(`sub_${id}`, id, 'active', 'starter', 29900, now() - 100, now() + 86400, now());
}
function booking(id, staffId, date, minute, status = 'confirmed', note = '') {
  const start = copenhagenInstants(date, minute)[0];
  sqlite.prepare(`INSERT INTO aj_bookings(id,service_id,service_name,staff_id,staff_name,start_at,end_at,local_date,local_weekday,local_start,local_end,name,email,phone,registration,note,status,manage_token_hash,mutation_id)
    VALUES(?,1,'Olieskift',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, staffId, staffId === 1 ? 'Owner' : 'Colleague', start, start + 2700, date, zonedParts(start).weekday, minute, minute + 45,
    `Customer ${id}`, `${id}@example.test`, '12345678', 'AB12345', note, status, `secret-hash-${id}`, `secret-mutation-${id}`,
  );
}
async function request(email, path = calendarPath, cookieOverride) {
  let cookie = cookieOverride;
  if (email && cookie === undefined) {
    const raw = createHash('sha256').update(email).digest('hex');
    const hash = createHash('sha256').update(raw).digest('hex');
    sqlite.prepare('INSERT OR REPLACE INTO sessions(id_hash,email,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)').run(hash, email, 'test-csrf', now() + 365 * 86400, now());
    cookie = `__Host-vk_session=${raw}`;
  }
  const res = await app.request(`https://portal.example.test${path}`, { headers: cookie ? { Cookie: cookie } : {} }, env);
  return { res, text: await res.text() };
}
beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync(new URL('../migrations/', import.meta.url)).filter(name => /^00(?:0\d|1\d)_.*\.sql$/.test(name)).sort()) {
    sqlite.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  }
  db = adapter(sqlite);
  customer(1, 'owner@example.test'); customer(2, 'staff@example.test'); customer(3, 'other@example.test'); customer(4, 'registered@example.test', false);
  sqlite.exec(`INSERT INTO aj_staff(id,name,email,role,active) VALUES(1,'Owner','owner@example.test','owner',1),(2,'Colleague','staff@example.test','staff',1),(3,'Former staff','former@example.test','staff',0);
    UPDATE aj_settings SET booking_enabled=1,workshop_email='inbox@example.test';
    UPDATE aj_services SET duration_minutes=45,active=1 WHERE id=1;`);
  for (const member of [1, 2]) for (let weekday = 1; weekday <= 7; weekday++) sqlite.prepare('INSERT INTO aj_hours(staff_id,weekday,start_minute,end_minute) VALUES(?,?,0,1440)').run(member, weekday);
  booking('owner-early', 1, day, 15);
  booking('staff-day', 2, day, 600, 'confirmed', '<img src=x onerror=alert(1)> & "quoted"');
  booking('owner-late', 1, day, 1380);
  booking('cancelled', 1, day, 840, 'cancelled');
  booking('next-day', 1, '2030-04-01', 0);
  env = { DB: db, APP_URL: 'https://portal.example.test', ADMIN_EMAILS: 'other@example.test', RESEND_API_KEY: 'local-test-key', PRICE_STARTER: '', PRICE_BUSINESS: '', PRICE_PREMIUM: '' };
  app = new Hono();
  app.use('*', sessionMiddleware);
  app.route('/konto/kalender', calendarRoute);
  app.get('/konto', c => render(c, 'Overblik', html`<h1>Overblik</h1>`));
});
afterEach(() => sqlite.close());

describe('Booking calendar entitlement', () => {
  it('requires a valid Veyro session before revealing the calendar', async () => {
    for (const cookie of [undefined, '__Host-vk_session=' + 'f'.repeat(64)]) {
      const { res, text } = await request(null, calendarPath, cookie);
      expect(res.status).toBe(303); expect(res.headers.get('location')).toBe('/login');
      expect(text).not.toContain('Customer owner-early');
    }
  });
  it('does not grant access by plan, price, customer registration, customer id query or Veyro admin status', async () => {
    for (const email of ['other@example.test', 'registered@example.test', 'nobody@example.test']) {
      const { res, text } = await request(email, calendarPath + '&customer=1');
      expect(res.status, email).toBe(403);
      expect(text).not.toContain('Customer owner-early');
      expect(text).not.toContain('href="/konto/kalender"');
    }
  });
  it('requires active source membership and a current contract, including after session creation', async () => {
    expect((await request('owner@example.test')).res.status).toBe(200);
    sqlite.exec('UPDATE aj_staff SET active=0 WHERE id=1');
    expect(await getBookingCalendarAccess(db, 'owner@example.test')).toBe(null);
    expect((await request('owner@example.test')).res.status).toBe(403);
    sqlite.exec("UPDATE aj_staff SET active=1 WHERE id=1; UPDATE subscriptions SET status='canceled' WHERE customer_id=1");
    expect((await request('owner@example.test')).res.status).toBe(403);
  });
  it('handles contracts without complimentary columns and refuses a mismatched preloaded customer contract', async () => {
    const access = await getBookingCalendarAccess(db, ' OWNER@EXAMPLE.TEST ');
    expect(access).toMatchObject({ customerId: 1, staffId: 1, role: 'owner', workspace: { id: 'aj-auto', product: 'booking', source: 'aj' } });
    const person = sqlite.prepare('SELECT * FROM customers WHERE id=1').get();
    const wrongContract = sqlite.prepare('SELECT * FROM subscriptions WHERE customer_id=2').get();
    expect(await getBookingCalendarAccessForCustomer(db, person, wrongContract)).toBe(null);
  });
  it('only shows navigation for an entitled customer', async () => {
    expect((await request('owner@example.test', '/konto')).text).toContain('href="/konto/kalender"');
    expect((await request('other@example.test', '/konto')).text).not.toContain('href="/konto/kalender"');
    sqlite.exec("UPDATE subscriptions SET status='canceled' WHERE customer_id=1");
    expect((await request('owner@example.test', '/konto')).text).not.toContain('href="/konto/kalender"');
  });
  it('rejects an unentitled workspace instead of using its query to select a source', async () => {
    const { res, text } = await request('owner@example.test', calendarPath + '&workspace=another-company');
    expect(res.status).toBe(403); expect(text).not.toContain('Customer staff-day');
  });
  it('fails closed if the booking source migration is unavailable', async () => {
    const old = new DatabaseSync(':memory:');
    old.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
    old.exec(`INSERT INTO customers(id,email,created_at,updated_at) VALUES(1,'owner@example.test',0,0);
      INSERT INTO subscriptions(id,customer_id,status,updated_at) VALUES('sub_old',1,'active',0);`);
    try { expect(await getBookingCalendarAccess(adapter(old), 'owner@example.test')).toBe(null); } finally { old.close(); }
  });
});

describe('Calendar source, month and day isolation', () => {
  it('shows the owner all calendars but applies staff selection on counts and appointments', async () => {
    const access = await getBookingCalendarAccess(db, 'owner@example.test');
    const selection = calendarSelection({ month, day });
    const all = await loadBookingCalendar(db, access, selection);
    expect(all.counts[day]).toBe(3);
    expect(all.appointments.map(row => row.id)).toEqual(['owner-early', 'staff-day', 'cancelled', 'owner-late']);
    const filtered = await loadBookingCalendar(db, access, selection, '2');
    expect(filtered.counts[day]).toBe(1);
    expect(filtered.appointments.map(row => row.id)).toEqual(['staff-day']);
    expect(JSON.stringify(all)).not.toMatch(/secret-hash|secret-mutation|manage_token_hash/);
  });
  it('restricts staff to their own data and refuses a different staff calendar', async () => {
    const { res, text } = await request('staff@example.test');
    expect(res.status).toBe(200);
    expect(text).toContain('Customer staff-day');
    expect(text).not.toContain('Customer owner-early'); expect(text).not.toContain('Customer cancelled');
    expect(text).not.toContain('calendar-staff'); expect(text).not.toContain('Indstil bookingtider');
    const forged = await request('staff@example.test', calendarPath + '&staff=1');
    expect(forged.res.status).toBe(403); expect(forged.text).not.toContain('Customer owner-early');
  });
  it('uses Copenhagen midnight boundaries on a DST day and excludes the following day', async () => {
    const { res, text } = await request('owner@example.test');
    expect(res.status).toBe(200);
    expect(text).toContain('Customer owner-early'); expect(text).toContain('Customer owner-late');
    expect(text).not.toContain('Customer next-day');
    expect(text).toContain('00.15'); expect(text).toContain('23.00');
    expect(text).toContain('Aflyst'); expect(text).toContain('3 bekræftede aftaler i måneden');
    expect(res.headers.get('cache-control')).toContain('no-store');
  });
  it('renders a Monday-first six-week grid with working month/day links', async () => {
    const { text } = await request('owner@example.test');
    expect([...text.matchAll(/data-calendar-day=/g)]).toHaveLength(42);
    expect(text).toContain('data-calendar-day="2030-02-25"');
    expect(text).toContain('data-calendar-day="2030-04-07"');
    expect(text).toContain('month=2030-02'); expect(text).toContain('month=2030-04');
    expect(text).toContain('day=2030-03-31#kalender-dag'); expect(text).toContain('aria-current="date"');
    expect(calendarSelection({ month: '2028-02', day: '2028-02-29' }).day).toBe('2028-02-29');
    const empty = await request('owner@example.test', '/konto/kalender?month=2030-03&day=2030-03-30');
    expect(empty.text).toContain('Ingen aftaler denne dag.');
  });
  it('rejects malformed or mismatched date and staff selectors before loading appointment data', async () => {
    for (const query of ['month=2030-13', 'month=2030-02&day=2030-02-30', 'month=2030-03&day=2030-04-01', 'staff=1%20OR%201=1', 'staff=9999']) {
      const { res, text } = await request('owner@example.test', '/konto/kalender?' + query);
      expect(res.status, query).toBe(400); expect(text).not.toContain('Customer staff-day');
    }
  });
  it('escapes appointment details and encodes email links', async () => {
    sqlite.prepare('UPDATE aj_bookings SET name=?,email=?,phone=?,registration=? WHERE id=?').run('<script>bad()</script>', 'bad" onclick="bad()@example.test', '" onmouseover="bad()', '<svg onload=bad()>', 'staff-day');
    const { text } = await request('owner@example.test');
    expect(text).toContain('&lt;script&gt;bad()&lt;/script&gt;');
    expect(text).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(text).toContain('mailto:bad%22%20onclick%3D%22bad()%40example.test');
    expect(text).not.toContain('<script>bad()'); expect(text).not.toContain('<img src=x'); expect(text).not.toContain('<svg onload=bad()>');
    expect(text).not.toMatch(/href="tel:[^"]*onmouseover/);
  });
  it('shows the owner setup action only when online booking is not ready', async () => {
    expect((await request('owner@example.test')).text).not.toContain('Indstil bookingtider');
    sqlite.exec('UPDATE aj_settings SET booking_enabled=0');
    const closed = await request('owner@example.test');
    expect(closed.text).toContain('Vælg varighed på olieskift og de tider, kunder må booke.');
    expect(closed.text).toContain('Indstil bookingtider'); expect(closed.text).toContain('https://aj.veyro.dk/admin');
    expect((await request('staff@example.test')).text).not.toContain('Indstil bookingtider');
  });
});

describe('Contract and link boundary rules', () => {
  it('requires active/trialing status within the actual contract dates', () => {
    const base = { status: 'active', started_at: 1, current_period_end: 200, cancel_at: null };
    expect(validCalendarContract(base, 100)).toBe(true);
    expect(validCalendarContract({ ...base, status: 'trialing' }, 100)).toBe(true);
    for (const status of ['canceled', 'past_due', 'unpaid', 'incomplete', 'paused']) expect(validCalendarContract({ ...base, status }, 100)).toBe(false);
    expect(validCalendarContract({ ...base, current_period_end: 100 }, 100)).toBe(false);
    expect(validCalendarContract({ ...base, cancel_at: 100 }, 100)).toBe(false);
    expect(validCalendarContract({ ...base, started_at: 101 }, 100)).toBe(false);
    expect(validCalendarContract({ ...base, cancel_at: 150 }, 100)).toBe(true);
    expect(validCalendarContract(null, 100)).toBe(false);
  });
  it('only uses trusted HTTPS admin hosts, with an explicit local development exception', () => {
    expect(bookingAdminUrl({})).toBe('https://aj.veyro.dk/admin');
    expect(bookingAdminUrl({ AJ_URL: 'https://workshop.example.test/path', AJ_HOSTS: 'workshop.example.test' })).toBe('https://workshop.example.test/admin');
    for (const url of ['javascript:alert(1)', 'https://evil.example', 'https://user:pass@aj.veyro.dk', 'http://aj.veyro.dk', 'https://aj.veyro.dk:444']) {
      expect(bookingAdminUrl({ AJ_URL: url })).toBe('https://aj.veyro.dk/admin');
    }
    expect(bookingAdminUrl({ DEV_MODE: '1', AJ_HOSTS: 'localhost' }, 'http://127.0.0.1:8791')).toBe('http://localhost:8791/admin');
    expect(bookingAdminUrl({ AJ_HOSTS: 'localhost' }, 'http://127.0.0.1:8791')).toBe('https://aj.veyro.dk/admin');
  });
});
