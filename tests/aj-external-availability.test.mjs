import { beforeEach, describe, expect, it, vi } from 'vitest';
import { copenhagenInstants, createBooking, getSlots, rescheduleBooking } from '../src/aj/store';
import { getStaffBusyWindows } from '../src/aj/external-busy';

vi.mock('../src/aj/external-busy', () => ({ getStaffBusyWindows: vi.fn() }));

const date = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
const weekday = new Date(date + 'T12:00:00Z').getUTCDay() || 7;
const t = minute => copenhagenInstants(date, minute)[0];
const stamp = sec => new Date(sec * 1000).toISOString();
const people = [1, 2].map(id => ({ id, name: 'Staff ' + id, role: 'staff', active: 1 }));

function envWithOpenHours() {
  const rows = sql => {
    if (sql.includes('FROM aj_hours')) return people.map(p => ({ staff_id: p.id, weekday, start_minute: 540, end_minute: 660 }));
    if (sql.includes('FROM aj_services')) return [{ id: 1, duration_minutes: 30, active: 1 }];
    if (sql.includes('FROM aj_staff')) return people;
    if (sql.includes('FROM aj_bookings') || sql.includes('FROM aj_blocks')) return [];
    throw new Error('Unexpected query: ' + sql);
  };
  const DB = {
    prepare(sql) {
      return {
        bind() { return this; },
        async all() { return { results: rows(sql) }; },
        async first() {
          if (sql.includes('FROM aj_settings')) return { booking_enabled: 1, workshop_email: 'workshop@example.test', campaign_json: '{}' };
          throw new Error('Unexpected query: ' + sql);
        },
      };
    },
    batch: vi.fn(),
  };
  return { DB, RESEND_API_KEY: 'test' };
}

describe('AJ booking with a staff member’s external calendar', () => {
  beforeEach(() => getStaffBusyWindows.mockReset());

  it('removes overlaps for the full service duration but allows adjacent times and other staff', async () => {
    const env = envWithOpenHours();
    getStaffBusyWindows.mockImplementation(async (_env, id) => id === 1 ? [{ start: t(570), end: t(600) }] : []);
    const slots = await getSlots(env, 1, date);
    const starts = id => slots.filter(s => s.staffId === id).map(s => s.startAt);
    expect(starts(1)).toEqual([540, 600, 615, 630].map(m => stamp(t(m))));
    expect(starts(2)).toHaveLength(7);
    expect(getStaffBusyWindows).toHaveBeenCalledWith(env, 1, t(540), t(660));
  });

  it('withholds slots for a connected calendar that could not be checked', async () => {
    getStaffBusyWindows.mockImplementation(async (_env, id) => id === 1 ? null : []);
    const slots = await getSlots(envWithOpenHours(), 1, date);
    expect(slots).toHaveLength(7);
    expect(slots.every(s => s.staffId === 2)).toBe(true);
  });

  it.each(['create', 'reschedule'])('checks fresh availability before %s and leaves the database unchanged', async action => {
    const env = envWithOpenHours();
    getStaffBusyWindows.mockResolvedValueOnce([]);
    const [selected] = await getSlots(env, 1, date, 1);
    getStaffBusyWindows.mockResolvedValue([{ start: t(540), end: t(570) }]);
    const result = action === 'create'
      ? createBooking(env, { serviceId: 1, ...selected }, 'https://aj.example.test')
      : rescheduleBooking(env, { id: 'existing', service_id: 1, status: 'confirmed', start_at: t(645) }, selected.startAt, 1, 'https://aj.example.test');
    await expect(result).rejects.toMatchObject({ status: 409 });
    expect(getStaffBusyWindows).toHaveBeenCalledTimes(2);
    expect(env.DB.batch).not.toHaveBeenCalled();
  });
});
