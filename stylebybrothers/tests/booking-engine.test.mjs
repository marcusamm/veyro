import { describe, it, expect } from 'vitest';
import {
  zonedToUtc, utcToZoned, tzOffsetMinutes, availableSlots, createBooking, moveBooking, cancelBooking,
  findBooking, availabilityByDate, weekday,
} from '../site/assets/booking-engine.js';
import { defaultState } from '../site/assets/data.js';

const customer = { name: 'Test Kunde', phone: '+45 12 34 56 78', email: 'test@example.com' };
// Mandag 2. november 2026 kl. 08:00 dansk tid (vintertid)
const MON = '2026-11-02';
const NOW = zonedToUtc(MON, 8 * 60);

describe('dansk tid og sommertid', () => {
  it('kender vinter- og sommertid', () => {
    expect(tzOffsetMinutes(Date.UTC(2026, 0, 15, 12))).toBe(60);
    expect(tzOffsetMinutes(Date.UTC(2026, 6, 15, 12))).toBe(120);
  });
  it('omregner lokal tid til UTC begge sider af skiftet (25. okt. 2026)', () => {
    expect(new Date(zonedToUtc('2026-10-24', 12 * 60)).toISOString()).toBe('2026-10-24T10:00:00.000Z');
    expect(new Date(zonedToUtc('2026-10-26', 12 * 60)).toISOString()).toBe('2026-10-26T11:00:00.000Z');
    expect(new Date(zonedToUtc('2026-03-30', 11 * 60 + 30)).toISOString()).toBe('2026-03-30T09:30:00.000Z');
    expect(utcToZoned(Date.UTC(2026, 9, 25, 1, 30))).toEqual({ date: '2026-10-25', minutes: 150 });
  });
  it('ugedage', () => {
    expect(weekday(MON)).toBe(1);
    expect(weekday('2026-11-08')).toBe(0);
  });
});

describe('ledige tider', () => {
  it('respekterer arbejdstid, pause og varighed', () => {
    const s = defaultState();
    const slots = availableSlots(s, { serviceId: 'herreklip', barberId: 'b1', date: MON, now: NOW });
    expect(slots[0].start).toBe(11 * 60 + 30);
    expect(slots.at(-1).end).toBe(17 * 60 + 30);
    // pause 14:00-14:30: ingen 30-min klip der overlapper
    expect(slots.some((x) => x.start > 13 * 60 + 30 && x.start < 14 * 60 + 30)).toBe(false);
    expect(slots.some((x) => x.start === 13 * 60 + 30)).toBe(true);
  });
  it('lange behandlinger får færre sene tider', () => {
    const s = defaultState();
    const slots = availableSlots(s, { serviceId: 'haar-skaeg', barberId: 'b1', date: MON, now: NOW });
    expect(slots.at(-1).start).toBe(16 * 60 + 30);
  });
  it('ingen tider på lukkedage, søndage, fravær eller barberens fridag', () => {
    const s = defaultState();
    expect(availableSlots(s, { serviceId: 'herreklip', date: '2026-11-08', now: NOW })).toEqual([]);
    s.settings.closedDates.push({ date: '2026-11-03', note: 'Lukket' });
    expect(availableSlots(s, { serviceId: 'herreklip', date: '2026-11-03', now: NOW })).toEqual([]);
    s.barbers[0].absences.push({ from: '2026-11-04', to: '2026-11-06' });
    expect(availableSlots(s, { serviceId: 'skin-fade', barberId: 'b1', date: '2026-11-05', now: NOW })).toEqual([]);
    expect(availableSlots(s, { serviceId: 'herreklip', barberId: 'b2', date: MON, now: NOW })).toEqual([]);
  });
  it('kun barberer der udfører behandlingen', () => {
    const s = defaultState();
    const slots = availableSlots(s, { serviceId: 'skin-fade', date: '2026-11-03', now: NOW });
    expect(new Set(slots.flatMap((x) => x.barberIds))).toEqual(new Set(['b1', 'b3']));
  });
  it('bookingvindue og varsel', () => {
    const s = defaultState();
    const at13 = zonedToUtc(MON, 13 * 60);
    const slots = availableSlots(s, { serviceId: 'herreklip', barberId: 'b1', date: MON, now: at13 });
    expect(slots[0].start).toBe(14 * 60 + 30); // 13:00 + 60 min varsel, og pause til 14:30
    expect(availableSlots(s, { serviceId: 'herreklip', date: '2026-12-15', now: NOW })).toEqual([]);
    expect(availableSlots(s, { serviceId: 'herreklip', date: '2026-11-01', now: NOW })).toEqual([]);
  });
  it('kalenderen tæller ledige tider pr. dag', () => {
    const s = defaultState();
    const map = availabilityByDate(s, { serviceId: 'herreklip', from: MON, days: 7, now: NOW });
    expect(map['2026-11-08']).toBe(0);
    expect(map[MON]).toBeGreaterThan(0);
  });
});

describe('bookinger', () => {
  it('forhindrer dobbeltbooking', () => {
    const s = defaultState();
    const a = createBooking(s, { serviceId: 'herreklip', barberId: 'b1', date: MON, start: 720, customer }, NOW);
    expect(a.ok).toBe(true);
    const b = createBooking(s, { serviceId: 'herreklip', barberId: 'b1', date: MON, start: 720, customer }, NOW);
    expect(b).toMatchObject({ ok: false, error: 'taken' });
    const c = createBooking(s, { serviceId: 'skin-fade', barberId: 'b1', date: MON, start: 705, customer }, NOW);
    expect(c.ok).toBe(false); // 11:45-12:30 overlapper 12:00
  });
  it('første ledige barber fordeler og fylder op', () => {
    const s = defaultState();
    const date = '2026-11-03'; // tirsdag: b1, b2, b3 arbejder
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const r = createBooking(s, { serviceId: 'herreklip', barberId: 'any', date, start: 720, customer }, NOW);
      expect(r.ok).toBe(true);
      ids.push(r.booking.barberId);
    }
    expect(new Set(ids).size).toBe(3);
    expect(createBooking(s, { serviceId: 'herreklip', barberId: 'any', date, start: 720, customer }, NOW).ok).toBe(false);
  });
  it('validerer kundeoplysninger', () => {
    const s = defaultState();
    const r = createBooking(s, { serviceId: 'herreklip', barberId: 'b1', date: MON, start: 720, customer: { name: '', phone: '12', email: 'x' } }, NOW);
    expect(Object.keys(r.errors)).toEqual(['name', 'phone', 'email']);
  });
  it('aflysning frigiver tiden, og flytning tjekker ledighed', () => {
    const s = defaultState();
    const { booking } = createBooking(s, { serviceId: 'herreklip', barberId: 'b1', date: MON, start: 720, customer }, NOW);
    expect(findBooking(s, booking.ref.toLowerCase(), '12345678')).toBe(booking);
    const other = createBooking(s, { serviceId: 'herreklip', barberId: 'b1', date: MON, start: 780, customer }, NOW).booking;
    expect(moveBooking(s, booking, { date: MON, start: 780 }, NOW).ok).toBe(false);
    expect(moveBooking(s, booking, { date: MON, start: 735 }, NOW).ok).toBe(true); // flyt 15 min ind i egen tid
    expect(booking.start).toBe(735);
    expect(cancelBooking(s, other, NOW).ok).toBe(true);
    expect(availableSlots(s, { serviceId: 'herreklip', barberId: 'b1', date: MON, now: NOW }).some((x) => x.start === 780)).toBe(true);
  });
  it('kunden kan ikke aflyse for tæt på', () => {
    const s = defaultState();
    const { booking } = createBooking(s, { serviceId: 'herreklip', barberId: 'b1', date: MON, start: 720, customer }, NOW);
    expect(cancelBooking(s, booking, zonedToUtc(MON, 11 * 60)).ok).toBe(false);
    expect(cancelBooking(s, booking, zonedToUtc(MON, 11 * 60), 'salon').ok).toBe(true);
  });
  it('gemmer starttid i UTC med sommertid', () => {
    const s = defaultState();
    s.settings.maxDaysAhead = 400;
    const r = createBooking(s, { serviceId: 'herreklip', barberId: 'b1', date: '2027-06-01', start: 720, customer }, NOW);
    expect(r.booking.startUtc).toBe('2027-06-01T10:00:00.000Z');
  });
});
