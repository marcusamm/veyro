// En demo (DEMO_MODE=1) har login med ét klik som ejer. Selv med en Resend-nøgle må den hverken sende
// mails til fremmede adresser eller lægge dem i kundekataloget til Kundelogin på kunde.veyro.dk.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_EMAIL, Client, csrfFrom, demoLogin, startStack, waitFor } from './harness.mjs';

const STRANGER = 'fremmed@example.com';
const key = (email) => `e:${createHash('sha256').update(email).digest('hex')}:firma-lager`;

describe('Demo med e-mail og kundekatalog slået til', () => {
  let stack;

  beforeAll(async () => {
    stack = await startStack({ demo: true, email: true, katalog: true });
  }, 180_000);

  afterAll(async () => {
    await stack?.stop();
  });

  it('en invitation til en fremmed adresse simuleres og sendes ikke', async () => {
    const owner = await demoLogin(stack, 'ejer');
    const page = await owner.get('/lager/indstillinger');
    const res = await owner.post('/lager/indstillinger/bruger', { _csrf: csrfFrom(page.html), name: 'Fremmed', email: STRANGER, role: 'medarbejder', invite: '1' });
    expect(res.status).toBe(303);
    await new Promise((r) => setTimeout(r, 300));
    expect(stack.mail.emails.some((e) => e.to[0] === STRANGER)).toBe(false);
    expect(stack.sql(`SELECT status FROM mails WHERE recipient = '${STRANGER}'`)).toEqual([{ status: 'simuleret' }]);
  });

  it('login-links sendes kun til Veyros egne adresser', async () => {
    const visitor = new Client(stack.base);
    await visitor.submit('/login', '/login', { email: STRANGER });
    await visitor.submit('/login', '/login', { email: ADMIN_EMAIL });
    await waitFor(() => stack.mail.emails.find((e) => e.to[0] === ADMIN_EMAIL));
    expect(stack.mail.emails.some((e) => e.to[0] === STRANGER)).toBe(false);
  });

  it('kundekataloget får kun administratorerne, ikke demoens brugere', async () => {
    const url = stack.base + '/__scheduled?cron=7+*+*+*+*';
    await fetch(url).catch(() => fetch(url)); // ny forbindelse, hvis wrangler har lukket den gamle
    await waitFor(() => stack.katalogKeys().find((k) => k.name === key(ADMIN_EMAIL)));
    const names = stack.katalogKeys().map((k) => k.name);
    expect(names).not.toContain(key(STRANGER));
    expect(names).not.toContain(key('mette@nordlysbyg.example'));
  });
});
