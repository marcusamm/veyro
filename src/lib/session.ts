import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { AppEnv, Env, SessionInfo } from '../env';
import { nowSec, randomToken, sha256Hex, timingSafeEqual } from './crypto';

export const SESSION_TTL = 30 * 86400; // 30 dage
export const LOGIN_TOKEN_TTL = 15 * 60; // 15 minutter

function isSecure(c: Context): boolean {
  return new URL(c.req.url).protocol === 'https:';
}

/** Med HTTPS bruges __Host-præfiks: cookien er bundet til præcis dette domæne og kræver Secure. */
function cookieName(c: Context, base: string): string {
  return isSecure(c) ? `__Host-${base}` : base;
}

function cookieOpts(c: Context, maxAge: number) {
  return {
    path: '/',
    httpOnly: true,
    secure: isSecure(c),
    sameSite: 'Lax' as const,
    maxAge,
  };
}

export function parseAdminEmails(env: Env): Set<string> {
  return new Set(
    (env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAdmin(env: Env, email: string | null | undefined): boolean {
  return !!email && parseAdminEmails(env).has(email.toLowerCase());
}

/** Indlæser session fra cookie og sørger for et CSRF-token (sessionens eller et anonymt). */
export const sessionMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  let session: SessionInfo | null = null;
  const raw = getCookie(c, cookieName(c, 'vk_session'));
  if (raw && raw.length >= 32 && raw.length <= 128) {
    const idHash = await sha256Hex(raw);
    const row = await c.env.DB.prepare('SELECT email, csrf_token, expires_at FROM sessions WHERE id_hash = ?')
      .bind(idHash)
      .first<{ email: string; csrf_token: string; expires_at: number }>();
    if (row && row.expires_at > nowSec()) {
      session = { idHash, email: row.email, csrf: row.csrf_token };
    }
  }
  c.set('session', session);

  if (session) {
    c.set('csrf', session.csrf);
  } else {
    const name = cookieName(c, 'vk_csrf');
    let anon = getCookie(c, name);
    if (!anon || !/^[A-Za-z0-9_-]{32,64}$/.test(anon)) {
      anon = randomToken(24);
      setCookie(c, name, anon, cookieOpts(c, 2 * 3600));
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
export const csrfMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method !== 'POST') return next();
  const origin = c.req.header('Origin');
  const selfOrigin = new URL(c.req.url).origin;
  if (origin && origin !== 'null' && origin !== selfOrigin) return c.text('Ugyldig anmodning (CSRF).', 403);
  if (origin === 'null') return c.text('Ugyldig anmodning (CSRF).', 403);
  if (!origin && c.req.header('Sec-Fetch-Site') === 'cross-site') return c.text('Ugyldig anmodning (CSRF).', 403);

  const ct = c.req.header('Content-Type') ?? '';
  if (!ct.startsWith('application/x-www-form-urlencoded') && !ct.startsWith('multipart/form-data')) {
    return c.text('Ugyldig anmodning.', 415);
  }
  const body = await c.req.parseBody();
  const token = typeof body['_csrf'] === 'string' ? body['_csrf'] : '';
  const expected = c.get('csrf');
  if (!token || !expected || !timingSafeEqual(token, expected)) {
    return c.text('Ugyldig anmodning (CSRF). Genindlæs siden og prøv igen.', 403);
  }
  await next();
};

export async function createSession(c: Context<AppEnv>, email: string): Promise<void> {
  const raw = randomToken(32);
  const idHash = await sha256Hex(raw);
  const now = nowSec();
  await c.env.DB.prepare(
    'INSERT INTO sessions (id_hash, email, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(idHash, email, randomToken(24), now + SESSION_TTL, now)
    .run();
  setCookie(c, cookieName(c, 'vk_session'), raw, cookieOpts(c, SESSION_TTL));
}

export async function destroySession(c: Context<AppEnv>): Promise<void> {
  const s = c.get('session');
  if (s) await c.env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(s.idHash).run();
  deleteCookie(c, cookieName(c, 'vk_session'), { path: '/', secure: isSecure(c) });
}

export interface LoginTokenData {
  email: string;
  signup: boolean;
  name: string | null;
  next: string | null;
}

/** Kun lokale stier ("/..."), aldrig "//host" eller fulde URL'er. */
export function safeNext(next: unknown): string | null {
  return typeof next === 'string' && /^\/(?![\/\\])[A-Za-z0-9\-._~\/?=&%]*$/.test(next) && next.length <= 200 ? next : null;
}

/** Opretter et engangs-login-token; kun SHA-256-hashen gemmes. `signup` tillader oprettelse af ny kunde ved bekræftelse. */
export async function createLoginToken(
  env: Env,
  email: string,
  opts: { signup?: boolean; name?: string | null; next?: string | null } = {},
): Promise<string> {
  const token = randomToken(32);
  const now = nowSec();
  await env.DB.prepare(
    'INSERT INTO login_tokens (token_hash, email, expires_at, created_at, signup, name, next) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(await sha256Hex(token), email, now + LOGIN_TOKEN_TTL, now, opts.signup ? 1 : 0, opts.name ?? null, safeNext(opts.next))
    .run();
  return token;
}

/** Forbruger et login-token atomisk. Returnerer tokenets data eller null. */
export async function consumeLoginToken(env: Env, token: string): Promise<LoginTokenData | null> {
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) return null;
  const now = nowSec();
  const row = await env.DB.prepare(
    `UPDATE login_tokens SET used_at = ?1
     WHERE token_hash = ?2 AND used_at IS NULL AND expires_at > ?1
     RETURNING email, signup, name, next`,
  )
    .bind(now, await sha256Hex(token))
    .first<{ email: string; signup: number; name: string | null; next: string | null }>();
  return row ? { email: row.email, signup: row.signup === 1, name: row.name, next: safeNext(row.next) } : null;
}
