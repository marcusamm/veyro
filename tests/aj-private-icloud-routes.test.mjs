import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { AjError } from '../src/aj/types';
import { registerICloudRoutes } from '../src/aj/icloud-routes';
import * as calendars from '../src/aj/external-busy';
import { rateLimit } from '../src/lib/db';

vi.mock('../src/aj/external-busy', () => ({
  calendarConfigured: vi.fn(), calendarConnection: vi.fn(), connectPrivateCalendar: vi.fn(),
  disconnectCalendar: vi.fn(), listPrivateCalendars: vi.fn(), setCalendarSelection: vi.fn(),
}));
vi.mock('../src/lib/db', async original => ({ ...await original(), rateLimit: vi.fn() }));

const owner = { email: 'owner@example.test', role: 'owner', staffId: 7 };
const app = new Hono();
const lookup = vi.fn();
app.onError((e, c) => c.json({error: e instanceof AjError ? e.message : 'Fejl'}, e instanceof AjError ? e.status : 500));
registerICloudRoutes(app, lookup);
const origin = 'https://workshop.example';
const data = { email: 'apple@example.test', appPassword: 'test-test-test-test' };
function req(path, payload, headers = {}, url = origin) {
  return app.request(url + '/admin/icloud' + path, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { Cookie: '__Host-aj_session=' + 'A'.repeat(43), 'Content-Type': 'application/json', Origin: url, ...headers },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  }, { DB: {} });
}
beforeEach(() => {
  vi.resetAllMocks();
  lookup.mockResolvedValue(owner);
  calendars.calendarConfigured.mockReturnValue(true);
  rateLimit.mockResolvedValue(true);
});

describe('private iCloud management routes', () => {
  it('uses the logged-in staff ID, not an owner-supplied colleague ID; only an app-specific key format is accepted', async () => {
    expect((await req('/connect', { ...data, staffId: 8 })).status).toBe(400);
    expect((await req('/connect', { ...data, appPassword: 'OrdinaryApplePassword!' })).status).toBe(400);
    expect(calendars.connectPrivateCalendar).not.toHaveBeenCalled();
    const response = await req('/connect', data);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(calendars.connectPrivateCalendar).toHaveBeenCalledWith(
      expect.anything(), 7, { email: data.email, password: data.appPassword },
      { email: owner.email, sessionHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });
  it('rejects delegated operators, HTTP, missing session cookies and cross-origin credential submissions', async () => {
    lookup.mockResolvedValueOnce({ role: 'operator', staffId: null, email: 'ops@example.test' });
    expect((await req('/connect', data)).status).toBe(403);
    expect((await req('/connect', data, {}, 'http://workshop.example')).status).toBe(503);
    expect((await req('/connect', data, { Cookie: '' })).status).toBe(401);
    expect((await req('/connect', data, { Origin: 'https://other.example' })).status).toBe(403);
    expect(calendars.connectPrivateCalendar).not.toHaveBeenCalled();
  });
  it('does not contact Apple when disabled or rate limited, but still lets the employee remove credentials', async () => {
    calendars.calendarConfigured.mockReturnValue(false);
    expect((await req('/connect', data)).status).toBe(503);
    expect((await req('/disconnect', {})).status).toBe(200);
    expect(calendars.disconnectCalendar.mock.calls[0][1]).toBe(owner.staffId);
    calendars.calendarConfigured.mockReturnValue(true);
    rateLimit.mockResolvedValue(false);
    expect((await req('/connect', data)).status).toBe(429);
    expect(calendars.connectPrivateCalendar).not.toHaveBeenCalled();
  });
  it('only emits permitted metadata and rejects confusing empty/duplicate selections', async () => {
    calendars.calendarConnection.mockResolvedValue({ state: 'connected', selectedIds: ['b'] });
    calendars.listPrivateCalendars.mockResolvedValue([{ id: 'a', name: 'Kalender A', url: 'internal' }, { id: 'b', name: 'Kalender B' }]);
    expect(await (await req('/calendars')).json()).toEqual({ calendars: [
      { id: 'a', name: 'Kalender A', selected: false }, { id: 'b', name: 'Kalender B', selected: true }] });
    for (const payload of [{calendarIds:[]},{calendarIds:['b','b']},{calendarIds:['b'],staffId:999}])
      expect((await req('/select', payload)).status).toBe(400);
    expect(calendars.setCalendarSelection).not.toHaveBeenCalled();
    expect((await req('/select', {calendarIds:['b']})).status).toBe(200);
    expect(calendars.setCalendarSelection.mock.calls[0][1]).toBe(owner.staffId);
  });
});
