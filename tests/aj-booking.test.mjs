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

function sql(query, targetStack = stack) {
  for (let attempt = 0; ; attempt++) {
    try {
      const output = execFileSync(path.join(ROOT, 'node_modules', '.bin', 'wrangler'), [
        'd1', 'execute', 'veyro-kundepanel', '--local', '--persist-to', targetStack.persist,
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
const publicRoutes = ['/', '/biler-til-salg', '/ydelser', '/om-os', '/kontakt', '/booking', '/booking/aftale'];
const linksFromHtml = html => [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map(match => ({
  href: (match[1].match(/\bhref=["']([^"']+)["']/i)?.[1] ?? '').replace(/&amp;/g, '&'),
  text: match[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
}));

function expectSuccess(response) {
  expect(response.status, response.text).toBeGreaterThanOrEqual(200);
  expect(response.status, response.text).toBeLessThan(300);
  return response.data;
}

async function expectFieldError(field, message) {
  expect(await field.getAttribute('aria-invalid')).toBe('true');
  await expect.poll(() => field.evaluate(input => document.activeElement === input)).toBe(true);
  const descriptions = await field.evaluate(input =>
    (input.getAttribute('aria-describedby') || '').split(/\s+/)
      .map(id => document.getElementById(id)).filter(node => node?.getClientRects().length)
      .map(node => node.textContent.trim()),
  );
  expect(descriptions).toContain(message);
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

  it('server-renders telephone booking across the public site while booking is closed', async () => {
    const client = new AjClient(stack.base);
    for (const pathname of [...publicRoutes, '/admin', '/side-der-ikke-findes']) {
      const response = await client.get(pathname);
      expect(response.status, pathname).toBe(pathname === '/side-der-ikke-findes' ? 404 : 200);
      expect(response.html, pathname).toContain('data-booking-ready="false"');
      const links = linksFromHtml(response.html);
      expect(links.some(link => link.href === 'tel:+4560644143' && link.text === 'Ring og aftal en tid'), pathname).toBe(true);
      expect(links.some(link => /^Book (?:tid|en ny tid|ny tid)$/i.test(link.text)), pathname).toBe(false);
      expect(response.html, pathname).not.toMatch(/aj-hero\.jpg|aj-oil\.jpg|wheel-art|299\s*kr|Onlinebooking åbner snart/);
    }
  });

  it('lets a mobile visitor identify the workshop and call from the first screen without JavaScript', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, javaScriptEnabled: false });
      await page.goto(stack.base + '/');
      const heading = page.getByRole('heading', { level: 1 });
      expect((await heading.innerText()).replace(/\s+/g, ' ')).toBe('Olieskift og bilhandel i Slagelse');
      const call = page.getByRole('main').getByRole('link', { name: 'Ring og aftal en tid', exact: true }).first();
      const box = await call.boundingBox();
      expect(box, 'Primary call action is visible without opening the menu').toBeTruthy();
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(844);
      expect(await call.getAttribute('href')).toBe('tel:+4560644143');
      const address = page.getByRole('main').getByText(/AJ Auto.*Sorøvej 5kl, Slagelse/).first();
      const addressBox = await address.boundingBox();
      expect(addressBox, 'Workshop name and address are visible on the first screen').toBeTruthy();
      expect(addressBox.y + addressBox.height).toBeLessThanOrEqual(844);
      expect(await page.locator('main img').count()).toBe(0);
    } finally {
      await browser.close();
    }
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

  it('server-renders the working booking action when ready and uses the stated address for directions', async () => {
    const client = new AjClient(stack.base);
    for (const pathname of publicRoutes) {
      const response = await client.get(pathname);
      expect(response.html, pathname).toContain('data-booking-ready="true"');
      const links = linksFromHtml(response.html);
      if (pathname !== '/booking') expect(links.some(link => link.href === '/booking' && link.text === 'Book tid'), pathname).toBe(true);
      expect(links.some(link => link.text === 'Ring og aftal en tid'), pathname).toBe(false);
      for (const link of links.filter(link => link.href.includes('google.com/maps/dir/'))) {
        expect(new URL(link.href).searchParams.get('destination'), pathname).toContain('Sorøvej 5kl');
      }
      expect(response.html, pathname).not.toMatch(/aj-hero\.jpg|aj-oil\.jpg|wheel-art|299\s*kr/);
    }
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

  it('hides a previously approved campaign as soon as its stored expiry has passed', async () => {
    const previous = (await adminData()).settings.campaign;
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(stack.base + '/');
      await page.locator('#home-campaign').waitFor({ state: 'visible' });
      expect(await page.locator('#home-campaign').innerText()).toContain('900');
      // Simulate the passage of the campaign's end date rather than an invalid admin write.
      const expired = { ...previous, expiresOn: '2020-01-01' };
      sql(`UPDATE aj_settings SET campaign_json='${JSON.stringify(expired).replaceAll("'", "''")}' WHERE id=1`);
      expect((await new AjClient(stack.base).read('/api/config')).data.campaign).toBeNull();
      for (const [pathname, selector] of [['/', '#home-campaign'], ['/ydelser', '#services-campaign']]) {
        await Promise.all([
          page.waitForResponse(response => response.url().endsWith('/api/config')),
          page.goto(stack.base + pathname),
        ]);
        expect(await page.locator(selector).isVisible(), pathname).toBe(false);
        expect(await page.locator('body').innerText(), pathname).not.toMatch(/900\s*(?:kr|DKK)/);
      }
    } finally {
      await browser.close();
      expectSuccess(await operator.send('/api/admin/settings', { campaign: previous }));
    }
  });
});

describe('AJ Auto car sales', () => {
  it('lets the workshop publish a photographed car and withdraw it when sold', async () => {
    const anonymous = new AjClient(stack.base);
    expect((await anonymous.read('/api/admin/cars')).status).toBe(401);
    const { client: owner } = await signIn(ownerEmail);
    const { client: mechanic } = await signIn(colleagueEmail);
    const browser = await chromium.launch();
    const title = 'Testbil med vinterhjul';
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await context.addCookies([...owner.cookies].map(([name, value]) => ({ name, value, url: stack.base })));
      const page = await context.newPage();
      await page.goto(stack.base + '/admin');
      await page.locator('#adm-workspace').waitFor();
      await page.locator('#adm-nav-toggle').click();
      await page.locator('[data-panel="cars"]').click();
      await page.getByRole('button', { name: 'Opret bil', exact: true }).click();
      const form = page.locator('#adm-car-form');
      await form.locator('[name=title]').fill(title);
      await form.locator('[name=priceDkk]').fill('89900');
      await form.locator('[name=modelYear]').fill('2019');
      await form.locator('[name=mileageKm]').fill('67000');
      await form.getByRole('button', { name: 'Gem kladde' }).click();
      const images = page.locator('#adm-car-images');
      await images.waitFor();
      const emptyDraft = expectSuccess(await owner.read('/api/admin/cars')).cars.find(c => c.title === title);
      const withoutPhoto = await owner.send('/api/admin/cars', { ...emptyDraft, status: 'published' });
      expect(withoutPhoto.status).toBe(409);
      expect(withoutPhoto.data.error).toContain('Tilføj mindst ét billede');
      const png = await page.evaluate(() => document.createElement('canvas').toDataURL('image/png').split(',')[1]);
      await images.locator('[name=photos]').setInputFiles({ name: 'lokal-test.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
      const [upload] = await Promise.all([
        page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/photos')),
        images.getByRole('button', { name: 'Tilføj billeder' }).click(),
      ]);
      expect(upload.ok(), await upload.text()).toBe(true);
      const draft = expectSuccess(await mechanic.read('/api/admin/cars')).cars.find(c => c.title === title);
      expect(draft.status).toBe('draft');
      expect(draft.photos).toHaveLength(1);
      const detail = '/biler-til-salg/' + draft.id;
      const photo = detail + '/billeder/' + draft.photos[0];
      expect((await anonymous.get(detail)).status).toBe(404);
      expect((await anonymous.get(photo)).status).toBe(404);
      const saveStatus = async status => {
        await form.locator('[name=status]').selectOption(status);
        const [saved] = await Promise.all([
          page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/admin/cars')),
          form.getByRole('button', { name: 'Gem ændringer' }).click(),
        ]);
        expect(saved.ok(), await saved.text()).toBe(true);
      };
      await saveStatus('published');
      const lastPhoto = await owner.send('/api/admin/cars/' + draft.id + '/photos/' + draft.photos[0] + '/remove', {});
      expect(lastPhoto.status).toBe(409);
      expect((await anonymous.get('/biler-til-salg')).html).toContain(title);
      const advert = await anonymous.get(detail);
      expect(advert.status).toBe(200);
      expect(advert.html).toContain('89.900 kr.');
      const image = await fetch(stack.base + photo);
      expect(image.status).toBe(200);
      expect(image.headers.get('content-type')).toContain('image/jpeg');
      expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(100);
      expect((await mechanic.send('/api/admin/cars', { ...draft, status: 'draft' })).status).toBe(409);
      await saveStatus('sold');
      expect((await anonymous.get('/biler-til-salg')).html).not.toContain(title);
      expect((await anonymous.get(detail)).status).toBe(404);
      expect((await anonymous.get(photo)).status).toBe(404);

      await page.locator('#adm-cars-back').click();
      await page.getByRole('button', { name: 'Opret bil', exact: true }).click();
      const secondTitle = 'Testbil med foto fra oprettelsen';
      await form.locator('[name=title]').fill(secondTitle);
      await form.locator('[name=priceDkk]').fill('49000');
      await form.locator('[name=photos]').setInputFiles({ name: 'forside.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
      await form.locator('#adm-car-preview img').waitFor();
      await form.getByRole('button', { name: 'Gem kladde' }).click();
      await page.locator('#adm-car-thumbs img').waitFor();
      const drafts = expectSuccess(await owner.read('/api/admin/cars')).cars.filter(c => c.title === secondTitle);
      expect(drafts).toHaveLength(1);
      expect(drafts[0].photos).toHaveLength(1);
      expect(drafts[0].status).toBe('draft');
    } finally {
      await browser.close();
    }
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
    expect(moveMail.text).toContain('Forventet varighed: 45 minutter');
    expect(moveMail.text).toContain('Varigheden er vejledende.');
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

  it('delivers customer lifecycle receipts and defers each workshop event until its mailbox is connected', async () => {
    const date = dayAfter(16);
    const before = (await mails()).length;
    const email = 'deferred-workshop@example.test';
    let originalStart;
    let movedStart;
    expectSuccess(await operator.send('/api/admin/settings', { workshopEmail: '' }));
    try {
      const customer = new AjClient(stack.base);
      expect((await customer.read('/api/config')).data.bookingReady).toBe(true);
      const slots = await available(date);
      originalStart = slots[0].startAt;
      movedStart = slots.at(-1).startAt;
      const created = await customer.send('/api/bookings', bookingInput(slots[0], email));
      expectSuccess(created);
      expect(created.data.notifications).toEqual({ customer: 'sent', workshop: 'not_configured' });
      const token = new URLSearchParams(new URL(created.data.manageUrl).hash.slice(1)).get('token');
      const moved = await customer.send('/api/manage/reschedule', { token, staffId: ownerId, startAt: movedStart });
      expectSuccess(moved);
      expect(moved.data.notifications).toEqual({ customer: 'sent', workshop: 'not_configured' });
      const cancelled = await customer.send('/api/manage/cancel', { token });
      expectSuccess(cancelled);
      expect(cancelled.data.notifications).toEqual({ customer: 'sent', workshop: 'not_configured' });
      const repeated = await customer.send('/api/manage/cancel', { token });
      expectSuccess(repeated);
      expect(repeated.data.notificationStatus).not.toBe('sent');
      const immediate = (await mails()).slice(before);
      expect(immediate).toHaveLength(3);
      expect(immediate.every(item => item.to.includes(email))).toBe(true);
      expect((await adminData()).bookings.find(item => item.id === created.data.booking.id).status).toBe('cancelled');
      const pending = sql(`SELECT payload,status FROM aj_outbox WHERE booking_id='${created.data.booking.id}' AND recipient_kind='workshop'`);
      expect(pending).toHaveLength(3);
      expect(pending.every(item => item.status === 'not_configured' && item.payload.startsWith('v1.'))).toBe(true);
      expect(JSON.stringify(pending)).not.toContain(email);
    } finally {
      expectSuccess(await operator.send('/api/admin/settings', { workshopEmail }));
    }
    expectSuccess(await operator.send('/api/admin/retry-mail', {}));
    const delivered = (await mails()).slice(before);
    expect(delivered.filter(item => item.to.includes(email))).toHaveLength(3);
    const workshopMessages = delivered.filter(item => item.to.includes(workshopEmail));
    expect(workshopMessages).toHaveLength(3);
    const time = instant => new Intl.DateTimeFormat('da-DK', { timeZone: 'Europe/Copenhagen', hour: '2-digit', minute: '2-digit' }).format(new Date(instant));
    expect(workshopMessages.find(item => /bekræftet/.test(item.subject)).text).toContain(time(originalStart));
    expect(workshopMessages.find(item => /flyttet/.test(item.subject)).text).toContain(time(movedStart));
    expect(workshopMessages.find(item => /aflyst/.test(item.subject)).text).toContain(time(movedStart));
    const afterDelivery = (await mails()).length;
    expectSuccess(await operator.send('/api/admin/retry-mail', {}));
    expect((await mails()).length).toBe(afterDelivery);
  });

  it('does not open bookings without customer mail integration even with a configured service and calendar', async () => {
    const noMail = await startStack({ resend: false, extraVars: { AJ_HOSTS: '127.0.0.1', AJ_URL: '' } });
    try {
      sql(`INSERT INTO aj_staff(name,email,role,active) VALUES('Local mail-gate fixture','mail-gate@example.test','owner',1);
        UPDATE aj_services SET duration_minutes=45,active=1 WHERE id=1;
        UPDATE aj_settings SET booking_enabled=1,workshop_email='' WHERE id=1;
        ${Array.from({ length: 7 }, (_, index) => `INSERT INTO aj_hours(staff_id,weekday,start_minute,end_minute) VALUES(1,${index + 1},540,1020);`).join('\n')}`, noMail);
      const client = new AjClient(noMail.base);
      expect((await client.read('/api/config')).data.bookingReady).toBe(false);
      expect((await client.read(`/api/slots?serviceId=1&staffId=1&date=${dayAfter(17)}`)).data.slots).toEqual([]);
      const response = await client.send('/api/bookings', {
        serviceId: 1, staffId: 1, startAt: `${dayAfter(17)}T08:00:00.000Z`, name: 'Local fixture', email: 'mail-gate-customer@example.test', phone: '12345678',
      });
      expect(response.status, response.text).toBe(503);
      expect(sql('SELECT count(*) AS n FROM aj_bookings', noMail)[0].n).toBe(0);
    } finally {
      await noMail.stop();
    }
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
  it('distinguishes an open day with no free slots from booking being closed during a visit', async () => {
    const date = dayAfter(35);
    for (const staffId of [ownerId, colleagueId]) {
      expectSuccess(await operator.send('/api/admin/blocks', {
        staffId, startAt: `${date}T00:00:00.000Z`, endAt: `${dayAfter(36)}T00:00:00.000Z`, reason: 'Lokal test af en fyldt dag',
      }));
    }
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'da-DK' });
      await page.goto(stack.base + '/booking');
      await page.locator('[data-service]').first().click();
      await Promise.all([
        page.waitForResponse(response => response.url().includes('/api/slots?') && response.url().includes(`date=${date}`)),
        page.locator('#booking-date').fill(date),
      ]);
      await page.locator('#slot-results .form-status').waitFor();
      expect(await page.locator('#slot-results').innerText()).toMatch(/ingen ledige|ingen tider/i);
      expect(await page.locator('#booking-date').isVisible()).toBe(true);
      expect(await page.locator('[data-slot]').count()).toBe(0);
      expect(await page.locator('body').getAttribute('data-booking-ready')).toBe('true');
      expectSuccess(await operator.send('/api/admin/settings', { bookingEnabled: false }));
      await Promise.all([
        page.waitForResponse(response => response.url().includes('/api/slots?') && response.url().includes(`date=${dayAfter(37)}`)),
        page.locator('#booking-date').fill(dayAfter(37)),
      ]);
      await page.locator('#booking-root a[href="tel:+4560644143"]').waitFor();
      expect(await page.locator('#booking-date').count()).toBe(0);
      expect(await page.locator('body').getAttribute('data-booking-ready')).toBe('false');
      expect(await page.locator('#booking-root').innerText()).not.toMatch(/åbner snart/i);
    } finally {
      await browser.close();
      expectSuccess(await operator.send('/api/admin/settings', { bookingEnabled: true }));
    }
  });

  for (const [index, viewport] of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'mobile', width: 390, height: 844 }].entries()) {
    it(`completes booking, moving, cancellation and contact on ${viewport.name} without layout or console errors`, async () => {
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, locale: viewport.name === 'desktop' ? 'en-US' : 'da-DK', timezoneId: 'Europe/Copenhagen' });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      const directory = path.join(ROOT, 'test-results', 'aj-auto');
      mkdirSync(directory, { recursive: true });
      const screenshot = async suffix => {
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
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
        const primary = page.getByRole('main').getByRole('link', { name: 'Book tid', exact: true }).first();
        const primaryBox = await primary.boundingBox();
        expect(primaryBox, `${viewport.name} booking action is visible on first screen`).toBeTruthy();
        expect(primaryBox.y + primaryBox.height).toBeLessThanOrEqual(viewport.height);
        if (viewport.name === 'mobile') {
          await page.getByRole('button', { name: /menu/i }).click();
          expect(await page.getByRole('button', { name: /menu/i }).getAttribute('aria-expanded')).toBe('true');
          await page.keyboard.press('Escape');
          expect(await page.getByRole('button', { name: /menu/i }).getAttribute('aria-expanded')).toBe('false');
          await page.getByRole('button', { name: /menu/i }).click();
          await page.locator('#navigation').getByRole('link', { name: 'Ydelser', exact: true }).click();
          await page.getByRole('heading', { level: 1 }).waitFor();
          await page.locator('.site-header [data-booking-cta]').click();
        } else {
          await primary.click();
        }
        expect(await page.getByRole('heading', { level: 1 }).innerText()).toBe('Book tid');
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
        const nameField = page.locator('#details-form [name=name]');
        const emailField = page.locator('#details-form [name=email]');
        const phoneField = page.locator('#details-form [name=phone]');
        await nameField.press('Enter');
        await expectFieldError(nameField, 'Skriv dit navn.');
        await nameField.fill('Browser Test ÆØÅ');
        expect(await nameField.getAttribute('aria-invalid')).not.toBe('true');
        await nameField.press('Enter');
        await expectFieldError(emailField, 'Skriv din e-mailadresse.');
        await emailField.fill('ufuldstaendig');
        await emailField.press('Enter');
        await expectFieldError(emailField, 'Skriv en gyldig e-mailadresse.');
        await emailField.fill(email);
        await emailField.press('Enter');
        await expectFieldError(phoneField, 'Skriv dit telefonnummer.');
        expect(await page.locator('#confirm-booking').count()).toBe(0);
        await phoneField.fill('12345678');
        await page.locator('#details-form [name=registration]').fill('UI12345');
        await page.locator('#details-form [name=note]').fill('Kun lokale browser-testdata.');
        await page.getByRole('button', { name: /Gennemse/ }).click();
        await page.locator('#confirm-booking').waitFor();
        expect(await page.locator('.booking-summary').innerText()).toContain('Forventet varighed');
        expect(await page.locator('#booking-root').innerText()).toContain('Bilen kan blive færdig senere');
        expect(await page.locator('.booking-summary').innerText()).toContain(email);
        const [createdResponse] = await Promise.all([
          page.waitForResponse(response => response.url().endsWith('/api/bookings') && response.request().method() === 'POST'),
          page.locator('#confirm-booking').click(),
        ]);
        expect(createdResponse.status(), await createdResponse.text()).toBe(201);
        const created = await createdResponse.json();
        expect(created.notificationStatus).toBe('sent');
        await page.locator('.saved-link').waitFor();
        expect(await page.locator('.saved-link').getAttribute('href')).toBe(created.manageUrl);
        await screenshot('booking-confirmed');
        await page.locator('.saved-link').click();
        await page.locator('#move-booking').waitFor();
        expect(await page.getByRole('heading', { level: 1 }).innerText()).toBe('Din aftale');
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
        expect(await page.locator('#manage-root .form-status').innerText()).toMatch(/flyttet/i);
        await screenshot('booking-moved');
        await page.locator('#cancel-booking').click();
        await page.locator('#confirm-cancel').waitFor();
        const [cancelledResponse] = await Promise.all([
          page.waitForResponse(response => response.url().endsWith('/api/manage/cancel')),
          page.locator('#confirm-cancel').click(),
        ]);
        expect(cancelledResponse.status(), await cancelledResponse.text()).toBe(200);
        await page.locator('#manage-root h2').filter({ hasText: /aflyst/i }).waitFor();
        expect((await adminData()).bookings.find(item => item.id === created.booking.id).status).toBe('cancelled');
        const notifications = (await mails()).slice(beforeBooking);
        expect(notifications.filter(item => item.to.includes(email))).toHaveLength(3);
        expect(notifications.filter(item => item.to.includes(workshopEmail))).toHaveLength(3);
        await screenshot('booking-cancelled');
        await page.goto(stack.base + '/kontakt');
        const postedForms = [];
        page.on('request', request => {
          if (request.method() === 'POST') postedForms.push(new URL(request.url()).pathname);
        });
        await page.getByRole('button', { name: /Send besked/ }).click();
        await expectFieldError(page.locator('#contact-form [name=name]'), 'Skriv dit navn.');
        expect(postedForms).not.toContain('/api/contact');
        await page.locator('#contact-form [name=name]').fill('Kontakt Test');
        await page.locator('#contact-form [name=email]').fill(email);
        await page.locator('#contact-form [name=phone]').fill('12345678');
        await page.locator('#contact-form [name=message]').fill('En besked fra den lokale browser-test.');
        const [contactResponse] = await Promise.all([
          page.waitForResponse(response => response.url().endsWith('/api/contact')),
          page.getByRole('button', { name: /Send besked/ }).click(),
        ]);
        expect(contactResponse.status(), await contactResponse.text()).toBe(201);
        await page.locator('#contact-status').filter({ hasText: /tak|sendt|modtaget/i }).waitFor();
        await screenshot('contact-sent');
        for (const [pathname, suffix] of [['/ydelser', 'services'], ['/om-os', 'about']]) {
          const response = await page.goto(stack.base + pathname);
          expect(response.status()).toBe(200);
          await screenshot(suffix);
        }
        await page.goto(stack.base + '/admin');
        await page.locator('#adm-login-form').waitFor();
        await screenshot('admin-login');
        await page.locator('#adm-login-form button[type=submit]').click();
        await expectFieldError(page.locator('#adm-login-form [name=email]'), 'Skriv din e-mailadresse.');
        expect(postedForms).not.toContain('/api/admin/login');
        const beforeLogin = (await mails()).length;
        await page.locator('#adm-login-form [name=email]').fill(ADMIN_EMAIL);
        await page.locator('#adm-login-form button[type=submit]').click();
        const loginMail = await waitFor(async () => (await mails()).slice(beforeLogin).find(item => item.to.includes(ADMIN_EMAIL)));
        // Open the personal link as a fresh page load, as an email client would.
        await page.goto('about:blank');
        await page.goto(`${stack.base}/admin#token=${mailToken(loginMail)}`);
        await page.locator('#adm-verify').click();
        await page.locator('#adm-workspace').waitFor({ state: 'visible' });
        await page.locator('#adm-date').fill(dayAfter(11));
        await page.locator('.adm-booking').first().waitFor();
        await screenshot('admin-appointments');
        for (const panel of ['services', 'hours', 'staff', 'messages', 'settings', 'calendar']) {
          if (viewport.name === 'mobile') await page.getByRole('button', { name: /Vælg side/i }).click();
          await page.locator(`[data-panel="${panel}"]`).click();
          await page.locator('#adm-content h2').first().waitFor();
          await screenshot(`admin-${panel}`);
        }
        await page.locator('#adm-logout').click();
        await page.locator('#adm-login-form').waitFor({ state: 'visible' });
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
      }
    }, 90_000);
  }
});
