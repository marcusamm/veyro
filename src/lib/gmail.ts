// Google Workspace-mail via Googles officielle OAuth 2.0-flow (webserver med PKCE) og Gmail API.
// Rettigheder: gmail.readonly (læse og matche samtaler). gmail.compose kun, hvis kladder slås til ved
// tilslutning, og kun til at oprette kladder; der sendes aldrig mails herfra.
// Refresh-tokens krypteres (AES-GCM) med MAIL_TOKEN_KEY og gemmes kun på serveren. Tokens logges aldrig.
import type { Env } from '../env';
import { nowSec, randomToken, sha256Hex } from './crypto';
import { mailAccounts } from './prospects';

export const SCOPE_READ = 'https://www.googleapis.com/auth/gmail.readonly';
export const SCOPE_COMPOSE = 'https://www.googleapis.com/auth/gmail.compose';

const authBase = (env: Env) => (env.GOOGLE_OAUTH_BASE ?? 'https://accounts.google.com').replace(/\/+$/, '');
const tokenBase = (env: Env) => (env.GOOGLE_TOKEN_BASE ?? 'https://oauth2.googleapis.com').replace(/\/+$/, '');
const apiBase = (env: Env) => (env.GMAIL_API_BASE ?? 'https://gmail.googleapis.com').replace(/\/+$/, '');

export function redirectUri(env: Env): string {
  return `${env.APP_URL.replace(/\/+$/, '')}/admin/kundeemner/mail/callback`;
}

export interface SetupStatus {
  ready: boolean;
  missing: string[];
}

/** Hvad mangler, før konti kan forbindes */
export function setupStatus(env: Env): SetupStatus {
  const missing: string[] = [];
  if (!env.GOOGLE_CLIENT_ID) missing.push('GOOGLE_CLIENT_ID (variabel)');
  if (!env.GOOGLE_CLIENT_SECRET) missing.push('GOOGLE_CLIENT_SECRET (secret)');
  if (!keyBytes(env)) missing.push('MAIL_TOKEN_KEY (secret, 32 tilfældige bytes i base64)');
  if (!mailAccounts(env).length) missing.push('MAIL_ACCOUNTS (variabel)');
  return { ready: missing.length === 0, missing };
}

export class GmailError extends Error {
  constructor(
    message: string,
    public status: number,
    public reconnect = false,
  ) {
    super(message);
  }
}

// ---------- Kryptering af tokens ----------

function keyBytes(env: Env): Uint8Array | null {
  if (!env.MAIL_TOKEN_KEY) return null;
  try {
    const raw = Uint8Array.from(atob(env.MAIL_TOKEN_KEY.trim()), (ch) => ch.charCodeAt(0));
    return raw.length === 32 ? raw : null;
  } catch {
    return null;
  }
}

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

async function aesKey(env: Env): Promise<CryptoKey> {
  const k = keyBytes(env);
  if (!k) throw new GmailError('MAIL_TOKEN_KEY mangler eller er ugyldig.', 500);
  return crypto.subtle.importKey('raw', k, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptToken(env: Env, plain: string, account: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(account) }, await aesKey(env), new TextEncoder().encode(plain));
  return `v1.${b64(iv)}.${b64(new Uint8Array(ct))}`;
}

export async function decryptToken(env: Env, enc: string, account: string): Promise<string> {
  const [v, iv, ct] = enc.split('.');
  if (v !== 'v1' || !iv || !ct) throw new GmailError('Ukendt tokenformat.', 500, true);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: new TextEncoder().encode(account) }, await aesKey(env), unb64(ct));
  return new TextDecoder().decode(pt);
}

// ---------- OAuth ----------

function b64url(bytes: Uint8Array): string {
  return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Starter OAuth: gemmer engangs-state og PKCE-verifier og returnerer Googles samtykkeadresse */
export async function startOAuth(env: Env, account: string, startedBy: string, drafts: boolean): Promise<string> {
  const state = randomToken(32);
  const verifier = randomToken(48);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  await env.DB.prepare('DELETE FROM mail_oauth_states WHERE expires_at < ?').bind(nowSec()).run();
  await env.DB.prepare('INSERT INTO mail_oauth_states (state_hash, account, started_by, drafts, verifier, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(await sha256Hex(state), account, startedBy, drafts ? 1 : 0, verifier, nowSec() + 600)
    .run();
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri(env),
    response_type: 'code',
    scope: [SCOPE_READ, ...(drafts ? [SCOPE_COMPOSE] : [])].join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    login_hint: account,
    hd: account.split('@')[1]!,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${authBase(env)}/o/oauth2/v2/auth?${p}`;
}

export async function consumeState(env: Env, state: string): Promise<{ account: string; started_by: string; drafts: number; verifier: string } | null> {
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(state)) return null;
  return env.DB.prepare('DELETE FROM mail_oauth_states WHERE state_hash = ? AND expires_at > ? RETURNING account, started_by, drafts, verifier')
    .bind(await sha256Hex(state), nowSec())
    .first<{ account: string; started_by: string; drafts: number; verifier: string }>();
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(env: Env, params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${tokenBase(env)}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, ...params }),
    signal: AbortSignal.timeout(10000),
  });
  const j = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || j.error) {
    // Kun fejlkoden; aldrig tokens eller svarets fulde indhold
    throw new GmailError(`Google afviste (${j.error ?? res.status})`, res.status, j.error === 'invalid_grant' || j.error === 'unauthorized_client');
  }
  return j;
}

export async function exchangeCode(env: Env, code: string, verifier: string): Promise<TokenResponse> {
  return tokenRequest(env, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri(env) });
}

export async function accessToken(env: Env, account: string, tokenEnc: string): Promise<string> {
  const refresh = await decryptToken(env, tokenEnc, account);
  const j = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: refresh });
  if (!j.access_token) throw new GmailError('Intet adgangstoken fra Google.', 502);
  return j.access_token;
}

export async function revoke(env: Env, account: string, tokenEnc: string): Promise<void> {
  try {
    const refresh = await decryptToken(env, tokenEnc, account);
    await fetch(`${tokenBase(env)}/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: refresh }), signal: AbortSignal.timeout(8000) });
  } catch {
    /* tilbagekaldelse er "bedste forsøg"; tokenet slettes under alle omstændigheder */
  }
}

// ---------- Gmail API ----------

export async function gmail<T>(env: Env, token: string, path: string, init: { method?: string; body?: unknown; query?: Record<string, string | string[] | undefined> } = {}): Promise<T> {
  const url = new URL(`${apiBase(env)}/gmail/v1/users/me${path}`);
  for (const [k, v] of Object.entries(init.query ?? {})) {
    if (v === undefined) continue;
    for (const x of Array.isArray(v) ? v : [v]) url.searchParams.append(k, x);
  }
  const res = await fetch(url.toString(), {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: { status?: string; message?: string } };
    throw new GmailError(`Gmail API ${res.status} ${j.error?.status ?? ''}`.trim(), res.status, res.status === 401);
  }
  return (await res.json()) as T;
}

export interface GmailHeader {
  name: string;
  value: string;
}
export interface GmailPart {
  mimeType?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}
export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  historyId?: string;
  payload?: GmailPart;
}

export const META_HEADERS = ['From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID', 'In-Reply-To', 'References', 'Auto-Submitted', 'X-Autoreply', 'X-Autorespond', 'Precedence', 'Content-Type', 'Return-Path', 'X-Failed-Recipients'];

export function header(m: GmailMessage, name: string): string | null {
  const h = m.payload?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}

/** Ren tekst fra en besked: text/plain foretrækkes; HTML omdannes til tekst. Billeder og links indlæses aldrig. */
export function plainBody(m: GmailMessage): string {
  const dec = (d: string) => {
    try {
      const bin = atob(d.replace(/-/g, '+').replace(/_/g, '/'));
      return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
    } catch {
      return '';
    }
  };
  let plain: string | null = null;
  let htmlPart: string | null = null;
  const walk = (p: GmailPart | undefined) => {
    if (!p) return;
    if (p.mimeType === 'text/plain' && p.body?.data && plain === null) plain = dec(p.body.data);
    else if (p.mimeType === 'text/html' && p.body?.data && htmlPart === null) htmlPart = dec(p.body.data);
    p.parts?.forEach(walk);
  };
  walk(m.payload);
  const text =
    plain ??
    (htmlPart
      ? (htmlPart as string)
          .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, '')
          .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
      : '');
  return text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 50_000);
}

/** Adresser fra en To/Cc/From-header (små bogstaver) */
export function addresses(h: string | null): { email: string; name: string | null }[] {
  if (!h) return [];
  const out: { email: string; name: string | null }[] = [];
  for (const part of h.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
    const m = /<([^>]+)>/.exec(part);
    const email = (m ? m[1]! : part).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
    const name = m ? part.slice(0, m.index).trim().replace(/^"|"$/g, '') || null : null;
    out.push({ email, name });
  }
  return out;
}

/** Bygger en RFC 2822-besked (base64url) til en Gmail-kladde */
export function rawMessage(from: string, to: string, subject: string, body: string): string {
  const enc = (s: string) => `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(s)))}?=`;
  const bodyB64 = btoa(String.fromCharCode(...new TextEncoder().encode(body))).replace(/(.{76})/g, '$1\r\n');
  const msg = [`From: ${from}`, `To: ${to}`, `Subject: ${enc(subject)}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', bodyB64].join('\r\n');
  return btoa(String.fromCharCode(...new TextEncoder().encode(msg))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
