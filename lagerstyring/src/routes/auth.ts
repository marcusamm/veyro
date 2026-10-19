import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { sha256Hex } from '../lib/crypto';
import { emailConfigured, loginEmail, sendEmail } from '../lib/email';
import { normalizeEmail, str } from '../lib/format';
import { appUrl } from '../lib/notices';
import { canManage, consumeLoginToken, createLoginToken, createSession, destroySession, findUser, rateLimit, safeNext } from '../lib/session';
import { ensureDemo, DEMO_USERS } from '../lib/demo';
import { isDemo, render } from '../render';
import { loginPage, loginSentPage, verifyPage } from '../views/auth';

const auth = new Hono<AppEnv>();
const NONE = { portal: 'none' } as const;

auth.get('/', (c) => {
  const s = c.get('session');
  if (!s) return c.redirect('/login', 302);
  return c.redirect(canManage(s.user) ? '/lager' : '/job', 302);
});

auth.get('/login', async (c) => {
  if (c.get('session')) return c.redirect('/', 302);
  if (isDemo(c)) await ensureDemo(c.env);
  return render(
    c,
    'Log ind',
    // Kundelogin på kunde.veyro.dk sender brugeren hertil med e-mailen udfyldt
    loginPage({ csrf: c.get('csrf'), email: str(c.req.query('email'), 254), next: safeNext(c.req.query('next')), info: c.req.query('besked'), demo: isDemo(c), company: c.get('settings').company_name }),
    NONE,
  );
});

auth.post('/login', async (c) => {
  const body = await c.req.parseBody();
  const next = safeNext(body['next']);
  const email = normalizeEmail(body['email']);
  const s = c.get('settings');
  const page = (error: string, status: 400 | 429) =>
    render(c, 'Log ind', loginPage({ csrf: c.get('csrf'), email: str(body['email'], 254), error, next, demo: isDemo(c), company: s.company_name }), NONE, status);
  if (!email) return page('Indtast en gyldig e-mailadresse.', 400);
  const ip = c.req.header('CF-Connecting-IP') ?? 'ukendt';
  const ipOk = await rateLimit(c.env.DB, 'login-ip:' + (await sha256Hex(ip)), 10, 15 * 60);
  const emailOk = await rateLimit(c.env.DB, 'login-email:' + (await sha256Hex(email)), 5, 15 * 60);
  if (!ipOk || !emailOk) return page('For mange forsøg. Vent 15 minutter, og prøv igen.', 429);

  // Samme svar uanset om e-mailen har adgang, så man ikke kan afprøve adresser
  let devLink: string | null = null;
  if (await findUser(c.env, email)) {
    const token = await createLoginToken(c.env, email);
    const link = `${appUrl(c.env) || new URL(c.req.url).origin}/login/bekraeft?token=${encodeURIComponent(token)}${next ? `&next=${encodeURIComponent(next)}` : ''}`;
    if (emailConfigured(c.env)) {
      c.executionCtx.waitUntil(sendEmail(c.env, { to: email, ...loginEmail(link, s) }, s).catch((err) => console.error('Login-mail fejlede:', (err as Error).message)));
    } else {
      console.log(`[DEV] Ingen RESEND_API_KEY – login-link: ${link}`);
    }
    if (c.env.DEV_MODE === '1') devLink = link;
  }
  return render(c, 'Tjek din indbakke', loginSentPage(devLink), NONE);
});

// GET viser kun en knap; selve login sker ved POST, så e-mail-scannere ikke bruger engangslinket.
auth.get('/login/bekraeft', (c) => {
  const token = c.req.query('token') ?? '';
  return render(c, 'Bekræft login', verifyPage(c.get('csrf'), token, safeNext(c.req.query('next'))), NONE);
});

auth.post('/login/bekraeft', async (c) => {
  const body = await c.req.parseBody();
  const email = await consumeLoginToken(c.env, String(body['token'] ?? ''));
  const s = c.get('settings');
  if (!email || !(await findUser(c.env, email))) {
    return render(c, 'Log ind', loginPage({ csrf: c.get('csrf'), error: 'Linket er udløbet eller allerede brugt. Bed om et nyt.', demo: isDemo(c), company: s.company_name }), NONE, 400);
  }
  await createSession(c, email);
  return c.redirect(safeNext(body['next']) ?? '/', 303);
});

// Demo: log ind med ét klik som ejer eller medarbejder (kun når DEMO_MODE=1)
auth.post('/login/demo', async (c) => {
  if (!isDemo(c)) return c.notFound();
  const body = await c.req.parseBody();
  const role = body['role'] === 'medarbejder' ? 'medarbejder' : 'ejer';
  await ensureDemo(c.env);
  await createSession(c, DEMO_USERS[role].email);
  return c.redirect(role === 'ejer' ? '/lager' : '/job', 303);
});

auth.post('/logout', async (c) => {
  await destroySession(c);
  return c.redirect('/login?besked=logget_ud', 303);
});

export default auth;
