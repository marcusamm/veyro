// Medarbejdere og roller i kassen. Adresser i ADMIN_EMAILS er altid administratorer; øvrige
// medarbejdere oprettes under Kasse → Personale som administrator, leder eller kasseassistent.
// Rollen giver kun adgang til kassen (/admin/kasse). Resten af admin kræver stadig ADMIN_EMAILS.
import type { Env } from '../../env';
import { nowSec, randomToken, timingSafeEqual } from '../crypto';
import { isAdmin } from '../session';

export type Role = 'admin' | 'manager' | 'cashier';

export interface StaffInfo {
  email: string;
  name: string;
  role: Role;
}

export const ROLES: Role[] = ['admin', 'manager', 'cashier'];

export const ROLE_LABEL: Record<Role, string> = {
  admin: 'Administrator',
  manager: 'Leder',
  cashier: 'Kasseassistent',
};

export function isRole(r: unknown): r is Role {
  return typeof r === 'string' && (ROLES as string[]).includes(r);
}

export interface StaffRow {
  email: string;
  name: string;
  role: Role;
  active: number;
  pin_hash: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * Hvem e-mailen er i kassen, og med hvilken rolle. Null = ingen adgang til kassen.
 * En medarbejder, der er deaktiveret eller slettet, mister adgangen med det samme.
 */
export async function staffAccess(env: Env, email: string | null | undefined): Promise<StaffInfo | null> {
  if (!email) return null;
  const row = await getStaff(env.DB, email);
  if (isAdmin(env, email)) return { email: email.toLowerCase(), name: row?.name || '', role: 'admin' };
  if (!row || !row.active) return null;
  return { email: row.email.toLowerCase(), name: row.name, role: row.role };
}

export async function listStaff(db: D1Database): Promise<StaffRow[]> {
  const { results } = await db.prepare('SELECT * FROM pos_staff ORDER BY active DESC, name COLLATE NOCASE, email').all<StaffRow>();
  return results;
}

export async function getStaff(db: D1Database, email: string): Promise<StaffRow | null> {
  return db.prepare('SELECT * FROM pos_staff WHERE email = ?').bind(email.toLowerCase()).first<StaffRow>();
}

export async function upsertStaff(db: D1Database, s: { email: string; name: string; role: Role; active: boolean }): Promise<void> {
  const now = nowSec();
  await db
    .prepare(
      `INSERT INTO pos_staff (email, name, role, active, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
       ON CONFLICT(email) DO UPDATE SET name = excluded.name, role = excluded.role, active = excluded.active, updated_at = excluded.updated_at`,
    )
    .bind(s.email.toLowerCase(), s.name, s.role, s.active ? 1 : 0, now)
    .run();
}

/** Navn til visning: medarbejderens navn, ellers e-mailen. */
export async function staffNames(db: D1Database): Promise<Map<string, string>> {
  const { results } = await db.prepare("SELECT email, name FROM pos_staff WHERE name <> ''").all<{ email: string; name: string }>();
  return new Map(results.map((r) => [r.email.toLowerCase(), r.name]));
}

// ---------------- PIN-koder ----------------

const PIN_ITERATIONS = 100_000;
const enc = new TextEncoder();

export function pinValid(pin: string): boolean {
  return /^\d{4,8}$/.test(pin);
}

async function pbkdf2(pin: string, salt: string, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations }, key, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashPin(pin: string): Promise<string> {
  const salt = randomToken(16);
  return `pbkdf2$${PIN_ITERATIONS}$${salt}$${await pbkdf2(pin, salt, PIN_ITERATIONS)}`;
}

export async function verifyPin(pin: string, stored: string | null): Promise<boolean> {
  if (!stored || !pinValid(pin)) return false;
  const [kind, iter, salt, hash] = stored.split('$');
  if (kind !== 'pbkdf2' || !iter || !salt || !hash) return false;
  return timingSafeEqual(await pbkdf2(pin, salt, Number(iter)), hash);
}

/** Sætter en PIN-kode. Administratorer fra ADMIN_EMAILS uden række får en, så koden kan gemmes. */
export async function setPin(db: D1Database, email: string, pin: string, roleIfNew: Role): Promise<void> {
  const now = nowSec();
  await db
    .prepare(
      `INSERT INTO pos_staff (email, name, role, active, pin_hash, created_at, updated_at) VALUES (?1, '', ?2, 1, ?3, ?4, ?4)
       ON CONFLICT(email) DO UPDATE SET pin_hash = excluded.pin_hash, updated_at = excluded.updated_at`,
    )
    .bind(email.toLowerCase(), roleIfNew, await hashPin(pin), now)
    .run();
}

// ---------------- Rettigheder ----------------

export type Permission =
  | 'pos.sell' // bruge kassen
  | 'pos.sales.all' // se alle kassesalg (ellers kun egne)
  | 'pos.refund' // refundere uden godkendelse
  | 'pos.reports'
  | 'pos.items' // oprette og ændre ydelser og varer (og lager)
  | 'pos.settings'
  | 'staff.manage';

const GRANTS: Record<Role, Permission[]> = {
  admin: ['pos.sell', 'pos.sales.all', 'pos.refund', 'pos.reports', 'pos.items', 'pos.settings', 'staff.manage'],
  manager: ['pos.sell', 'pos.sales.all', 'pos.refund', 'pos.reports', 'pos.items'],
  cashier: ['pos.sell'],
};

export function can(role: Role | null | undefined, p: Permission): boolean {
  return !!role && GRANTS[role].includes(p);
}
