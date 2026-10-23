import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { sha256Hex } from '../lib/crypto';
import { getCustomerByEmail, normalizeEmail, rateLimit, upsertCustomer } from '../lib/db';
import { findKundeSystemer, kanRedirecte, systemLoginUrl } from '../lib/katalog';
import { magicLinkEmail, sendEmail, signupEmail } from '../lib/email';
import { consumeLoginToken, createLoginToken, createSession, destroySession, isAdmin } from '../lib/session';
import { staffAccess } from '../lib/pos/staff';
import { render } from '../render';
import { chooseSystemPage, flash, linkInvalidPage, loginPage, loginSentPage, signupPage, signupSentPage, verifyPage } from '../views/pages';

const auth = new Hono<AppEnv>();

auth.get('/login', async (c) => {
  if (c.get('session')) return c.redirect('/konto', 303);
  return render(c, 'Log ind', loginPage({ csrf: c.get('csrf'), info: flash(c.req.query('besked')) }));
});

auth.post('/login', async (c) => {
  const body = await c.req.parseBody();
  const email = normalizeEmail(body['email']);
  if (!email) {
    const raw = typeof body['email'] === 'string' ? body['email'].slice(0, 254) : '';
    return render(c, 'Log ind', loginPage({ csrf: c.get('csrf'), email: raw, error: 'Indtast en gyldig e-mailadresse.' }), {
      status: 400,
    });
  }

  // Rate limiting pr. IP og pr. e-mail (begge hashet). Tælles uanset om e-mailen findes,
  // så svaret aldrig afslører, om der er en konto.
  const ip = c.req.header('CF-Connecting-IP') ?? 'ukendt';
  const ipOk = await rateLimit(c.env.DB, 'ip:' + (await sha256Hex(ip)), 10, 15 * 60);
  const emailOk = await rateLimit(c.env.DB, 'email:' + (await sha256Hex(email)), 3, 15 * 60);
  if (!ipOk || !emailOk) {
    return render(
      c,
      'Log ind',
      loginPage({ csrf: c.get('csrf'), email, error: 'For mange forsøg. Vent 15 minutter, og prøv igen.' }),
      { status: 429 },
    );
  }

  const allowed = isAdmin(c.env, email) || !!(await getCustomerByEmail(c.env.DB, email)) || !!(await staffAccess(c.env, email));

  // Kundelogin: bruger e-mailen et kundesystem (fx ek.veyro.dk), sendes man videre dertil.
  // Med flere systemer, eller også en konto her, vælger man selv. "kundepanel=1" er det valg.
  if (body['kundepanel'] !== '1') {
    const systemer = await findKundeSystemer(c.env, email);
    if (systemer.length === 1 && !allowed && kanRedirecte(systemer[0]!)) {
      return c.redirect(systemLoginUrl(systemer[0]!, email), 303);
    }
    if (systemer.length) {
      return render(c, 'Vælg system', chooseSystemPage({ csrf: c.get('csrf'), email, systemer, kundepanel: allowed }));
    }
  }

  let devLink: string | null = null;
  if (allowed) {
    const token = await createLoginToken(c.env, email);
    const link = `${c.env.APP_URL.replace(/\/+$/, '')}/login/bekraeft?token=${encodeURIComponent(token)}`;
    if (c.env.RESEND_API_KEY) {
      // Sendes i baggrunden, så svartiden ikke afslører, om e-mailen findes.
      c.executionCtx.waitUntil(
        sendEmail(c.env, { to: email, ...magicLinkEmail(link) }).catch((err) =>
          console.error('Login-mail fejlede:', (err as Error).message),
        ),
      );
    } else {
      console.log(`[DEV] Ingen RESEND_API_KEY – login-link: ${link}`);
      if (c.env.DEV_MODE === '1') devLink = link;
    }
  }
  return render(c, 'Tjek din indbakke', loginSentPage({ devLink }));
});

// GET viser kun en bekræftelsesknap; selve login sker ved POST.
// Det forhindrer, at e-mail-scannere, der "klikker" på links, bruger engangslinket.
auth.get('/login/bekraeft', async (c) => {
  const token = c.req.query('token') ?? '';
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) return render(c, 'Ugyldigt link', linkInvalidPage(), { status: 400 });
  return render(c, 'Bekræft login', verifyPage({ csrf: c.get('csrf'), token }));
});

auth.post('/login/bekraeft', async (c) => {
  const body = await c.req.parseBody();
  const token = typeof body['token'] === 'string' ? body['token'] : '';
  const data = await consumeLoginToken(c.env, token);
  if (!data) return render(c, 'Ugyldigt link', linkInvalidPage(), { status: 400 });

  let customer = await getCustomerByEmail(c.env.DB, data.email);
  const admin = isAdmin(c.env, data.email);
  // Medarbejder i kassen (ikke admin): må kun logge ind til kassen
  const staff = !admin && !customer ? await staffAccess(c.env, data.email) : null;
  // Linket beviser, at e-mailen tilhører personen; først nu oprettes kunden.
  const created = !customer && !admin && !staff && data.signup;
  if (created) customer = await upsertCustomer(c.env.DB, { email: data.email, name: data.name });
  if (!customer && !admin && !staff) return render(c, 'Ugyldigt link', linkInvalidPage(), { status: 400 });

  // Ny session ved hvert login; en evt. gammel session i browseren afsluttes.
  if (c.get('session')) await destroySession(c);
  await createSession(c, data.email);
  if (data.next) return c.redirect(created ? `${data.next}${data.next.includes('?') ? '&' : '?'}besked=konto-oprettet` : data.next, 303);
  return c.redirect(customer ? '/konto' : staff ? '/admin/kasse' : '/admin', 303);
});

// ---------------- Opret konto (før betaling) ----------------

auth.get('/opret', (c) => {
  if (c.get('session')) return c.redirect('/konto', 303);
  return render(c, 'Opret konto', signupPage({ csrf: c.get('csrf') }));
});

auth.post('/opret', async (c) => {
  const body = await c.req.parseBody();
  const name = typeof body['name'] === 'string' ? body['name'].trim().replace(/\s+/g, ' ').slice(0, 100) : '';
  const rawEmail = typeof body['email'] === 'string' ? body['email'].slice(0, 254) : '';
  const email = normalizeEmail(body['email']);
  const again = (error: string, errorField: 'name' | 'email', status: 400 | 429 = 400) =>
    render(c, 'Opret konto', signupPage({ csrf: c.get('csrf'), name, email: rawEmail, error, errorField }), { status });
  if (!name) return again('Skriv dit navn.', 'name');
  if (!email) return again('Indtast en gyldig e-mailadresse.', 'email');

  const ip = c.req.header('CF-Connecting-IP') ?? 'ukendt';
  const ipOk = await rateLimit(c.env.DB, 'ip:' + (await sha256Hex(ip)), 10, 15 * 60);
  const emailOk = await rateLimit(c.env.DB, 'email:' + (await sha256Hex(email)), 3, 15 * 60);
  if (!ipOk || !emailOk) return again('For mange forsøg. Vent 15 minutter, og prøv igen.', 'email', 429);

  // Findes kontoen allerede, sendes et almindeligt login-link. Svaret er det samme, så det
  // ikke afslører, om e-mailen er kunde.
  const exists = isAdmin(c.env, email) || !!(await getCustomerByEmail(c.env.DB, email));
  const next = '/konto';
  const token = await createLoginToken(c.env, email, { signup: !exists, name, next });
  const link = `${c.env.APP_URL.replace(/\/+$/, '')}/login/bekraeft?token=${encodeURIComponent(token)}`;
  if (c.env.RESEND_API_KEY) {
    const msg = exists ? magicLinkEmail(link) : signupEmail(link, name);
    c.executionCtx.waitUntil(
      sendEmail(c.env, { to: email, ...msg }).catch((err) => console.error('Opret-mail fejlede:', (err as Error).message)),
    );
  } else {
    console.log(`[DEV] Ingen RESEND_API_KEY – opret-link: ${link}`);
    if (c.env.DEV_MODE === '1') return render(c, 'Tjek din indbakke', loginSentPage({ devLink: link }));
  }
  return render(c, 'Tjek din indbakke', signupSentPage());
});

auth.post('/logout', async (c) => {
  await destroySession(c);
  return c.redirect('/login?besked=logget_ud', 303);
});

export default auth;
