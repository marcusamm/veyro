import { describe, it, expect } from 'vitest';
import { SalonCore, cleanConfig } from '../worker/core.js';
import { zonedToUtc } from '../site/assets/booking-engine.js';
import { defaultState } from '../site/assets/data.js';

// Mandag 2. november 2026 kl. 08:00 dansk tid
const NOW = zonedToUtc('2026-11-02', 8 * 60);

function setup() {
  const data = new Map();
  const storage = {
    get: async (k) => structuredClone(data.get(k)),
    put: async (k, v) => { data.set(k, structuredClone(v)); },
    delete: async (k) => { data.delete(k); },
    list: async (prefix) => new Map([...data].filter(([k]) => k.startsWith(prefix))),
  };
  const sent = [];
  const core = new SalonCore(storage, { ADMIN_EMAILS: 'admin@veyro.dk', SITE_URL: 'https://sbb.veyro.dk', DEV_LOGIN: '1' }, async (m) => { sent.push(m); return { ok: true }; }, () => NOW);
  const call = async (method, path, body, headers = {}) => {
    const res = await core.handle(new Request(`https://sbb.veyro.dk${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined }));
    return { status: res.status, data: await res.json().catch(() => null), headers: res.headers };
  };
  return { core, call, sent, data };
}
const customer = { name: 'Test Kunde', phone: '12345678', email: 'test@example.com' };

describe('bookingserver', () => {
  it('opretter en booking, sender mails og skjuler kundedata i den offentlige kalender', async () => {
    const { call, sent } = setup();
    const r = await call('POST', '/api/bookings', { serviceId: 'herreklip', date: '2026-11-03', start: 720, customer });
    expect(r.status).toBe(200);
    expect(r.data.booking.ref).toMatch(/^[A-Z0-9]{6}$/);
    expect(sent.map((m) => m.to)).toEqual(['test@example.com', 'admin@veyro.dk']);
    const pub = (await call('GET', '/api/state')).data;
    expect(pub.bookings).toHaveLength(1);
    expect(JSON.stringify(pub)).not.toContain('Test Kunde');
    expect(JSON.stringify(pub)).not.toContain(r.data.booking.ref);
  });
  it('to stole: tredje booking på samme tid afvises', async () => {
    const { call } = setup();
    const body = { serviceId: 'herreklip', date: '2026-11-03', start: 720, customer };
    expect((await call('POST', '/api/bookings', body)).status).toBe(200);
    expect((await call('POST', '/api/bookings', body)).status).toBe(200);
    expect((await call('POST', '/api/bookings', body)).status).toBe(409);
  });
  it('kunden finder, flytter og aflyser med bookingnummer og telefon', async () => {
    const { call } = setup();
    const { booking } = (await call('POST', '/api/bookings', { serviceId: 'herreklip', date: '2026-11-03', start: 720, customer })).data;
    expect((await call('POST', '/api/bookings/find', { ref: booking.ref, phone: '00000000' })).status).toBe(404);
    expect((await call('POST', '/api/bookings/find', { ref: booking.ref.toLowerCase(), phone: '+45 12 34 56 78' })).data.booking.canChange).toBe(true);
    const moved = await call('POST', '/api/bookings/move', { ref: booking.ref, phone: '12345678', date: '2026-11-04', start: 780 });
    expect(moved.data.booking.date).toBe('2026-11-04');
    const cancelled = await call('POST', '/api/bookings/cancel', { ref: booking.ref, phone: '12345678' });
    expect(cancelled.data.booking.status).toBe('cancelled');
  });
  it('admin kræver login via engangslink', async () => {
    const { call } = setup();
    expect((await call('GET', '/api/admin/state')).status).toBe(401);
    expect((await call('POST', '/api/admin/login', { email: 'ukendt@example.com' })).data).toEqual({ ok: true });
    const { devLink } = (await call('POST', '/api/admin/login', { email: 'admin@veyro.dk' })).data;
    const token = devLink.split('t=')[1];
    const v = await call('POST', '/api/admin/verify', { token });
    const cookie = v.headers.get('set-cookie').split(';')[0];
    expect((await call('POST', '/api/admin/verify', { token })).status).toBe(401); // kun én gang
    const st = await call('GET', '/api/admin/state', null, { cookie });
    expect(st.status).toBe(200);
    expect(st.data.state.services.length).toBeGreaterThan(0);
    // telefonbooking uden e-mail
    const r = await call('POST', '/api/admin/bookings', { serviceId: 'skaeg', date: '2026-11-03', start: 660, customer: { name: 'Ringer Ind', phone: '87654321' } }, { cookie });
    expect(r.status).toBe(200);
  });
  it('kræver JSON, så andre sider ikke kan sende formularer på vegne af admin', async () => {
    const { core } = setup();
    const res = await core.handle(new Request('https://sbb.veyro.dk/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=admin@veyro.dk' }));
    expect(res.status).toBe(415);
  });
  it('validerer indstillinger fra admin', () => {
    const c = cleanConfig(defaultState());
    expect(c.services.map((s) => s.price)).toEqual([250, 100, 50, 1000]);
    expect(() => cleanConfig({ ...defaultState(), services: [{ id: 'x', name: 'X', duration: 0, price: 1 }] })).toThrow();
    expect(() => cleanConfig({ ...defaultState(), settings: { externalBookingUrl: 'javascript:alert(1)' } })).toThrow();
  });
  it('sender påmindelse dagen før kun én gang', async () => {
    const { core, call, sent } = setup();
    await call('POST', '/api/bookings', { serviceId: 'herreklip', date: '2026-11-03', start: 720, customer });
    sent.length = 0;
    expect((await core.cron()).reminders).toBe(1);
    expect((await core.cron()).reminders).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain('Påmindelse');
  });
});
