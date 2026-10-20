// Bookingmotor for StyleByBrothers.
// Rene funktioner uden DOM, så de kan køre i browseren (demoen) og på en server (drift) og testes med vitest.
// Alle tider er salonens lokale tid i Europe/Copenhagen: en dato 'YYYY-MM-DD' og minutter efter midnat.
// Omregning til UTC sker kun ved bookingvinduet og ved lagring, så sommertid håndteres ét sted.

export const TZ = 'Europe/Copenhagen';
const DAY_MS = 86400000;

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function zonedParts(utcMs) {
  const p = {};
  for (const { type, value } of partsFormatter.formatToParts(new Date(utcMs))) p[type] = value;
  return p;
}

/** Forskellen i minutter mellem dansk tid og UTC på et givet tidspunkt (60 om vinteren, 120 om sommeren). */
export function tzOffsetMinutes(utcMs) {
  const p = zonedParts(utcMs);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
}

/** Lokal dato + minutter efter midnat i dansk tid → UTC-millisekunder. */
export function zonedToUtc(date, minutes) {
  const [y, m, d] = date.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, 0, minutes);
  let utc = wall - tzOffsetMinutes(wall) * 60000;
  const second = tzOffsetMinutes(utc);
  if (wall - second * 60000 !== utc) utc = wall - second * 60000;
  return utc;
}

/** UTC-millisekunder → { date: 'YYYY-MM-DD', minutes } i dansk tid. */
export function utcToZoned(utcMs) {
  const p = zonedParts(utcMs);
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: +p.hour * 60 + +p.minute };
}

export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10);
}

/** 0 = søndag … 6 = lørdag for en lokal dato. */
export function weekday(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function daysBetween(a, b) {
  const t = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((t(b) - t(a)) / DAY_MS);
}

export function fmtTime(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function parseTime(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
}

// --- intervaller ------------------------------------------------------------

function subtract(intervals, block) {
  const out = [];
  for (const [s, e] of intervals) {
    if (block[1] <= s || block[0] >= e) { out.push([s, e]); continue; }
    if (block[0] > s) out.push([s, block[0]]);
    if (block[1] < e) out.push([block[1], e]);
  }
  return out;
}

export function isClosedDate(settings, date) {
  return (settings.closedDates || []).some((c) => c.date === date);
}

export function isAbsent(barber, date) {
  return (barber.absences || []).some((a) => a.from <= date && date <= (a.to || a.from));
}

/** Barberens ledige intervaller en given dag (arbejdstid minus pause, fravær, lukkedage og bookinger). */
export function freeIntervals(state, barber, date, ignoreBookingId) {
  if (!barber.active || isClosedDate(state.settings, date) || isAbsent(barber, date)) return [];
  const day = barber.hours?.[weekday(date)];
  if (!day || !day.start || !day.end) return [];
  let free = [[parseTime(day.start), parseTime(day.end)]];
  if (day.breakStart && day.breakEnd) free = subtract(free, [parseTime(day.breakStart), parseTime(day.breakEnd)]);
  const buffer = state.settings.bufferMinutes || 0;
  for (const b of state.bookings) {
    if (b.status !== 'confirmed' || b.barberId !== barber.id || b.date !== date || b.id === ignoreBookingId) continue;
    free = subtract(free, [b.start, b.end + buffer]);
  }
  return free.filter(([s, e]) => e > s);
}

export function barbersFor(state, serviceId, barberId) {
  return state.barbers.filter((b) => b.active && b.serviceIds.includes(serviceId) && (!barberId || barberId === 'any' || b.id === barberId));
}

/** Er datoen inden for bookingvinduet (fra i dag til maxDaysAhead frem)? */
export function inWindow(settings, date, now) {
  const today = utcToZoned(now).date;
  const diff = daysBetween(today, date);
  return diff >= 0 && diff <= settings.maxDaysAhead;
}

/**
 * Ledige starttider en dag for en behandling.
 * barberId: en bestemt barber eller 'any' (første ledige). Returnerer [{ start, end, barberIds }].
 */
export function availableSlots(state, { serviceId, barberId = 'any', date, now, ignoreBookingId }) {
  const service = state.services.find((s) => s.id === serviceId && s.active);
  if (!service || !inWindow(state.settings, date, now)) return [];
  const step = state.settings.slotStep || 15;
  const earliest = now + (state.settings.minNoticeMinutes || 0) * 60000;
  const slots = new Map();
  for (const barber of barbersFor(state, serviceId, barberId)) {
    for (const [s, e] of freeIntervals(state, barber, date, ignoreBookingId)) {
      // Starttider følger et fast gitter (fx hvert kvarter) fra midnat, så tiderne ser pæne ud.
      for (let t = Math.ceil(s / step) * step; t + service.duration <= e; t += step) {
        if (zonedToUtc(date, t) < earliest) continue;
        if (!slots.has(t)) slots.set(t, []);
        slots.get(t).push(barber.id);
      }
    }
  }
  return [...slots.entries()].sort((a, b) => a[0] - b[0]).map(([start, barberIds]) => ({ start, end: start + service.duration, barberIds }));
}

/** Antal ledige tider pr. dato fra og med `from` og `days` dage frem (bruges til kalenderen). */
export function availabilityByDate(state, { serviceId, barberId = 'any', from, days, now }) {
  const out = {};
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i);
    out[date] = availableSlots(state, { serviceId, barberId, date, now }).length;
  }
  return out;
}

function pickBarber(state, ids, date) {
  // "Første ledige": den barber med færrest bookinger den dag, så arbejdet fordeles.
  const load = (id) => state.bookings.filter((b) => b.status === 'confirmed' && b.barberId === id && b.date === date).length;
  return [...ids].sort((a, b) => load(a) - load(b) || state.barbers.findIndex((x) => x.id === a) - state.barbers.findIndex((x) => x.id === b))[0];
}

const REF_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function makeRef(random = Math.random) {
  let r = '';
  for (let i = 0; i < 6; i++) r += REF_CHARS[Math.floor(random() * REF_CHARS.length)];
  return r;
}

export function normalizePhone(p) {
  const digits = String(p || '').replace(/[^\d+]/g, '');
  return digits.startsWith('+45') ? digits.slice(3) : digits.startsWith('0045') ? digits.slice(4) : digits;
}

export function validateCustomer({ name, phone, email }) {
  const errors = {};
  if (!name || name.trim().length < 2) errors.name = 'Skriv dit navn.';
  const p = normalizePhone(phone);
  if (!/^\+?\d{8,15}$/.test(p)) errors.phone = 'Skriv et gyldigt telefonnummer (8 cifre).';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) errors.email = 'Skriv en gyldig e-mail.';
  return errors;
}

/**
 * Opretter en booking efter at have tjekket ledigheden igen, så to kunder ikke kan få samme tid.
 * Returnerer { ok: true, booking } eller { ok: false, error }. Ændrer state.bookings.
 */
export function createBooking(state, input, now, random = Math.random) {
  const { serviceId, barberId = 'any', date, start, customer } = input;
  const errors = validateCustomer(customer || {});
  if (Object.keys(errors).length) return { ok: false, error: 'invalid', errors };
  const slot = availableSlots(state, { serviceId, barberId, date, now }).find((s) => s.start === start);
  if (!slot) return { ok: false, error: 'taken' };
  const service = state.services.find((s) => s.id === serviceId);
  const chosen = barberId === 'any' ? pickBarber(state, slot.barberIds, date) : barberId;
  let ref;
  do { ref = makeRef(random); } while (state.bookings.some((b) => b.ref === ref));
  const booking = {
    id: `bk_${now.toString(36)}_${ref}`,
    ref,
    serviceId,
    serviceName: service.name,
    price: service.price,
    barberId: chosen,
    anyBarber: barberId === 'any',
    date,
    start,
    end: start + service.duration,
    startUtc: new Date(zonedToUtc(date, start)).toISOString(),
    name: customer.name.trim(),
    phone: normalizePhone(customer.phone),
    email: customer.email.trim().toLowerCase(),
    note: (customer.note || '').trim().slice(0, 500),
    status: 'confirmed',
    createdAt: new Date(now).toISOString(),
  };
  state.bookings.push(booking);
  return { ok: true, booking };
}

/** Finder en booking ud fra bookingnummer og telefonnummer (kunden har ingen konto). */
export function findBooking(state, ref, phone) {
  const r = String(ref || '').trim().toUpperCase();
  return state.bookings.find((b) => b.ref === r && b.phone === normalizePhone(phone)) || null;
}

/** Kan kunden selv aflyse eller flytte? Kun bekræftede bookinger, og senest cancelNoticeMinutes før. */
export function canChange(state, booking, now) {
  if (!booking || booking.status !== 'confirmed') return false;
  return zonedToUtc(booking.date, booking.start) - now >= (state.settings.cancelNoticeMinutes || 0) * 60000;
}

export function cancelBooking(state, booking, now, by = 'kunde') {
  if (by === 'kunde' && !canChange(state, booking, now)) return { ok: false, error: 'too_late' };
  booking.status = 'cancelled';
  booking.cancelledAt = new Date(now).toISOString();
  booking.cancelledBy = by;
  return { ok: true, booking };
}

/** Flytter en booking til en ny tid (evt. ny barber). Den gamle tid tæller ikke med i tjekket. */
export function moveBooking(state, booking, { date, start, barberId }, now, by = 'kunde') {
  if (by === 'kunde' && !canChange(state, booking, now)) return { ok: false, error: 'too_late' };
  const wanted = barberId || (booking.anyBarber ? 'any' : booking.barberId);
  const slot = availableSlots(state, { serviceId: booking.serviceId, barberId: wanted, date, now, ignoreBookingId: booking.id })
    .find((s) => s.start === start);
  if (!slot) return { ok: false, error: 'taken' };
  const chosen = slot.barberIds.includes(booking.barberId) ? booking.barberId : pickBarber(state, slot.barberIds, date);
  const duration = booking.end - booking.start;
  Object.assign(booking, {
    date, start, end: start + duration, barberId: chosen,
    startUtc: new Date(zonedToUtc(date, start)).toISOString(),
    movedAt: new Date(now).toISOString(),
  });
  return { ok: true, booking };
}
