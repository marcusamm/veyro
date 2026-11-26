import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

const hash = value => createHash('sha256').update(value).digest('hex');
const colleague = 'testkollega@example.invalid';

/** Verify the public HTTPS host and actual login. No bearer values are written to logs. */
export async function smokeTest(origin, query) {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hash(token);
  let cookie = '', sessionHash, feedHash, previousFeed;
  async function request(path, method = 'GET', body) {
    const response = await fetch(new URL(path, origin), { method, redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Pilot smoke ${method} ${new URL(path, origin).pathname} returned HTTP ${response.status}.`);
    return response;
  }
  try {
    for (let attempt = 0; ; attempt++) {
      try { await request('/', 'HEAD'); break; }
      catch (error) { if (attempt >= 14) throw error; await setTimeout(4000); }
    }
    const [{ results: [staff] }] = await query('SELECT id,calendar_token_hash FROM aj_staff WHERE email=?', [colleague]);
    assert.ok(staff, 'Synthetic colleague exists');
    previousFeed = staff.calendar_token_hash;
    await query('INSERT INTO aj_login_tokens(token_hash,email,expires_at) VALUES(?,?,unixepoch()+180)', [tokenHash, colleague]);
    const confirmed = await request('/api/admin/verify', 'POST', { token });
    const session = /^__Host-aj_session=([a-zA-Z\d_-]{43});/.exec(confirmed.headers.get('Set-Cookie') ?? '');
    assert.ok(session, 'Test login issues a host-only session');
    cookie = `__Host-aj_session=${session[1]}`;
    sessionHash = hash(session[1]);
    assert.equal((await (await request('/api/admin/icloud')).json()).configured, true, 'iCloud configured on HTTPS');
    const config = await (await request('/api/config')).json();
    assert.equal(config.bookingReady, true);
    assert.equal(config.staff.length, 2);
    const day = new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10);
    const params = new URLSearchParams({ serviceId: config.services.find(s => s.active && s.durationMinutes === 45).id, date: day, staffId: staff.id });
    const times = await (await request('/api/slots?' + params)).json();
    assert.ok(times.slots.some(s => s.staffId === staff.id), 'Colleague has an open slot');
    const other = config.staff.find(s => s.id !== staff.id);
    const [{ results: connections }] = await query('SELECT 1 FROM aj_icloud_connections WHERE staff_id=?', [other.id]);
    if (!connections.length) {
      params.set('staffId', other.id);
      const second = await (await request('/api/slots?' + params)).json();
      assert.ok(second.slots.some(s => s.staffId === other.id), 'Second calendar has an open slot');
    }
    const calendar = await (await request('/api/admin/calendar', 'POST', { staffId: staff.id })).json();
    const feed = new URL(calendar.url);
    assert.equal(feed.origin, origin);
    const feedToken = feed.searchParams.get('token');
    assert.ok(/^[a-zA-Z\d_-]{43}$/.test(feedToken ?? ''), 'Test subscription contains a token');
    feedHash = hash(feedToken);
    cookie = ''; // Apple and Google fetch each subscription without an admin session.
    await request(feed.pathname + feed.search, 'HEAD');
    assert.match(await (await request(feed.pathname + feed.search)).text(), /BEGIN:VCALENDAR/);
    console.log('Pilot HTTPS, personal subscription, staff login and test calendars verified.');
  } finally {
    await query('DELETE FROM aj_login_tokens WHERE token_hash=? AND email=?', [tokenHash, colleague]);
    if (sessionHash) await query('DELETE FROM aj_sessions WHERE token_hash=? AND email=?', [sessionHash, colleague]);
    if (feedHash) await query('UPDATE aj_staff SET calendar_token_hash=? WHERE email=? AND calendar_token_hash=?', [previousFeed, colleague, feedHash]);
  }
}
