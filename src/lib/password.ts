import { nowSec, timingSafeEqual } from './crypto';

/** Adgangskoder til admins: PBKDF2-SHA256 med tilfældigt salt (Workers tillader højst 100.000 iterationer). */

const ITERATIONS = 100_000;
export const MIN_LENGTH = 10;
export const MAX_LENGTH = 200;

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return toHex(new Uint8Array(bits));
}

/** Returnerer en fejltekst, eller null hvis adgangskoden er god nok. */
export function passwordProblem(pw: string, email: string): string | null {
  if (pw.length < MIN_LENGTH) return `Adgangskoden skal være mindst ${MIN_LENGTH} tegn.`;
  if (pw.length > MAX_LENGTH) return `Adgangskoden må højst være ${MAX_LENGTH} tegn.`;
  const local = email.split('@')[0]!.toLowerCase();
  if ((local.length >= 4 && pw.toLowerCase().includes(local)) || /^(.)\1+$/.test(pw) || /^(?:0123456789|1234567890|password|adgangskode)/i.test(pw)) return 'Vælg en adgangskode, der er sværere at gætte.';
  return null;
}

export async function setAdminPassword(db: D1Database, email: string, password: string): Promise<void> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await derive(password, salt, ITERATIONS);
  await db
    .prepare(
      `INSERT INTO admin_passwords (email, hash, salt, iterations, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(email) DO UPDATE SET hash = ?2, salt = ?3, iterations = ?4, updated_at = ?5`,
    )
    .bind(email, hash, toHex(salt), ITERATIONS, nowSec())
    .run();
}

export async function hasAdminPassword(db: D1Database, email: string): Promise<boolean> {
  return !!(await db.prepare('SELECT 1 FROM admin_passwords WHERE email = ?').bind(email).first());
}

/** Tjekker adgangskoden. Bruger samme tid, uanset om e-mailen har en adgangskode. */
export async function verifyAdminPassword(db: D1Database, email: string, password: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT hash, salt, iterations FROM admin_passwords WHERE email = ?')
    .bind(email)
    .first<{ hash: string; salt: string; iterations: number }>();
  const salt = row ? fromHex(row.salt) : new Uint8Array(16);
  const actual = await derive(password.slice(0, MAX_LENGTH), salt, row?.iterations ?? ITERATIONS);
  return !!row && timingSafeEqual(actual, row.hash);
}
