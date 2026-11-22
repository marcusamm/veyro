// AJ Auto integration tests use a fresh local D1 and the local Resend simulator.
// No real customer or workshop receives mail, and no production database is touched.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_EMAIL, Client, ROOT, setMockState, startStack, waitFor } from './harness.mjs';

let stack;
let operator;
let ownerId;
let colleagueId;
let serviceId;
const workshopEmail = 'workshop@example.test';
const ownerEmail = 'owner@example.test';
const colleagueEmail = 'mechanic@example.test';

class AjClient extends Client {
  async json(method, pathname, body, headers = {}) {
    const response = await fetch(this.base + pathname, {
      method,
      redirect: 'manual',
      headers: {
        Cookie: this.cookieHeader(),
        'CF-Connecting-IP': this.ip,
        ...(method === 'GET' ? {} : { Origin: this.base, 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    this.store(response);
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { text }; }
    return { status: response.status, headers: response.headers, data, text };
  }
  read(pathname) { return this.json('GET', pathname); }
  send(pathname, body, headers) { return this.json('POST', pathname, body, headers); }
}

function sql(query) {
  for (let attempt = 0; ; attempt++) {
    try {
      const output = execFileSync(path.join(ROOT, 'node_modules', '.bin', 'wrangler'), [
        'd1', 'execute', 'veyro-kundepanel', '--local', '--persist-to', stack.persist,
        '--json', '--command', query,
      ], { cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: 'pipe' }).toString();
      return JSON.parse(output)[0].results;
    } catch (error) {
      // A second local workerd process can briefly race SQLite WAL recovery.
      // Retry only read-only inspection, never a write or an application failure.
      if (attempt >= 2 || !/^SELECT\b/i.test(query) || !/SQLITE_BUSY/.test(String(error.stderr))) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * (attempt + 1));
    }
  }
}

const mails = async () => (await fetch(stack.mock.url + '/__mock/emails')).json();
const mailToken = mail => {
  const link = mail.text.match(/https?:\/\/\S+/g).find(value => value.includes('token='));
  const url = new URL(link);
  return url.searchParams.get('token') || new URLSearchParams(url.hash.slice(1)).get('token');
};
const dayAfter = (days) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

function expectSuccess(response) {
  expect(response.status, response.text).toBeGreaterThanOrEqual(200);
  expect(response.status, response.text).toBeLessThan(300);
  return response.data;
}

async function adminData() { return expectSuccess(await operator.read('/api/admin/data')); }

async function available(date, staffId = ownerId) {
  const client = new AjClient(stack.base);
  return expectSuccess(await client.read(`/api/slots?serviceId=${serviceId}&staffId=${staffId}&date=${date}`)).slots;
}

function bookingInput(slot, email = 'customer@example.test') {
  return {
    serviceId, staffId: slot.staffId, startAt: slot.startAt,
    name: 'Testkunde ÆØÅ', email, phone: '12345678', registration: 'AB12345', note: 'Kun lokale testdata.',
  };
}

async function reserve(slot, email = 'customer@example.test') {
  const before = (await mails()).length;
  const response = await new AjClient(stack.base).send('/api/bookings', bookingInput(slot, email));
  expectSuccess(response);
  const mail = await waitFor(async () => (await mails()).slice(before).find(item => item.to.includes(email)));
  const token = mailToken(mail);
  await waitFor(async () => (await mails()).slice(before).find(item => item.to.includes(workshopEmail)));
  const data = await adminData();
  const booking = data.bookings.find(item => item.email === email && item.startAt === slot.startAt);
  expect(booking).toBeTruthy();
  return { response, token, booking, before };
}

async function signIn(email) {
  const client = new AjClient(stack.base);
  const before = (await mails()).length;
  const requested = await client.send('/api/admin/login', { email });
  expect(requested.status, requested.text).toBe(200);
  const mail = await waitFor(async () => (await mails()).slice(before).find(item => item.to.includes(email)));
  const token = mailToken(mail);
  const verified = await client.send('/api/admin/verify', { token });
  expect(verified.status, verified.text).toBe(200);
  return { client, token };
}

beforeAll(async () => {
  stack = await startStack({ extraVars: { AJ_HOSTS: '127.0.0.1', AJ_URL: '', AJ_OUTBOX_KEY: randomBytes(32).toString('base64') } });
}, 120_000);

afterAll(async () => { await stack?.stop(); });

describe('AJ Auto configuration and access', () => {
  it('starts closed without invented staff, opening hours or a public campaign', async () => {
    const publicClient = new AjClient(stack.base);
    const configuration = await publicClient.read('/api/config');
    expect(configuration.status, configuration.text).toBe(200);
    expect(configuration.data.bookingReady).toBe(false);
    expect(configuration.data.contactReady).toBe(true);
    expect(configuration.data.contactEmailReady).toBe(false);
    expect(configuration.data.campaign).toBeNull();
    expect(configuration.data.staff).toEqual([]);
    const contact = await publicClient.send('/api/contact', {
      name: 'Test', email: 'closed@example.test', phone: '12345678', message: 'Denne test må ikke påstå, at mail er sendt.', website: '',
    });
    expectSuccess(contact);
    expect(contact.data.notificationStatus).toBe('not_configured');
  });

  it('protects administration and rejects cross-site JSON writes', async () => {
    const anonymous = new AjClient(stack.base);
    const read = await anonymous.read('/api/admin/data');
    expect(read.status).toBe(401);
    const crossSite = await anonymous.send('/api/admin/login', { email: ADMIN_EMAIL }, { Origin: 'https://untrusted.example' });
    expect(crossSite.status).toBe(403);
  });

  it('authenticates a configured operator with a single-use email link', async () => {
    const signed = await signIn(ADMIN_EMAIL);
    operator = signed.client;
    const session = await operator.read('/api/admin/session');
    expect(session.status, session.text).toBe(200);
    const replay = await new AjClient(stack.base).send('/api/admin/verify', { token: signed.token });
    expect(replay.status).toBeGreaterThanOrEqual(400);
    const administration = await operator.read('/api/admin/data');
    expect(administration.status, administration.text).toBe(200);
  });

  it('does not reveal whether an email belongs to an administrator', async () => {
    const before = (await mails()).length;
    const response = await new AjClient(stack.base).send('/api/admin/login', { email: 'not-a-user@example.test' });
    expect(response.status, response.text).toBe(200);
    expect((await mails()).length).toBe(before);
  });
});

describe('AJ Auto workshop setup', () => {
  it('requires actual service duration and hours before offering appointments', async () => {
    expectSuccess(await operator.send('/api/admin/staff', { name: 'Test Owner', email: ownerEmail, role: 'owner', active: true }));
    expectSuccess(await operator.send('/api/admin/staff', { name: 'Test Mechanic', email: colleagueEmail, role: 'staff', active: true }));
    let data = await adminData();
    ownerId = data.staff.find(item => item.email === ownerEmail).id;
    colleagueId = data.staff.find(item => item.email === colleagueEmail).id;
    serviceId = data.services.find(item => item.name.toLowerCase().includes('olie')).id;
    expectSuccess(await operator.send('/api/admin/settings', {
      workshopEmail, bookingEnabled: true,
      campaign: { enabled: false, confirmed: false, title: 'Testkampagne', priceOre: 90000, expiresOn: null },
    }));
    expect((await new AjClient(stack.base).read('/api/config')).data.bookingReady).toBe(false);
    expectSuccess(await operator.send('/api/admin/services', {
      id: serviceId, name: 'Olieskift', description: 'Lokalt testforløb', durationMinutes: 45, active: true,
    }));
    expect(await available(dayAfter(8))).toEqual([]);
    for (const staffId of [ownerId, colleagueId]) {
      for (let day = 1; day <= 7; day++) {
        expectSuccess(await operator.send('/api/admin/hours', { staffId, weekday: day, startTime: '09:00', endTime: '17:00' }));
      }
    }
    const config = expectSuccess(await new AjClient(stack.base).read('/api/config'));
    expect(config.bookingReady).toBe(true);
    expect(config.contactReady).toBe(true);
    expect(config.staff.every(item => !('email' in item) && !('calendarToken' in item))).toBe(true);
    const slots = await available(dayAfter(8));
    expect(slots.length).toBeGreaterThan(0);
    const format = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Copenhagen', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    expect(format.format(new Date(slots[0].startAt))).toBe('09:00');
    for (const slot of slots) {
      const start = new Date(slot.startAt);
      expect(format.format(start) >= '09:00').toBe(true);
      expect(format.format(new Date(start.getTime() + 45 * 60_000)) <= '17:00').toBe(true);
    }
  });

  it('counts the owner and rejects a fourth staff member', async () => {
    expectSuccess(await operator.send('/api/admin/staff', { name: 'Test Third', email: 'third@example.test', role: 'staff', active: true }));
    const fourth = await operator.send('/api/admin/staff', { name: 'Test Fourth', email: 'fourth@example.test', role: 'staff', active: true });
    expect(fourth.status).toBeGreaterThanOrEqual(400);
    const data = await adminData();
    expect(data.staff.filter(item => item.active)).toHaveLength(3);
  });

  it('never publishes an unconfirmed or expired campaign', async () => {
    const settings = { workshopEmail, bookingEnabled: true };
    const unconfirmed = await operator.send('/api/admin/settings', {
      ...settings, campaign: { enabled: true, confirmed: false, title: 'Olieskift', priceOre: 90000, expiresOn: dayAfter(7) },
    });
    expect([200, 400]).toContain(unconfirmed.status);
    expect((await new AjClient(stack.base).read('/api/config')).data.campaign).toBeNull();
    const expired = await operator.send('/api/admin/settings', {
      ...settings, campaign: { enabled: true, confirmed: true, title: 'Olieskift', priceOre: 90000, expiresOn: '2020-01-01' },
    });
    expect([200, 400]).toContain(expired.status);
    expect((await new AjClient(stack.base).read('/api/config')).data.campaign).toBeNull();
    expectSuccess(await operator.send('/api/admin/settings', {
      ...settings, campaign: { enabled: true, confirmed: true, title: 'Olieskift', priceOre: 90000, expiresOn: dayAfter(7) },
    }));
    expect((await new AjClient(stack.base).read('/api/config')).data.campaign.priceOre).toBe(90000);
  });
});

describe('AJ Auto appointment lifecycle', () => {
  it('persists a booking, mails both parties, then moves and cancels through the secure customer link', async () => {
    const date = dayAfter(9);
    const slots = await available(date);
    const booked = await reserve(slots[0], 'lifecycle@example.test');
    const customer = new AjClient(stack.base);
    const managed = await customer.read('/api/manage?token=' + booked.token);
    expectSuccess(managed);
    expect(managed.text).toContain('lifecycle@example.test');
    const remaining = await available(date);
    expect(remaining.some(slot => slot.startAt === slots[0].startAt)).toBe(false);
    const next = remaining.at(-1);
    const beforeMove = (await mails()).length;
    expectSuccess(await customer.send('/api/manage/reschedule', { token: booked.token, startAt: next.startAt, staffId: next.staffId }));
    await waitFor(async () => (await mails()).length >= beforeMove + 2);
    const moved = (await adminData()).bookings.find(item => item.id === booked.booking.id);
    expect(moved.startAt).toBe(next.startAt);
    expect((await available(date)).some(slot => slot.startAt === slots[0].startAt)).toBe(true);
    const beforeCancel = (await mails()).length;
    const moveMail = (await mails()).slice(beforeMove).find(item => item.to.includes('lifecycle@example.test'));
    expectSuccess(await customer.send('/api/manage/cancel', { token: mailToken(moveMail) }));
    await waitFor(async () => (await mails()).length >= beforeCancel + 2);
    const cancelled = (await adminData()).bookings.find(item => item.id === booked.booking.id);
    expect(cancelled.status).toBe('cancelled');
    expect((await available(date)).some(slot => slot.startAt === next.startAt)).toBe(true);
    for (const offset of [booked.before, beforeMove, beforeCancel]) {
      const recipients = (await mails()).slice(offset, offset + 2).flatMap(item => item.to).sort();
      expect(recipients).toEqual(['lifecycle@example.test', workshopEmail].sort());
    }
  });

  it('accepts only one of simultaneous overlapping bookings on the same calendar', async () => {
    const slots = await available(dayAfter(10));
    expect(new Date(slots[1].startAt).getTime() - new Date(slots[0].startAt).getTime()).toBeLessThan(45 * 60_000);
    const requests = Array.from({ length: 6 }, (_, index) => new AjClient(stack.base).send('/api/bookings', bookingInput(slots[index % 2], `race-${index}@example.test`)));
    const responses = await Promise.all(requests);
    expect(responses.filter(item => item.status >= 200 && item.status < 300)).toHaveLength(1);
    for (const response of responses.filter(item => item.status >= 300)) expect(response.status, response.text).toBe(409);
    const records = (await adminData()).bookings.filter(item => item.email.startsWith('race-') && item.staffId === ownerId && item.status !== 'cancelled');
    expect(records).toHaveLength(1);
    const otherStaff = await available(dayAfter(10), colleagueId);
    const parallel = otherStaff.find(item => item.startAt === records[0].startAt);
    expect(parallel).toBeTruthy();
    await reserve(parallel, 'other-calendar@example.test');
  });

  it('rejects a conflicting move without losing the original appointment', async () => {
    const slots = await available(dayAfter(11));
    const first = await reserve(slots[0], 'move-first@example.test');
    const second = await reserve(slots.at(-1), 'move-second@example.test');
    const response = await new AjClient(stack.base).send('/api/manage/reschedule', {
      token: second.token, staffId: first.booking.staffId, startAt: first.booking.startAt,
    });
    expect(response.status, response.text).toBe(409);
    const record = (await adminData()).bookings.find(item => item.id === second.booking.id);
    expect(record.startAt).toBe(second.booking.startAt);
    expect(record.status).not.toBe('cancelled');
  });

  it('honours blocked periods and rejects a server request outside opening hours', async () => {
    const date = dayAfter(12);
    const slots = await available(date);
    const startAt = slots[0].startAt;
    const endAt = new Date(new Date(startAt).getTime() + 60 * 60_000).toISOString();
    expectSuccess(await operator.send('/api/admin/blocks', { staffId: ownerId, startAt, endAt, reason: 'Lokal testblokering' }));
    const remaining = await available(date);
    expect(remaining.some(slot => new Date(slot.startAt) < new Date(endAt))).toBe(false);
    const blocked = await new AjClient(stack.base).send('/api/bookings', bookingInput(slots[0], 'blocked@example.test'));
    expect(blocked.status, blocked.text).toBe(409);
    const early = new Date(new Date(startAt).getTime() - 60 * 60_000).toISOString();
    const outsideHours = await new AjClient(stack.base).send('/api/bookings', { ...bookingInput(slots[0]), startAt: early });
    expect(outsideHours.status).toBeGreaterThanOrEqual(400);
    expect((await adminData()).bookings.some(item => item.email === 'blocked@example.test')).toBe(false);
  });

  it('rejects fabricated management links and keeps raw access tokens out of booking rows', async () => {
    const slots = await available(dayAfter(13));
    const booked = await reserve(slots[0], 'token@example.test');
    const intruder = new AjClient(stack.base);
    expect((await intruder.read('/api/manage?token=' + 'x'.repeat(43))).status).toBeGreaterThanOrEqual(400);
    expect((await intruder.send('/api/manage/cancel', { token: 'x'.repeat(43) })).status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(sql('SELECT * FROM aj_bookings'))).not.toContain(booked.token);
  });
});

describe('AJ Auto individual access and calendar', () => {
  it('shows staff only their own appointments and blocks changes to another calendar', async () => {
    const mechanic = (await signIn(colleagueEmail)).client;
    const view = expectSuccess(await mechanic.read('/api/admin/data'));
    expect(view.bookings.length).toBeGreaterThan(0);
    expect(view.bookings.every(item => item.staffId === colleagueId)).toBe(true);
    const someoneElses = (await adminData()).bookings.find(item => item.staffId === ownerId && item.status !== 'cancelled');
    expect((await mechanic.send(`/api/admin/bookings/${someoneElses.id}/cancel`, {})).status).toBe(403);
    expect((await mechanic.send('/api/admin/settings', { workshopEmail: 'hijack@example.test', bookingEnabled: false })).status).toBe(403);
  });

  it('provides a revocable calendar feed scoped to one staff member', async () => {
    const mechanic = (await signIn(colleagueEmail)).client;
    const first = expectSuccess(await mechanic.send('/api/admin/calendar', { staffId: colleagueId }));
    const firstUrl = new URL(first.url.replace(/^webcal:/, 'http:'));
    const firstPath = firstUrl.pathname + firstUrl.search;
    const feed = await mechanic.get(firstPath);
    expect(feed.status, feed.html).toBe(200);
    expect(feed.html).toContain('BEGIN:VCALENDAR');
    const appointments = (await adminData()).bookings;
    const own = appointments.find(item => item.email === 'other-calendar@example.test');
    const someoneElses = appointments.find(item => item.email === 'move-first@example.test');
    expect(feed.html).toContain(own.id);
    expect(feed.html).not.toContain(someoneElses.id);
    const second = expectSuccess(await mechanic.send('/api/admin/calendar', { staffId: colleagueId }));
    expect(second.url).not.toBe(first.url);
    expect((await mechanic.get(firstPath)).status).toBeGreaterThanOrEqual(400);
    expect((await new AjClient(stack.base).get('/api/calendar.ics?token=guess')).status).toBeGreaterThanOrEqual(400);
    expect((await mechanic.send('/api/admin/calendar', { staffId: ownerId })).status).toBe(403);
  });
});

describe('AJ Auto delivery and contact', () => {
  it('saves contact requests and sends the workshop a safe replyable message', async () => {
    const before = (await mails()).length;
    const response = await new AjClient(stack.base).send('/api/contact', {
      name: 'Test <script>alert(1)</script>', email: 'contact@example.test', phone: '12345678', message: 'En testbesked om olieskift.', website: '',
    });
    expectSuccess(response);
    const mail = await waitFor(async () => (await mails()).slice(before).find(item => item.to.includes(workshopEmail)));
    expect(mail.reply_to).toBe('contact@example.test');
    expect(mail.html).not.toContain('<script>');
    expect(mail.text).toContain('En testbesked om olieskift.');
    expect(sql("SELECT email,message FROM aj_messages WHERE email='contact@example.test'")).toEqual([
      { email: 'contact@example.test', message: 'En testbesked om olieskift.' },
    ]);
  });

  it('keeps a saved booking when mail delivery fails and retries both notifications', async () => {
    const date = dayAfter(14);
    const slots = await available(date);
    const email = 'mail-retry@example.test';
    await setMockState(stack.mock, { failEmailTo: [email, workshopEmail] });
    const before = (await mails()).length;
    try {
      const response = await new AjClient(stack.base).send('/api/bookings', bookingInput(slots[0], email));
      expectSuccess(response);
      expect(response.data.notificationStatus).toBe('pending');
      expect((await adminData()).bookings.some(item => item.email === email)).toBe(true);
      expect((await mails()).length).toBe(before);
      const pending = sql("SELECT payload,status FROM aj_outbox WHERE status='failed'");
      expect(pending).toHaveLength(2);
      expect(JSON.stringify(pending)).not.toContain(email);
      expect(JSON.stringify(pending)).not.toContain(response.data.manageUrl);
    } finally {
      await setMockState(stack.mock, { failEmailTo: [] });
    }
    expectSuccess(await operator.send('/api/admin/retry-mail', {}));
    await waitFor(async () => {
      const delivered = (await mails()).slice(before);
      return delivered.some(item => item.to.includes(email)) && delivered.some(item => item.to.includes(workshopEmail));
    });
    expect(sql("SELECT count(*) AS n FROM aj_outbox WHERE status='sent' AND payload<>''")[0].n).toBe(0);
    expect((await mails()).some(item => item.to.includes(workshopEmail) && item.text.includes('Denne test må ikke påstå, at mail er sendt.'))).toBe(true);
  });

  it('keeps cancellation notifications pending while the workshop mailbox is disconnected', async () => {
    const booked = await reserve((await available(dayAfter(16)))[0], 'deferred-cancellation@example.test');
    const before = (await mails()).length;
    expectSuccess(await operator.send('/api/admin/settings', { workshopEmail: '' }));
    try {
      const customer = new AjClient(stack.base);
      const cancelled = await customer.send('/api/manage/cancel', { token: booked.token });
      expectSuccess(cancelled);
      expect(cancelled.data.notificationStatus).toBe('not_configured');
      const repeated = await customer.send('/api/manage/cancel', { token: booked.token });
      expectSuccess(repeated);
      expect(repeated.data.notificationStatus).not.toBe('sent');
      expect((await mails()).length).toBe(before);
      expect((await adminData()).bookings.find(item => item.id === booked.booking.id).status).toBe('cancelled');
    } finally {
      expectSuccess(await operator.send('/api/admin/settings', { workshopEmail }));
    }
    expectSuccess(await operator.send('/api/admin/retry-mail', {}));
    const delivered = (await mails()).slice(before);
    expect(delivered.filter(item => item.to.includes('deferred-cancellation@example.test'))).toHaveLength(1);
    expect(delivered.filter(item => item.to.includes(workshopEmail))).toHaveLength(1);
  });

  it('does not report success or reserve a slot if the atomic notification write fails', async () => {
    const slot = (await available(dayAfter(15)))[0];
    const before = (await mails()).length;
    sql("CREATE TRIGGER aj_test_outbox_failure BEFORE INSERT ON aj_outbox BEGIN SELECT RAISE(ABORT,'TEST_OUTBOX_FAILURE'); END");
    try {
      const failed = await new AjClient(stack.base).send('/api/bookings', bookingInput(slot, 'database-failure@example.test'));
      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(sql("SELECT count(*) AS n FROM aj_bookings WHERE email='database-failure@example.test'")[0].n).toBe(0);
      expect((await available(dayAfter(15))).some(item => item.startAt === slot.startAt)).toBe(true);
      expect((await mails()).length).toBe(before);
    } finally {
      sql('DROP TRIGGER aj_test_outbox_failure');
    }
  });
});

describe('AJ Auto browser journeys', () => {
  for (const [index, viewport] of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'mobile', width: 390, height: 844 }].entries()) {
    it(`completes booking, moving, cancellation and contact on ${viewport.name} without layout or console errors`, async () => {
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, locale: 'da-DK', timezoneId: 'Europe/Copenhagen' });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      const directory = path.join(ROOT, 'test-results', 'aj-auto');
      mkdirSync(directory, { recursive: true });
      const screenshot = async suffix => {
        await page.evaluate(() => window.scrollTo(0, 0));
        const overflow = await page.evaluate(() => ({ screen: document.documentElement.clientWidth, page: document.documentElement.scrollWidth }));
        expect(overflow.page, `${viewport.name} ${suffix} horizontal overflow`).toBeLessThanOrEqual(overflow.screen + 1);
        expect(await page.getByRole('heading', { level: 1 }).count()).toBe(1);
        expect(await page.title()).toContain('AJ Auto');
        expect((await page.locator('meta[name=description]').getAttribute('content')).length).toBeGreaterThan(20);
        await page.screenshot({ path: path.join(directory, `${viewport.name}-${suffix}.png`), fullPage: true });
      };
      const email = `browser-${viewport.name}@example.test`;
      const beforeBooking = (await mails()).length;
      try {
        await page.goto(stack.base + '/');
        await page.getByRole('heading', { level: 1 }).waitFor();
        await screenshot('home');
        if (viewport.name === 'mobile') {
          await page.getByRole('button', { name: /Menu/ }).click();
          expect(await page.getByRole('button', { name: /Menu/ }).getAttribute('aria-expanded')).toBe('true');
          await page.locator('#navigation').getByRole('link', { name: /Book tid/ }).click();
        } else {
          await page.locator('.hero-copy').getByRole('link', { name: /Book tid/ }).click();
        }
        await page.locator('[data-service]').first().click();
        await page.locator('#booking-date').fill(dayAfter(20 + index * 2));
        await Promise.all([
          page.waitForResponse(response => response.url().includes('/api/slots?') && response.url().includes('staffId=' + ownerId) && response.url().includes('date=' + dayAfter(20 + index * 2))),
          page.locator('#booking-staff').selectOption(String(ownerId)),
        ]);
        await page.locator('[data-slot]').first().waitFor();
        await screenshot('available-times');
        await page.locator('[data-slot]').first().click();
        await page.locator('#next-details').click();
        await page.locator('#details-form [name=name]').fill('Browser Test ÆØÅ');
        await page.locator('#details-form [name=email]').fill(email);
        await page.locator('#details-form [name=phone]').fill('12345678');
        await page.locator('#details-form [name=registration]').fill('UI12345');
        await page.locator('#details-form [name=note]').fill('Kun lokale browser-testdata.');
        await page.getByRole('button', { name: /Gennemse/ }).click();
        await page.getByRole('heading', { name: 'Ser det rigtigt ud?' }).waitFor();
        expect(await page.locator('.booking-summary').innerText()).toContain(email);
        const [createdResponse] = await Promise.all([
          page.waitForResponse(response => response.url().endsWith('/api/bookings') && response.request().method() === 'POST'),
          page.locator('#confirm-booking').click(),
        ]);
        expect(createdResponse.status(), await createdResponse.text()).toBe(201);
        const created = await createdResponse.json();
        expect(created.notificationStatus).toBe('sent');
        await page.getByRole('heading', { name: 'Din tid er booket.' }).waitFor();
        expect(await page.locator('.saved-link').getAttribute('href')).toBe(created.manageUrl);
        await screenshot('booking-confirmed');
        await page.locator('.saved-link').click();
        await page.getByRole('heading', { name: 'Din aftale hos AJ Auto', exact: true }).waitFor();
        expect(new URL(page.url()).hash).toMatch(/^#token=/);
        expect(new URL(page.url()).search).toBe('');
        await page.locator('#move-booking').click();
        await Promise.all([
          page.waitForResponse(response => response.url().includes('/api/slots?') && response.url().includes('date=' + dayAfter(21 + index * 2))),
          page.locator('#move-date').fill(dayAfter(21 + index * 2)),
        ]);
        await page.locator('[data-move]').first().click();
        const [movedResponse] = await Promise.all([
          page.waitForResponse(response => response.url().endsWith('/api/manage/reschedule')),
          page.locator('#confirm-move').click(),
        ]);
        expect(movedResponse.status(), await movedResponse.text()).toBe(200);
        const moved = await movedResponse.json();
        expect(moved.booking.startAt).not.toBe(created.booking.startAt);
        await page.locator('#move-booking').waitFor();
        expect(await page.locator('#manage-root .form-status').innerText()).toContain('Din aftale er flyttet.');
        await screenshot('booking-moved');
        await page.locator('#cancel-booking').click();
        await page.getByRole('heading', { name: 'Vil du aflyse din aftale?' }).waitFor();
        const [cancelledResponse] = await Promise.all([
          page.waitForResponse(response => response.url().endsWith('/api/manage/cancel')),
          page.locator('#confirm-cancel').click(),
        ]);
        expect(cancelledResponse.status(), await cancelledResponse.text()).toBe(200);
        await page.getByRole('heading', { name: 'Din aftale er aflyst.' }).waitFor();
        expect((await adminData()).bookings.find(item => item.id === created.booking.id).status).toBe('cancelled');
        const notifications = (await mails()).slice(beforeBooking);
        expect(notifications.filter(item => item.to.includes(email))).toHaveLength(3);
        expect(notifications.filter(item => item.to.includes(workshopEmail))).toHaveLength(3);
        await screenshot('booking-cancelled');
        await page.goto(stack.base + '/kontakt');
        await page.locator('#contact-form [name=name]').fill('Kontakt Test');
        await page.locator('#contact-form [name=email]').fill(email);
        await page.locator('#contact-form [name=phone]').fill('12345678');
        await page.locator('#contact-form [name=message]').fill('En besked fra den lokale browser-test.');
        const [contactResponse] = await Promise.all([
          page.waitForResponse(response => response.url().endsWith('/api/contact')),
          page.getByRole('button', { name: /Send besked/ }).click(),
        ]);
        expect(contactResponse.status(), await contactResponse.text()).toBe(201);
        await page.locator('#contact-status').getByText('Tak. Din besked er gemt og sendt til AJ Auto.', { exact: true }).waitFor();
        await screenshot('contact-sent');
        for (const [pathname, suffix] of [['/ydelser', 'services'], ['/om-os', 'about']]) {
          const response = await page.goto(stack.base + pathname);
          expect(response.status()).toBe(200);
          await screenshot(suffix);
        }
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
      }
    }, 90_000);
  }
});
