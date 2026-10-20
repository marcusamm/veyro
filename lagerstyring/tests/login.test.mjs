// En login-side, der har stået åben for længe, giver en ny side at trykke på i stedet for 403.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_EMAIL, Client, csrfFrom, login, startStack } from './harness.mjs';

describe('Udløbet login-side', () => {
  let stack;
  beforeAll(async () => {
    stack = await startStack();
  }, 120_000);
  afterAll(async () => {
    await stack?.stop();
  });

  it('viser login-siden igen med e-mailen udfyldt og et nyt token, og intet sendes', async () => {
    const c = new Client(stack.base);
    const before = stack.mail.emails.length;
    const res = await c.post('/login', { _csrf: 'gammelt-token-fra-en-side-der-stod-aaben', email: ADMIN_EMAIL });
    expect(res.status).toBe(303);
    const next = res.headers.get('location');
    expect(next).toContain('besked=login_udlobet');
    const page = await c.get(next);
    expect(page.html).toContain('Siden var udløbet');
    expect(page.html).toContain(`value="${ADMIN_EMAIL}"`);
    expect(stack.mail.emails.length).toBe(before);
    // Andet tryk virker
    const again = await c.post('/login', { _csrf: csrfFrom(page.html), email: ADMIN_EMAIL });
    expect(again.status).toBe(200);
    expect(again.html).not.toContain('Ugyldig anmodning');
  });

  it('afviser stadig en formular fra en fremmed side og forkerte tokens, når man er logget ind', async () => {
    const c = new Client(stack.base);
    const res = await c.post('/login', { email: ADMIN_EMAIL }, { Origin: 'https://ond.example' });
    expect(res.status).toBe(403);
    const u = await login(stack);
    const out = await u.post('/logout', { _csrf: 'forkert' });
    expect(out.status).toBe(403);
  });
});
