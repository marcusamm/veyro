import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_EMAIL, Client, startStack, waitFor } from './harness.mjs';

const key = (email) => `e:${createHash('sha256').update(email).digest('hex')}:firma-lager`;

describe('Kundekatalog til Kundelogin på kunde.veyro.dk', () => {
  let stack;
  const names = () => stack.katalogKeys().map((k) => k.name);

  beforeAll(async () => {
    stack = await startStack({ katalog: true });
  }, 180_000);

  afterAll(async () => {
    await stack?.stop();
  });

  it('login-siden udfylder e-mailen og lægger administratorerne i kataloget', async () => {
    const page = await new Client(stack.base).get('/login?email=mester%40firma.dk');
    expect(page.html).toContain('value="mester@firma.dk"');
    const entry = await waitFor(() => stack.katalogKeys().find((k) => k.name === key(ADMIN_EMAIL)));
    expect(entry.metadata).toEqual({ navn: 'Mit firma', url: 'https://firma.veyro.dk' });
    expect(names()).toContain('kunde:firma-lager');
  });

  it('cron tilføjer nye brugere og fjerner deaktiverede', async () => {
    stack.sql("INSERT INTO users (email, name, role, created_at) VALUES ('svend@firma.dk', 'Svend', 'medarbejder', 0)");
    await fetch(stack.base + '/__scheduled?cron=7+*+*+*+*');
    await waitFor(() => names().includes(key('svend@firma.dk')));

    stack.sql("UPDATE users SET active = 0 WHERE email = 'svend@firma.dk'");
    await fetch(stack.base + '/__scheduled?cron=7+*+*+*+*');
    await waitFor(() => !names().includes(key('svend@firma.dk')));
    expect(names()).toContain(key(ADMIN_EMAIL));
  });
});
