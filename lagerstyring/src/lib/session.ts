import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv, Env, SessionInfo, User } from '../env';
import { nowSec, randomToken, sha256Hex, timingSafeEqual } from './crypto';

/** Brugere forbliver logget ind; udløbet forlænges, mens de bruger systemet. */
export const SESSION_TTL = 90 * 86400;
const RENEW_AFTER = 7 * 86400;
export const LOGIN_TOKEN_TTL = 15 * 60; // 15 minutter

function isSecure(c: Context): boolean {
  return new URL(c.req.url).protocol === 'https:';
}

/** Med HTTPS bruges __Host-præfiks: cookien er bundet til præcis dette domæne og kræver Secure. */
function cookieName(c: Context, base: string): string {
  return isSecure(c) ? `__Host-${base}` : base;
}

function cookieOpts(c: Context, maxAge: number) {
  return { path: '/', httpOnly: true, secure: isSecure(c), sameSite: 'Lax' as const, maxAge };
}

export function parseAdminEmails(env: Env): Set<string> {
  return new Set(
    (env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Administratorer kan skifte logo, invitere brugere og udnævne andre administratorer. */
export function isAdminUser(env: Env, user: User | null | undefined): boolean {
  return !!user && (!!user.is_admin || parseAdminEmails(env).has(user.email.toLowerCase()));
}

/** Ejer og indkøber har lagerportalen, priser og indkøb; medarbejdere har forbrugsportalen. */
export function canManage(user: User | null | undefined): boolean {
  return !!user && (user.role === 'ejer' || user.role === 'indkober');
}

/**
 * Finder en aktiv bruger. Ejere i ADMIN_EMAILS oprettes automatisk ved første login, så et nyt
 * system altid kan tages i brug.
 */
export async function findUser(env: Env, email: string): Promise<User | null> {
  const e = email.toLowerCase();
  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ? AND active = 1').bind(e).first<User>();
  if (user) return user;
  if (!parseAdminEmails(env).has(e)) return null;
  const name = e.split('@')[0]!.replace(/[._-]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
  return env.DB.prepare(
    `INSERT INTO users (email, name, role, alert_mail, purchase_mail, created_at) VALUES (?, ?, 'ejer', 1, 1, ?)
     ON CONFLICT(email) DO UPDATE SET active = 1, role = 'ejer' RETURNING *`,
  )
    .bind(e, name, nowSec())
    .first<User>();
}

/** Indlæser session fra cookie og sørger for et CSRF-token (sessionens eller et anonymt). */
export const sessionMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  let session: SessionInfo | null = null;
  const raw = getCookie(c, cookieName(c, 'ls_session'));
  if (raw && raw.length >= 32 && raw.length <= 128) {
    const idHash = await sha256Hex(raw);
    const row = await c.env.DB.prepare(
      `SELECT s.csrf_token, s.expires_at, u.* FROM sessions s JOIN users u ON u.email = s.email AND u.active = 1 WHERE s.id_hash = ?`,
    )
      .bind(idHash)
      .first<User & { csrf_token: string; expires_at: number }>();
    const now = nowSec();
    // En bruger, der er deaktiveret, mister adgangen med det samme
    if (row && row.expires_at > now) {
      const { csrf_token, expires_at, ...user } = row;
      session = { idHash, csrf: csrf_token, user };
      if (expires_at < now + SESSION_TTL - RENEW_AFTER) {
        await c.env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE id_hash = ?').bind(now + SESSION_TTL, idHash).run();
        setCookie(c, cookieName(c, 'ls_session'), raw, cookieOpts(c, SESSION_TTL));
      }
    }
  }
  c.set('session', session);

  if (session) {
    c.set('csrf', session.csrf);
  } else {
    const name = cookieName(c, 'ls_csrf');
    let anon = getCookie(c, name);
    if (!anon || !/^[A-Za-z0-9_-]{32,64}$/.test(anon)) {
      anon = randomToken(24);
      setCookie(c, name, anon, cookieOpts(c, 12 * 3600));
    }
    c.set('csrf', anon);
  }
  await next();
};

/**
 * CSRF-beskyttelse for alle POST-formularer:
 *  1) Origin (eller Sec-Fetch-Site) må ikke være fremmed.
 *  2) Skjult felt `_csrf` skal matche sessionens token (eller det anonyme cookie-token).
 */
/**
 * En hel HTML-side i stedet for kort tekst: Chrome erstatter korte fejlsvar med sin egen
 * "Access denied"-side, og så kan man ikke se, at afvisningen kom herfra eller hvorfor.
 */
function forbidden(c: Context, reason: string): Response {
  console.warn(`CSRF-afvisning: ${reason} (${c.req.method} ${new URL(c.req.url).pathname})`);
  return c.html(
    `<!doctype html><html lang="da"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Anmodningen blev afvist</title><link rel="stylesheet" href="/static/app.css"><body><main><div class="wrap narrow stack-lg"><h1>Anmodningen blev afvist</h1><p class="muted">Af sikkerhedshensyn blev formularen ikke sendt (${reason}). Det sker typisk, når siden har stået åben længe, eller når den er sendt fra en anden side. Gå til login-siden og prøv igen. Fortsætter det, så skriv til kontakt@veyro.dk med teksten i parentesen.</p><a class="btn btn-primary" href="/login">Til login-siden</a></div></main></body></html>`,
    403,
  );
}

export const csrfMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method !== 'POST') return next();
  const origin = c.req.header('Origin');
  const selfOrigin = new URL(c.req.url).origin;
  if (origin && origin !== selfOrigin) return forbidden(c, `fremmed afsender: ${origin.replace(/[^a-z0-9:/.-]/gi, "").slice(0, 80)}`);
  if (!origin && c.req.header('Sec-Fetch-Site') === 'cross-site') return forbidden(c, 'fremmed side');

  const ct = c.req.header('Content-Type') ?? '';
  if (!ct.startsWith('application/x-www-form-urlencoded') && !ct.startsWith('multipart/form-data')) {
    return c.text('Ugyldig anmodning.', 415);
  }
  const body = await c.req.parseBody();
  const raw = body['_csrf'];
  const token = typeof raw === 'string' ? raw : '';
  const expected = c.get('csrf');
  if (!token || !expected || !timingSafeEqual(token, expected)) {
    // En login-side, der har stået åben for længe: vis siden igen med et nyt token i stedet for en fejl.
    // Intet sendes; brugeren trykker blot igen.
    if (!c.get('session') && new URL(c.req.url).pathname === '/login') {
      const email = typeof body['email'] === 'string' ? body['email'].trim().slice(0, 254) : '';
      return c.redirect(`/login?besked=login_udlobet${email ? `&email=${encodeURIComponent(email)}` : ''}`, 303);
    }
    return forbidden(c, token ? 'udløbet sikkerhedskode' : 'manglende sikkerhedskode');
  }
  await next();
};

function loginRedirect(c: Context<AppEnv>) {
  const path = new URL(c.req.url).pathname;
  return c.redirect(c.req.method === 'GET' ? `/login?next=${encodeURIComponent(path)}` : '/login', 303);
}

/** Kræver en logget ind bruger (alle roller). */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('session')) return loginRedirect(c);
  await next();
};

/** Kræver ejer eller indkøber. Medarbejdere sendes til forbrugsportalen. */
export const requireManager: MiddlewareHandler<AppEnv> = async (c, next) => {
  const s = c.get('session');
  if (!s) return loginRedirect(c);
  if (!canManage(s.user)) return c.redirect('/job?besked=ingen_adgang', 303);
  await next();
};

export async function createSession(c: Context<AppEnv>, email: string): Promise<void> {
  const raw = randomToken(32);
  const now = nowSec();
  await c.env.DB.prepare('INSERT INTO sessions (id_hash, email, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256Hex(raw), email.toLowerCase(), randomToken(24), now + SESSION_TTL, now)
    .run();
  setCookie(c, cookieName(c, 'ls_session'), raw, cookieOpts(c, SESSION_TTL));
}

export async function destroySession(c: Context<AppEnv>): Promise<void> {
  const s = c.get('session');
  if (s) await c.env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(s.idHash).run();
  deleteCookie(c, cookieName(c, 'ls_session'), { path: '/', secure: isSecure(c) });
}

/** Kun lokale stier i systemet, aldrig "//host" eller fulde URL'er. */
export function safeNext(next: unknown): string | null {
  return typeof next === 'string' && /^\/(lager|job)(\/[A-Za-z0-9\-._~\/]*)?$/.test(next) && next.length <= 200 ? next : null;
}

/** Opretter et engangs-login-token; kun SHA-256-hashen gemmes. */
export async function createLoginToken(env: Env, email: string): Promise<string> {
  const token = randomToken(32);
  const now = nowSec();
  await env.DB.prepare('INSERT INTO login_tokens (token_hash, email, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(token), email.toLowerCase(), now + LOGIN_TOKEN_TTL, now)
    .run();
  return token;
}

/** Forbruger et login-token atomisk. Returnerer e-mailen eller null. */
export async function consumeLoginToken(env: Env, token: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) return null;
  const now = nowSec();
  const row = await env.DB.prepare(
    `UPDATE login_tokens SET used_at = ?1
     WHERE token_hash = ?2 AND used_at IS NULL AND expires_at > ?1
     RETURNING email`,
  )
    .bind(now, await sha256Hex(token))
    .first<{ email: string }>();
  return row?.email ?? null;
}

/**
 * Fast vindue-tæller. Returnerer true hvis handlingen er tilladt.
 * Nøgler bør være hashede, så der ikke gemmes rå IP-adresser.
 */
export async function rateLimit(db: D1Database, key: string, limit: number, windowSec: number): Promise<boolean> {
  const now = nowSec();
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, count, reset_at) VALUES (?1, 1, ?2)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN rate_limits.reset_at <= ?3 THEN 1 ELSE rate_limits.count + 1 END,
         reset_at = CASE WHEN rate_limits.reset_at <= ?3 THEN ?2 ELSE rate_limits.reset_at END
       RETURNING count`,
    )
    .bind(key, now + windowSec, now)
    .first<{ count: number }>();
  return (row?.count ?? 1) <= limit;
}

export async function cleanup(db: D1Database): Promise<void> {
  const now = nowSec();
  await db.batch([
    db.prepare('DELETE FROM login_tokens WHERE expires_at < ?').bind(now - 3600),
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    db.prepare('DELETE FROM rate_limits WHERE reset_at < ?').bind(now),
    // Engangsnøgler skal kun huskes, så længe en formular kan blive sendt igen
    db.prepare('DELETE FROM ops WHERE created_at < ?').bind(now - 30 * 86400),
  ]);
}
