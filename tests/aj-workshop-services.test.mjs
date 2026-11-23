import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ROOT, startStack } from './harness.mjs';

const minutesByService = { Olieskift: 45, 'Fuld service': 90, Dækskifte: 60, Bremser: 60, Syntjek: 30 };
const localTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Copenhagen', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
let stack, tyreServiceId;

function localSql(...args) {
  execFileSync(path.join(ROOT, 'node_modules/.bin/wrangler'), [
    'd1', 'execute', 'veyro-kundepanel', '--local', '--persist-to', stack.persist, ...args,
  ], { cwd: ROOT, stdio: 'pipe', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } });
}

async function configuration() {
  const response = await fetch(stack.base + '/api/config');
  expect(response.status).toBe(200);
  return response.json();
}

beforeAll(async () => {
  stack = await startStack({ extraVars: { AJ_HOSTS: '127.0.0.1', AJ_URL: '', AJ_OUTBOX_KEY: randomBytes(32).toString('base64') } });
  tyreServiceId = (await configuration()).services.find(service => service.name === 'Dækskifte').id;
  localSql('--command', `
    UPDATE aj_services SET name='Dæk skifte', duration_minutes=45, description='Værkstedets beskrivelse' WHERE id=${tyreServiceId};
    INSERT INTO aj_staff(name,email,role) VALUES('Testværksted','owner@example.test','owner');
    UPDATE aj_settings SET booking_enabled=1;
    UPDATE aj_services SET duration_minutes=45, active=1 WHERE name='Olieskift';
    INSERT INTO aj_hours(staff_id,weekday,start_minute,end_minute) VALUES(1,1,540,960);
  `);
  localSql('--file', 'migrations/0024_aj_workshop_services.sql');
}, 120_000);
afterAll(async () => { await stack?.stop(); });

it('reuses existing service IDs and adds only the fixed-duration workshop services', async () => {
  const { bookingReady, services } = await configuration();
  expect(bookingReady).toBe(true);
  expect(services).toHaveLength(5);
  expect(Object.fromEntries(services.filter(s => s.active).map(s => [s.name, s.durationMinutes]))).toEqual(minutesByService);
  expect(services.find(s => s.name === 'Dækskifte')).toMatchObject({ id: tyreServiceId, description: 'Værkstedets beskrivelse' });
});

it('reserves each expected duration and shares busy time across different service types', async () => {
  const services = (await configuration()).services;
  const monday = new Date();
  monday.setUTCDate(monday.getUTCDate() + 7 + (8 - monday.getUTCDay()) % 7);
  for (const service of services) {
    const date = monday.toISOString().slice(0, 10);
    const slotsFor = async id => {
      const response = await fetch(`${stack.base}/api/slots?serviceId=${id}&date=${date}`);
      expect(response.status).toBe(200);
      return (await response.json()).slots;
    };
    const slots = await slotsFor(service.id);
    const expectedMs = minutesByService[service.name] * 60_000;
    const start = Date.parse(slots[0].startAt);
    expect(localTime.format(start)).toBe('09:00');
    expect(localTime.format(Date.parse(slots.at(-1).startAt) + expectedMs)).toBe('16:00');
    const response = await fetch(stack.base + '/api/bookings', {
      method: 'POST', headers: { Origin: stack.base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceId: service.id, staffId: slots[0].staffId, startAt: slots[0].startAt, name: 'Lokal prøve', email: 'local@example.test', phone: '12345678' }),
    });
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(201);
    expect(result.booking.serviceName).toBe(service.name);
    expect(Date.parse(result.booking.endAt)).toBe(start + expectedMs);
    const otherService = services.find(other => other.id !== service.id);
    expect((await slotsFor(otherService.id))[0].startAt).toBe(result.booking.endAt);
    monday.setUTCDate(monday.getUTCDate() + 7);
  }
});
