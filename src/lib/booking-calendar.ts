import type { CustomerRow, Env, SubscriptionRow } from '../env';
import { copenhagenInstants, iso, validDate, zonedParts } from '../aj/store';
import { legacyAjOrigin, publicAjOrigin } from '../aj/hosts';
import { nowSec } from './crypto';
import { getCurrentSubscription, getCustomerByEmail, normalizeEmail } from './db';

/**
 * Explicit product/source mapping. Never infer a booking tenant from a plan name,
 * price, website URL, query parameter or a self-created customer account.
 * Future workspaces need their own membership and isolated source adapter here.
 */
export const BOOKING_WORKSPACES = {
  'aj-auto': { id: 'aj-auto', name: 'AJ Auto', product: 'booking', source: 'aj' },
} as const;

export interface BookingCalendarAccess {
  workspace: typeof BOOKING_WORKSPACES['aj-auto'];
  customerId: number;
  subscriptionId: string;
  staffId: number;
  staffName: string;
  email: string;
  role: 'owner' | 'staff';
}

export function validCalendarContract(sub: SubscriptionRow | null, at = nowSec()): boolean {
  if (!sub || !['active', 'trialing'].includes(sub.status)) return false;
  if (sub.started_at !== null && sub.started_at > at) return false;
  if (sub.cancel_at !== null && sub.cancel_at <= at) return false;
  if (sub.current_period_end !== null && sub.current_period_end <= at) return false;
  return true;
}

/** Current contract + trusted active source membership; admins have no bypass. */
export async function getBookingCalendarAccess(db: D1Database, rawEmail: string, at = nowSec()): Promise<BookingCalendarAccess | null> {
  const email = normalizeEmail(rawEmail);
  if (!email) return null;
  const customer = await getCustomerByEmail(db, email);
  if (!customer) return null;
  const contract = await getCurrentSubscription(db, customer.id);
  return getBookingCalendarAccessForCustomer(db, customer, contract, at);
}

/** Reuse the server's current customer/contract lookup when building account navigation. */
export async function getBookingCalendarAccessForCustomer(db: D1Database, customer: CustomerRow, contract: SubscriptionRow | null, at = nowSec()): Promise<BookingCalendarAccess | null> {
  if (contract?.customer_id !== customer.id) return null;
  if (!validCalendarContract(contract, at)) return null;
  const email = normalizeEmail(customer.email);
  if (!email) return null;
  // Older deployments without the AJ migration have no source to grant access to.
  const exists = await db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='aj_staff'").first();
  if (!exists) return null;
  const member = await db.prepare("SELECT id,name,role FROM aj_staff WHERE email=? COLLATE NOCASE AND active=1").bind(email)
    .first<{ id: number; name: string; role: string }>();
  if (!member || !['owner', 'staff'].includes(member.role)) return null;
  return {
    workspace: BOOKING_WORKSPACES['aj-auto'], customerId: customer.id, subscriptionId: contract!.id,
    staffId: member.id, staffName: member.name, email, role: member.role as 'owner' | 'staff',
  };
}

export class CalendarInputError extends Error {
  constructor(message: string, public status: 400 | 403 = 400) { super(message); }
}
export interface CalendarSelection {
  month: string;
  day: string;
  today: string;
  firstGridDay: string;
  endGridDay: string;
  previousMonth: string;
  nextMonth: string;
  days: string[];
}
function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(date + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);
}
function shiftMonth(month: string, by: number): string {
  const date = new Date(month + '-15T12:00:00Z');
  date.setUTCMonth(date.getUTCMonth() + by);
  return date.toISOString().slice(0, 7);
}
export function calendarSelection(query: { month?: string; day?: string }, at = nowSec()): CalendarSelection {
  const today = zonedParts(at).date;
  const month = query.month || (query.day?.slice(0, 7)) || today.slice(0, 7);
  if (!/^(?:19|20|21)\d{2}-(?:0[1-9]|1[0-2])$/.test(month)) throw new CalendarInputError('Vælg en gyldig måned.');
  const day = query.day || (month === today.slice(0, 7) ? today : `${month}-01`);
  if (!validDate(day) || !day.startsWith(`${month}-`)) throw new CalendarInputError('Vælg en dato i den viste måned.');
  const first = `${month}-01`;
  const weekday = (new Date(first + 'T12:00:00Z').getUTCDay() + 6) % 7;
  const firstGridDay = shiftDate(first, -weekday);
  const days = Array.from({ length: 42 }, (_, i) => shiftDate(firstGridDay, i));
  return { month, day, today, firstGridDay, endGridDay: shiftDate(firstGridDay, 42), previousMonth: shiftMonth(month, -1), nextMonth: shiftMonth(month, 1), days };
}
function midnight(date: string): number {
  const value = copenhagenInstants(date, 0)[0];
  if (value === undefined) throw new CalendarInputError('Datoen kunne ikke læses. Vælg en anden dato.');
  return value;
}
export interface CalendarMember { id: number; name: string; active: number; }
export interface CalendarAppointment {
  id: string;
  serviceName: string;
  staffId: number;
  staffName: string;
  startAt: string;
  endAt: string;
  name: string;
  email: string;
  phone: string;
  registration: string;
  note: string;
  status: 'confirmed' | 'cancelled';
}
export interface CalendarData {
  access: BookingCalendarAccess;
  selection: CalendarSelection;
  members: CalendarMember[];
  selectedStaff: number | null;
  counts: Record<string, number>;
  appointments: CalendarAppointment[];
  truncated: boolean;
}

export async function loadBookingCalendar(db: D1Database, access: BookingCalendarAccess, selection: CalendarSelection, staffQuery?: string): Promise<CalendarData> {
  // Source selection is fixed by a trusted adapter, never by an incoming table/tenant name.
  if (access.workspace.id !== 'aj-auto' || access.workspace.source !== 'aj') throw new CalendarInputError('Du har ikke adgang til denne kalender.', 403);
  let selectedStaff: number | null = access.role === 'staff' ? access.staffId : null;
  if (staffQuery) {
    if (!/^[1-9]\d*$/.test(staffQuery) || !Number.isSafeInteger(Number(staffQuery))) throw new CalendarInputError('Vælg en gyldig kalender.');
    const requested = Number(staffQuery);
    if (access.role === 'staff' && requested !== access.staffId) throw new CalendarInputError('Du har kun adgang til din egen kalender.', 403);
    selectedStaff = requested;
  }
  const memberQuery = access.role === 'staff' ? 'SELECT id,name,active FROM aj_staff WHERE id=?' : 'SELECT id,name,active FROM aj_staff ORDER BY active DESC,name';
  const members = (await db.prepare(memberQuery).bind(...(access.role === 'staff' ? [access.staffId] : [])).all<CalendarMember>()).results;
  if (selectedStaff !== null && !members.some(member => member.id === selectedStaff)) throw new CalendarInputError('Kalenderen findes ikke.');
  const scope = selectedStaff === null ? '' : ' AND staff_id=?';
  const scopedParams = selectedStaff === null ? [] : [selectedStaff];
  const [counts, rows] = await Promise.all([
    db.prepare(`SELECT local_date AS day,COUNT(*) AS n FROM aj_bookings WHERE status='confirmed' AND start_at>=? AND start_at<?${scope} GROUP BY local_date`)
      .bind(midnight(selection.firstGridDay), midnight(selection.endGridDay), ...scopedParams).all<{ day: string; n: number }>(),
    db.prepare(`SELECT id,service_name AS serviceName,staff_id AS staffId,staff_name AS staffName,start_at AS startAt,end_at AS endAt,name,email,phone,registration,note,status FROM aj_bookings WHERE start_at>=? AND start_at<?${scope} ORDER BY start_at,name LIMIT 501`)
      .bind(midnight(selection.day), midnight(shiftDate(selection.day, 1)), ...scopedParams)
      .all<Omit<CalendarAppointment, 'startAt' | 'endAt'> & { startAt: number; endAt: number }>(),
  ]);
  return {
    access, selection, members, selectedStaff,
    counts: Object.fromEntries(counts.results.map(row => [row.day, row.n])),
    appointments: rows.results.slice(0, 500).map(row => ({ ...row, startAt: iso(row.startAt), endAt: iso(row.endAt) })),
    truncated: rows.results.length > 500,
  };
}

/** Only trusted configured AJ hosts; data from customer profiles is never used. */
export function bookingAdminUrl(env: Pick<Env, 'AJ_URL' | 'AJ_HOSTS' | 'DEV_MODE'>, requestOrigin?: string): string {
  const fallback = legacyAjOrigin + '/admin';
  const configuredHosts = (env.AJ_HOSTS || '').split(',').map(host => host.trim().toLowerCase()).filter(Boolean);
  if (env.DEV_MODE === '1' && requestOrigin) {
    try {
      const request = new URL(requestOrigin);
      const localHost = configuredHosts.find(host => ['localhost', '127.0.0.1'].includes(host));
      if (localHost && ['localhost', '127.0.0.1'].includes(request.hostname) && ['http:', 'https:'].includes(request.protocol)) {
        return `${request.protocol}//${localHost}${request.port ? `:${request.port}` : ''}/admin`;
      }
    } catch { /* Use the canonical link. */ }
  }
  try {
    const url = new URL(env.AJ_URL || legacyAjOrigin);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return fallback;
    const publicOrigin = publicAjOrigin(url.hostname);
    if (publicOrigin) return publicOrigin + '/admin';
    if (!configuredHosts.includes(url.hostname) || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/i.test(url.hostname)) return fallback;
    return `${url.origin}/admin`;
  } catch { return fallback; }
}
