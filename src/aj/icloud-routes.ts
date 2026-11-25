import type { Context, Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppEnv } from '../env';
import { sha256Hex } from '../lib/crypto';
import { normalizeEmail, rateLimit } from '../lib/db';
import { AjError, type AjUser } from './types';
import {
  calendarConfigured, calendarConnection, connectPrivateCalendar,
  disconnectCalendar, listPrivateCalendars, setCalendarSelection,
} from './external-busy';

type C = Context<AppEnv>;
type RequireUser = (c: C) => Promise<AjUser>;
const path = '/admin/icloud';
const onlyTls = (c: C) => new URL(c.req.url).protocol === 'https:';
const unavailable = () => new AjError('iCloud-forbindelsen er ikke tilgængelig her.', 503);

async function staffContext(c: C, requireUser: RequireUser) {
  const who = await requireUser(c);
  if (!who.staffId || (who.role !== 'owner' && who.role !== 'staff')) {
    throw new AjError('Kun en aktiv medarbejder kan administrere sin egen iCloud-kalender.', 403);
  }
  // The AJ login verifies the active session and the current staff membership.
  // Never obtain staff ID/email from the submitted form, even for an owner.
  return { id: who.staffId, email: who.email };
}

async function mutationContext(c: C, requireUser: RequireUser) {
  const staff = await staffContext(c, requireUser);
  if (!onlyTls(c)) throw unavailable();
  // Same-origin JSON plus the host-only AJ session. Do not rely on the Apple
  // account matching the address used to log in to the workshop application.
  const raw = getCookie(c, '__Host-aj_session');
  if (!raw || !/^[a-zA-Z0-9_-]{43}$/.test(raw)) throw new AjError('Log ind igen.', 401);
  if (c.req.header('Origin') !== new URL(c.req.url).origin || c.req.header('Sec-Fetch-Site') === 'cross-site' ||
      !/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') || '')) {
    throw new AjError('Anmodningen kunne ikke godkendes.', 403);
  }
  const fence = { sessionHash: await sha256Hex(raw), email: staff.email };
  return { staffId: staff.id, fence };
}

async function fields(c: C, accepted: string[]): Promise<Record<string, unknown>> {
  let obj: unknown;
  try { obj = await c.req.json(); } catch { throw new AjError('Ugyldige oplysninger.'); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) ||
      Object.keys(obj).some(k => !accepted.includes(k))) throw new AjError('Ugyldige oplysninger.');
  return obj as Record<string, unknown>;
}

function configured(c: C) { return onlyTls(c) && calendarConfigured(c.env); }

// Mount under the existing AJ API, including its body-size limit, CSP, generic
// error handler, no-store responses, session checks and CSRF protection.
export function registerICloudRoutes(api: Hono<AppEnv>, requireUser: RequireUser) {
  api.get(path, async c => {
    const staff = await staffContext(c, requireUser);
    if (!onlyTls(c)) return c.json({ configured: false, state: 'disconnected', connected: false, selected: false });
    // Status remains readable when rollout is paused so staff can disconnect.
    const { state, selectedIds } = await calendarConnection(c.env, staff.id);
    return c.json({ configured: configured(c), state, connected: state !== 'disconnected', selected: selectedIds.length > 0 });
  });

  api.post(path + '/connect', async c => {
    const { staffId, fence } = await mutationContext(c, requireUser);
    if (!configured(c)) throw unavailable();
    const data = await fields(c, ['email', 'appPassword']);
    const email = normalizeEmail(data.email);
    // Apple-issued app-specific passwords have four groups of four lowercase
    // ASCII letters. Reject other formats before contacting Apple or storing anything.
    if (!email || /[\u0000-\u0020\u007f:]/.test(email) || typeof data.appPassword !== 'string' ||
        !/^[a-z]{4}(?:-[a-z]{4}){3}$/.test(data.appPassword)) {
      throw new AjError('Indtast e-mailen til din Apple-konto og en appspecifik adgangskode i formatet xxxx-xxxx-xxxx-xxxx. Brug aldrig din normale Apple-adgangskode.');
    }
    if (!await rateLimit(c.env.DB, 'aj:icloud-connect:' + staffId, 6, 900)) {
      throw new AjError('For mange forbindelsesforsøg. Prøv igen om 15 minutter.', 429);
    }
    await connectPrivateCalendar(c.env, staffId, { email, password: data.appPassword }, fence);
    return c.json({ ok: true });
  });

  api.get(path + '/calendars', async c => {
    const staff = await staffContext(c, requireUser);
    if (!configured(c)) throw unavailable();
    const status = await calendarConnection(c.env, staff.id);
    if (status.state === 'disconnected') throw new AjError('Tilslut din iCloud-konto først.', 409);
    if (!await rateLimit(c.env.DB, 'aj:icloud-list:' + staff.id, 30, 600)) {
      throw new AjError('Vent et øjeblik, før du henter kalenderlisten igen.', 429);
    }
    const options = await listPrivateCalendars(c.env, staff.id);
    const selected = new Set(status.selectedIds);
    return c.json({ calendars: options.map(({ id, name }) => ({ id, name, selected: selected.has(id) })) });
  });

  api.post(path + '/select', async c => {
    const { staffId, fence } = await mutationContext(c, requireUser);
    if (!configured(c)) throw unavailable();
    const { calendarIds } = await fields(c, ['calendarIds']);
    if (!Array.isArray(calendarIds) || calendarIds.length < 1 || calendarIds.length > 8 ||
        calendarIds.some(id => typeof id !== 'string' || id.length < 1 || id.length > 2048) ||
        new Set(calendarIds).size !== calendarIds.length) throw new AjError('Vælg mellem én og otte forskellige kalendere.');
    if (!await rateLimit(c.env.DB, 'aj:icloud-select:' + staffId, 12, 600)) {
      throw new AjError('For mange ændringer på kort tid. Prøv igen senere.', 429);
    }
    // Provider validates IDs against the employee’s own discovered calendars,
    // tests read permission and only then activates availability checking.
    await setCalendarSelection(c.env, staffId, calendarIds, fence);
    return c.json({ ok: true });
  });

  api.post(path + '/disconnect', async c => {
    const { staffId, fence } = await mutationContext(c, requireUser);
    await fields(c, []);
    // Disconnect is local and is intentionally still available when rollout or
    // Apple is down or the encryption key has been removed.
    await disconnectCalendar(c.env, staffId, fence);
    return c.json({ ok: true });
  });
}
