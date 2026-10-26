// Serverdelen af StyleByBrothers' booking. Kører i én Durable Object, så alle bookinger går gennem
// samme instans én ad gangen: to kunder kan ikke få samme tid, og bookingmotoren er den samme som i browseren.
// Ingen afhængigheder af Cloudflare her, så logikken kan testes med vitest (se tests/server.test.mjs).
import * as E from '../site/assets/booking-engine.js';
import { SALON, defaultState, PHOTOS } from '../site/assets/data.js';

const DAY_MS = 86400000;
const SESSION_DAYS = 30;
const LOGIN_MINUTES = 20;
const ARCHIVE_AFTER_DAYS = 60;
const LIMITS = { book: [20, 3600_000], find: [40, 3600_000], login: [5, 3600_000] };

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@,"<>]+@[^\s@,"<>]+\.[^\s@,"<>]{2,}$/;
const ID = /^[a-z0-9-]{1,40}$/i;

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
});

function hex(bytes) { return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(''); }
function randomHex(n) { return hex(crypto.getRandomValues(new Uint8Array(n))); }
function random() { return crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32; }
async function sha256(s) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))); }

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = (v, min, max) => { const n = Math.round(Number(v)); if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `Ugyldigt tal: ${v}`); return n; };

// ---------- validering af indstillinger fra admin ----------
function cleanHours(h) {
  const out = {};
  for (let d = 0; d < 7; d++) {
    const x = h?.[d];
    if (!x || !x.start) { out[d] = null; continue; }
    if (!HHMM.test(x.start) || !HHMM.test(x.end) || x.end <= x.start) throw new HttpError(400, 'Ugyldige arbejdstider');
    const hasBreak = x.breakStart && x.breakEnd;
    if (hasBreak && (!HHMM.test(x.breakStart) || !HHMM.test(x.breakEnd) || x.breakEnd <= x.breakStart)) throw new HttpError(400, 'Ugyldig pause');
    out[d] = { start: x.start, end: x.end, breakStart: hasBreak ? x.breakStart : '', breakEnd: hasBreak ? x.breakEnd : '' };
  }
  return out;
}

export function cleanConfig(c) {
  if (!c || typeof c !== 'object') throw new HttpError(400, 'Mangler data');
  const s = c.settings || {};
  const ext = str(s.externalBookingUrl, 300);
  if (ext && !/^https:\/\/[^\s"<>]+$/.test(ext)) throw new HttpError(400, 'Linket til bookingsystemet skal starte med https://');
  const settings = {
    slotStep: [5, 10, 15, 20, 30].includes(Number(s.slotStep)) ? Number(s.slotStep) : 15,
    minNoticeMinutes: int(s.minNoticeMinutes ?? 60, 0, 10080),
    maxDaysAhead: int(s.maxDaysAhead ?? 30, 1, 365),
    bufferMinutes: int(s.bufferMinutes ?? 0, 0, 120),
    cancelNoticeMinutes: int(s.cancelNoticeMinutes ?? 120, 0, 10080),
    closedDates: (Array.isArray(s.closedDates) ? s.closedDates : []).filter((x) => DATE.test(x?.date)).slice(0, 200).map((x) => ({ date: x.date, note: str(x.note, 60) || 'Lukket' })),
    chooseBarber: Boolean(s.chooseBarber),
    notifyEmails: (Array.isArray(s.notifyEmails) ? s.notifyEmails : []).map((e) => str(e, 120).toLowerCase()).filter((e) => EMAIL.test(e)).slice(0, 5),
    externalBookingUrl: ext,
  };
  const services = (Array.isArray(c.services) ? c.services : []).slice(0, 40).map((x) => {
    if (!ID.test(x?.id)) throw new HttpError(400, 'Ugyldigt id på behandling');
    return { id: x.id, name: str(x.name, 60) || 'Behandling', desc: str(x.desc, 120), duration: int(x.duration, 5, 480), price: int(x.price, 0, 100000), active: Boolean(x.active) };
  });
  const serviceIds = new Set(services.map((x) => x.id));
  const barbers = (Array.isArray(c.barbers) ? c.barbers : []).slice(0, 20).map((b) => {
    if (!ID.test(b?.id)) throw new HttpError(400, 'Ugyldigt id på frisør');
    return {
      id: b.id, name: str(b.name, 60) || 'Frisør', role: str(b.role, 60), active: Boolean(b.active),
      serviceIds: (Array.isArray(b.serviceIds) ? b.serviceIds : []).filter((id) => serviceIds.has(id)),
      hours: cleanHours(b.hours),
      absences: (Array.isArray(b.absences) ? b.absences : []).filter((a) => DATE.test(a?.from) && (!a.to || (DATE.test(a.to) && a.to >= a.from))).slice(0, 100)
        .map((a) => ({ from: a.from, to: a.to || a.from, note: str(a.note, 60) })),
    };
  });
  return { settings, services, barbers };
}

// ---------- tekster ----------
const fmtDay = (date) => {
  const [y, m, d] = date.split('-').map(Number);
  const s = new Intl.DateTimeFormat('da-DK', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const when = (b) => `${fmtDay(b.date)} kl. ${E.fmtTime(b.start)}`;
const kr = (n) => `${new Intl.NumberFormat('da-DK').format(n)} kr.`;

// ---------- kernen ----------
/**
 * storage: { get(key), put(key, value), delete(key), list(prefix) → Map }
 * env: { SITE_URL, ADMIN_EMAILS, RESEND_API_KEY, EMAIL_FROM, DEV_LOGIN }
 * send: async ({ to, subject, text, replyTo }) → { ok, id?, error? }
 */
export class SalonCore {
  constructor(storage, env, send, clock = () => Date.now()) {
    this.storage = storage;
    this.env = env;
    this.send = send;
    this.now = clock;
    this.hits = new Map();
    this.loaded = null;
  }

  site() { return (this.env.SITE_URL || 'https://sbb.veyro.dk').replace(/\/$/, ''); }
  admins() { return String(this.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean); }

  async load() {
    if (this.loaded) return this.loaded;
    let config = await this.storage.get('config');
    if (!config) {
      const d = defaultState();
      config = cleanConfig(d);
      await this.storage.put('config', config);
    }
    const bookings = (await this.storage.get('bookings')) || [];
    this.loaded = { config, bookings };
    return this.loaded;
  }

  /** Bookingmotorens state-form: indstillinger + bookinger. */
  async engineState() {
    const { config, bookings } = await this.load();
    return { ...config, bookings };
  }

  async saveBookings() { await this.storage.put('bookings', this.loaded.bookings); }

  limit(ip, kind) {
    const [max, windowMs] = LIMITS[kind];
    const key = `${kind}:${ip || '?'}`;
    const t = this.now();
    const list = (this.hits.get(key) || []).filter((x) => t - x < windowMs);
    if (list.length >= max) throw new HttpError(429, 'For mange forsøg. Prøv igen senere, eller ring til os.');
    list.push(t);
    this.hits.set(key, list);
    if (this.hits.size > 5000) this.hits.clear();
  }

  publicState(state) {
    const today = E.utcToZoned(this.now()).date;
    const { notifyEmails, ...settings } = state.settings;
    return {
      settings, services: state.services, barbers: state.barbers, photos: PHOTOS,
      // Kun det, kalenderen skal bruge for at vise optagede tider. Ingen kundedata.
      bookings: state.bookings.filter((b) => b.status === 'confirmed' && b.date >= today)
        .map((b) => ({ id: b.pid, barberId: b.barberId, date: b.date, start: b.start, end: b.end, status: b.status })),
    };
  }

  customerView(state, b) {
    const { id, cancelledBy, reminded, ...rest } = b;
    return { ...rest, canChange: E.canChange(state, b, this.now()) };
  }

  // ---------- e-mail ----------
  async mail(msg, kind) {
    let result;
    try { result = await this.send(msg); } catch (e) { result = { ok: false, error: String(e?.message || e) }; }
    const outbox = (await this.storage.get('outbox')) || [];
    outbox.unshift({ at: new Date(this.now()).toISOString(), kind, to: msg.to, subject: msg.subject, text: msg.text, ok: Boolean(result?.ok), error: result?.error || '' });
    await this.storage.put('outbox', outbox.slice(0, 150));
    return result;
  }

  salonRecipients(state) {
    return state.settings.notifyEmails?.length ? state.settings.notifyEmails : this.admins().slice(0, 1);
  }

  async notify(state, b, kind, by = 'kunde') {
    const site = this.site();
    const first = b.name.split(' ')[0];
    const manage = `${site}/#/min-booking?ref=${b.ref}`;
    const barber = state.barbers.find((x) => x.id === b.barberId);
    const details = `${b.serviceName}${state.settings.chooseBarber && barber ? ` hos ${barber.name}` : ''}\n${when(b)}\n${SALON.street}, ${SALON.city}\nPris: ${kr(b.price)} (betales i salonen)\nBookingnummer: ${b.ref}`;
    const customer = {
      oprettet: { subject: `Din tid hos StyleByBrothers: ${when(b)}`, text: `Hej ${first}\n\nTak for din booking.\n\n${details}\n\nKan du ikke komme, så flyt eller aflys her:\n${manage}\n\nEller ring på ${SALON.phone}.\n\nVenlig hilsen\nStyleByBrothers` },
      flyttet: { subject: `Din tid er flyttet: ${when(b)}`, text: `Hej ${first}\n\nDin tid er flyttet${by === 'salon' ? ' af salonen' : ''}.\n\n${details}\n\nSe eller ændr din tid:\n${manage}\n\nVenlig hilsen\nStyleByBrothers` },
      aflyst: { subject: `Din tid ${when(b)} er aflyst`, text: `Hej ${first}\n\nDin tid ${when(b)} (${b.serviceName}) er aflyst${by === 'salon' ? ' af salonen. Ring på ' + SALON.phone + ', så finder vi en ny tid' : ''}.\n\nBook en ny tid på ${site}\n\nVenlig hilsen\nStyleByBrothers` },
      paamindelse: { subject: `Påmindelse: StyleByBrothers i morgen kl. ${E.fmtTime(b.start)}`, text: `Hej ${first}\n\nHusk din tid i morgen.\n\n${details}\n\nKan du ikke komme, så flyt eller aflys her:\n${manage}\n\nVenlig hilsen\nStyleByBrothers` },
    }[kind];
    if (b.email) await this.mail({ to: b.email, ...customer }, `${kind} (kunde)`);
    if (kind === 'paamindelse' || by === 'salon') return;
    const label = { oprettet: 'Ny booking', flyttet: 'Booking flyttet', aflyst: 'Booking aflyst' }[kind];
    const text = `${label}\n\n${b.name}\nTlf. ${b.phone}\n${b.email}\n\n${details}${b.note ? `\n\nBesked: ${b.note}` : ''}\n\nSe dagens bookinger:\n${site}/#/admin`;
    for (const to of this.salonRecipients(state)) {
      await this.mail({ to, subject: `${label}: ${b.serviceName} ${when(b)}, ${b.name}`, text, replyTo: b.email }, `${kind} (salon)`);
    }
  }

  // ---------- admin-login ----------
  async session(req) {
    const m = /(?:^|;\s*)sbb_admin=([a-f0-9]{64})/.exec(req.headers.get('cookie') || '');
    if (!m) return null;
    const s = await this.storage.get(`sess:${await sha256(m[1])}`);
    if (!s || s.exp < this.now()) return null;
    if (!this.admins().includes(s.email)) return null;
    return s;
  }

  async requireAdmin(req) {
    const s = await this.session(req);
    if (!s) throw new HttpError(401, 'Log ind igen');
    return s;
  }

  // ---------- router ----------
  async handle(req) {
    try {
      return await this.route(req);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'Der skete en fejl. Prøv igen, eller ring til os.' }, 500);
    }
  }

  async body(req) {
    // Kræv JSON, så en almindelig formular på en anden side ikke kan sende på vegne af en indlogget admin.
    if (!(req.headers.get('content-type') || '').includes('application/json')) throw new HttpError(415, 'Forventede JSON');
    try { return await req.json(); } catch { throw new HttpError(400, 'Ugyldig JSON'); }
  }

  async route(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;
    const ip = req.headers.get('cf-connecting-ip') || '';

    if (p === '/internal/cron' && m === 'POST') return json(await this.cron());

    if (p === '/api/state' && m === 'GET') return json(this.publicState(await this.engineState()));

    if (p === '/api/bookings' && m === 'POST') {
      this.limit(ip, 'book');
      const input = await this.body(req);
      const state = await this.engineState();
      const date = String(input.date || '');
      if (!DATE.test(date)) throw new HttpError(400, 'Ugyldig dato');
      const c = input.customer || {};
      const customer = { name: str(c.name, 80), phone: str(c.phone, 30), email: str(c.email, 120), note: str(c.note, 500) };
      const barberId = state.settings.chooseBarber ? String(input.barberId || 'any') : 'any';
      const r = E.createBooking(state, { serviceId: String(input.serviceId || ''), barberId, date, start: Number(input.start), customer }, this.now(), random);
      if (!r.ok) return json({ error: r.error, errors: r.errors || {} }, r.error === 'invalid' ? 400 : 409);
      r.booking.pid = randomHex(6);
      this.loaded.bookings = state.bookings;
      await this.saveBookings();
      await this.notify(state, r.booking, 'oprettet');
      return json({ booking: this.customerView(state, r.booking), state: this.publicState(state) });
    }

    if (p === '/api/bookings/find' && m === 'POST') {
      this.limit(ip, 'find');
      const { ref, phone } = await this.body(req);
      const state = await this.engineState();
      const b = E.findBooking(state, ref, phone);
      if (!b) throw new HttpError(404, 'Vi kan ikke finde en booking med det nummer og telefonnummer. Tjek bekræftelsen, eller ring til os.');
      return json({ booking: this.customerView(state, b) });
    }

    if ((p === '/api/bookings/move' || p === '/api/bookings/cancel') && m === 'POST') {
      this.limit(ip, 'find');
      const input = await this.body(req);
      const state = await this.engineState();
      const b = E.findBooking(state, input.ref, input.phone);
      if (!b) throw new HttpError(404, 'Bookingen findes ikke');
      const move = p.endsWith('move');
      if (move && !DATE.test(String(input.date || ''))) throw new HttpError(400, 'Ugyldig dato');
      const r = move ? E.moveBooking(state, b, { date: input.date, start: Number(input.start) }, this.now()) : E.cancelBooking(state, b, this.now());
      if (!r.ok) return json({ error: r.error }, r.error === 'too_late' ? 403 : 409);
      if (move) b.reminded = false;
      await this.saveBookings();
      await this.notify(state, b, move ? 'flyttet' : 'aflyst');
      return json({ booking: this.customerView(state, b), state: this.publicState(state) });
    }

    // ---------- admin ----------
    if (p === '/api/admin/login' && m === 'POST') {
      this.limit(ip, 'login');
      const email = str((await this.body(req)).email, 120).toLowerCase();
      // Samme svar uanset om adressen er admin, så man ikke kan prøve sig frem.
      if (this.admins().includes(email)) {
        const token = randomHex(32);
        await this.storage.put(`login:${await sha256(token)}`, { email, exp: this.now() + LOGIN_MINUTES * 60000 });
        const link = `${this.site()}/#/admin/login?t=${token}`;
        await this.mail({ to: email, subject: 'Log ind på StyleByBrothers admin', text: `Hej\n\nKlik på linket for at logge ind. Det virker i ${LOGIN_MINUTES} minutter og kun én gang.\n\n${link}\n\nHar du ikke bedt om det, kan du se bort fra mailen.` }, 'login');
        if (this.env.DEV_LOGIN === '1') return json({ ok: true, devLink: link.slice(this.site().length) });
      }
      return json({ ok: true });
    }

    if (p === '/api/admin/verify' && m === 'POST') {
      this.limit(ip, 'login');
      const token = String((await this.body(req)).token || '');
      const key = `login:${await sha256(token)}`;
      const t = /^[a-f0-9]{64}$/.test(token) ? await this.storage.get(key) : null;
      if (!t || t.exp < this.now()) throw new HttpError(401, 'Linket er udløbet eller allerede brugt. Bed om et nyt.');
      await this.storage.delete(key);
      const sess = randomHex(32);
      await this.storage.put(`sess:${await sha256(sess)}`, { email: t.email, exp: this.now() + SESSION_DAYS * DAY_MS });
      return json({ ok: true, email: t.email }, 200, { 'set-cookie': `sbb_admin=${sess}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}` });
    }

    if (p === '/api/admin/logout' && m === 'POST') {
      const mm = /(?:^|;\s*)sbb_admin=([a-f0-9]{64})/.exec(req.headers.get('cookie') || '');
      if (mm) await this.storage.delete(`sess:${await sha256(mm[1])}`);
      return json({ ok: true }, 200, { 'set-cookie': 'sbb_admin=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
    }

    if (p.startsWith('/api/admin/')) {
      const who = await this.requireAdmin(req);
      const state = await this.engineState();

      if (p === '/api/admin/state' && m === 'GET') {
        return json({ email: who.email, admins: this.admins(), state: { ...state, settings: { ...state.settings, notifyEmails: state.settings.notifyEmails || [] } }, outbox: (await this.storage.get('outbox')) || [] });
      }

      if (p === '/api/admin/config' && m === 'PUT') {
        const config = cleanConfig(await this.body(req));
        this.loaded.config = config;
        await this.storage.put('config', config);
        return json({ ok: true, config });
      }

      if (p === '/api/admin/bookings' && m === 'POST') {
        // Salonen opretter en tid for en kunde, der har ringet eller kommer ind. E-mail er valgfri.
        const input = await this.body(req);
        if (!DATE.test(String(input.date || ''))) throw new HttpError(400, 'Ugyldig dato');
        const c = input.customer || {};
        const customer = { name: str(c.name, 80), phone: str(c.phone, 30), email: str(c.email, 120), note: str(c.note, 500) };
        // Salonen må gerne booke uden varsel, så længe tiden er ledig.
        const relaxed = { ...state, settings: { ...state.settings, minNoticeMinutes: 0 } };
        const r = E.createBooking(relaxed, { serviceId: String(input.serviceId || ''), barberId: String(input.barberId || 'any'), date: input.date, start: Number(input.start), customer }, this.now(), random, { requireEmail: false });
        if (!r.ok) return json({ error: r.error, errors: r.errors || {} }, r.error === 'invalid' ? 400 : 409);
        r.booking.pid = randomHex(6);
        r.booking.createdBy = 'salon';
        await this.saveBookings();
        if (r.booking.email) await this.notify(state, r.booking, 'oprettet', 'salon');
        return json({ ok: true, booking: r.booking });
      }

      if ((p === '/api/admin/bookings/move' || p === '/api/admin/bookings/cancel') && m === 'POST') {
        const input = await this.body(req);
        const b = state.bookings.find((x) => x.id === input.id);
        if (!b) throw new HttpError(404, 'Bookingen findes ikke');
        const move = p.endsWith('move');
        if (move && !DATE.test(String(input.date || ''))) throw new HttpError(400, 'Ugyldig dato');
        const r = move
          ? E.moveBooking(state, b, { date: input.date, start: Number(input.start), barberId: input.barberId || 'any' }, this.now(), 'salon')
          : E.cancelBooking(state, b, this.now(), 'salon');
        if (!r.ok) return json({ error: r.error }, 409);
        if (move) b.reminded = false;
        await this.saveBookings();
        if (input.notify !== false) await this.notify(state, b, move ? 'flyttet' : 'aflyst', 'salon');
        return json({ ok: true, booking: b });
      }
    }

    throw new HttpError(404, 'Ikke fundet');
  }

  /** Køres dagligt: påmindelser for i morgen og arkivering af gamle bookinger. */
  async cron() {
    const state = await this.engineState();
    const today = E.utcToZoned(this.now()).date;
    const tomorrow = E.addDays(today, 1);
    let reminders = 0;
    for (const b of state.bookings) {
      if (b.status === 'confirmed' && b.date === tomorrow && !b.reminded) {
        b.reminded = true;
        await this.saveBookings();
        await this.notify(state, b, 'paamindelse');
        reminders++;
      }
    }
    const cutoff = E.addDays(today, -ARCHIVE_AFTER_DAYS);
    const old = state.bookings.filter((b) => b.date < cutoff);
    if (old.length) {
      const byMonth = new Map();
      for (const b of old) byMonth.set(b.date.slice(0, 7), [...(byMonth.get(b.date.slice(0, 7)) || []), b]);
      for (const [month, list] of byMonth) {
        const key = `arkiv:${month}`;
        await this.storage.put(key, [...((await this.storage.get(key)) || []), ...list]);
      }
      this.loaded.bookings = state.bookings.filter((b) => b.date >= cutoff);
      await this.saveBookings();
    }
    // Persondata gemmes i 12 måneder efter tiden (se privatlivspolitikken), derefter slettes de.
    const deleteBefore = E.addDays(today, -365).slice(0, 7);
    for (const [key] of await this.storage.list('arkiv:')) if (key.slice(6) < deleteBefore) await this.storage.delete(key);
    const now = this.now();
    for (const prefix of ['sess:', 'login:']) {
      for (const [key, v] of await this.storage.list(prefix)) if (v.exp < now) await this.storage.delete(key);
    }
    return { reminders, archived: old.length };
  }
}

/** Sender e-mail via Resend. Uden nøgle logges beskeden kun i admin under Udsendelser. */
export function resendMailer(env) {
  return async ({ to, subject, text, replyTo }) => {
    if (!env.RESEND_API_KEY) return { ok: false, error: 'RESEND_API_KEY mangler' };
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM || 'StyleByBrothers <booking@veyro.dk>', to: [to], subject, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
    });
    if (!res.ok) return { ok: false, error: `Resend ${res.status}: ${(await res.text()).slice(0, 200)}` };
    return { ok: true, id: (await res.json()).id };
  };
}
