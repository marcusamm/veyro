// HTTP routes, credentials, calendar parser, slot filtering, booking transaction and mail outbox
// run together against the real schema. Only outbound Apple and Resend traffic is simulated.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import app from '../src/aj/app.ts';
import { copenhagenInstants } from '../src/aj/store.ts';

function localD1(sqlite) {
  const prepare = (sql, args = []) => ({
    bind: (...values) => prepare(sql, values),
    first: () => sqlite.prepare(sql).get(...args) ?? null,
    all: () => ({results: sqlite.prepare(sql).all(...args)}),
    run: () => ({meta: {changes: sqlite.prepare(sql).run(...args).changes}}),
  });
  return { prepare, batch(statements) {
    sqlite.exec('BEGIN');
    try {const results = statements.map(s => s.run()); sqlite.exec('COMMIT'); return results;}
    catch (e) {sqlite.exec('ROLLBACK'); throw e;}
  }};
}

const origin = 'https://aj.example.test';
const collection = '/workshop/calendars/private/';
const file = collection + 'series.ics';
const resourceType = '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>';
const row = (path, props) => '<d:response><d:href>'+path+'</d:href><d:propstat><d:prop>'+props+'</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';
const dav = (...rows) => new Response('<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'+rows.join('')+'</d:multistatus>', {status:207,headers:{'Content-Type':'application/xml'}});
const inDays = n => new Date(Date.now()+n*86400000).toISOString().slice(0,10);

function provider(remote, startDate, date) {
  const local = (day, hm) => day.replaceAll('-', '')+'T'+hm+'00';
  const event = (a,b,fields) => ['BEGIN:VEVENT','UID:weekly-private-1','DTSTAMP:20200101T090000Z',...fields,'DTSTART;TZID=Europe/Copenhagen:'+a,'DTEND;TZID=Europe/Copenhagen:'+b,'END:VEVENT'];
  const ics = () => ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Test//Private Calendar//EN',
    ...event(local(startDate,'1300'),local(startDate,'1400'),[
      'RRULE:FREQ=WEEKLY;COUNT=4',
      ...(remote.mode === 'occurrence-deleted' ? ['EXDATE;TZID=Europe/Copenhagen:' + local(date, '1300')] : []),
    ]),
    ...(remote.mode==='moved' ? event(local(date,'1500'),local(date,'1600'),['RECURRENCE-ID;TZID=Europe/Copenhagen:'+local(date,'1300')]) : []),
    'END:VCALENDAR'].join('\r\n');
  return async (url, opts) => {
    const {hostname,pathname}=new URL(url);
    if(hostname==='mail.example.test' && pathname==='/emails' && opts.method==='POST') {remote.mail++;return Response.json({id:'simulated'});}
    if(hostname!=='caldav.icloud.com') throw Error('Unexpected external request: '+hostname);
    const body=opts.body, method=opts.method;
    expect(new Headers(opts.headers).get('Authorization')).toBe('Basic '+btoa('user@example.test:test-test-test-test'));
    if(method==='PROPFIND' && pathname==='/' && body.includes('current-user-principal'))return dav(row('/', '<d:current-user-principal><d:href>/workshop/</d:href></d:current-user-principal>'));
    if(method==='PROPFIND' && pathname==='/workshop/' && body.includes('calendar-home-set'))return dav(row('/workshop/', '<c:calendar-home-set><d:href>/workshop/calendars/</d:href></c:calendar-home-set>'));
    if(method==='PROPFIND' && pathname==='/workshop/calendars/')return dav(row(collection, resourceType+'<d:displayname>My private calendar</d:displayname><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>'));
    if(pathname!==collection)throw Error('Unexpected calendar path: '+pathname);
    if(method==='REPORT' && body.includes('free-busy-query'))return new Response(null,{status:400}); // Observed iCloud fallback path.
    if(method==='PROPFIND' && body.includes('current-user-privilege-set'))return dav(row(collection,'<d:current-user-privilege-set><d:privilege><d:read/></d:privilege></d:current-user-privilege-set><c:calendar-timezone-id>Europe/Copenhagen</c:calendar-timezone-id>'));
    const etag='<d:getetag>"'+remote.mode+'"</d:getetag>';
    if(method==='PROPFIND' && body.includes('getetag'))return dav(row(collection,resourceType), ...(remote.mode==='empty' ? [] : [row(file, '<d:resourcetype/>'+etag)]));
    if(method==='REPORT' && body.includes('calendar-multiget') && body.includes(file) && remote.mode!=='empty') {
      expect(body).not.toMatch(/name="(?:SUMMARY|DESCRIPTION|LOCATION|ATTENDEE)"/);
      remote.multigets++;return dav(row(file,etag+'<c:calendar-data><![CDATA['+ics()+']]></c:calendar-data>'));
    }
    throw Error('Unimplemented simulated DAV response: '+method+' '+pathname);
  };
}

it('rejects stale bookings, follows a single weekly occurrence through a move and deletion, and keeps colleagues bookable', async () => {
  const sqlite=new DatabaseSync(':memory:'), dir=new URL('../migrations/',import.meta.url);
  try {
    sqlite.exec('PRAGMA foreign_keys=ON');
    for(const f of readdirSync(dir).filter(x=>x.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(f,dir),'utf8'));
    const db=localD1(sqlite), cookie=randomBytes(32).toString('base64url'), date=inDays(10), startDate=inDays(3);
    const staff=sqlite.prepare("INSERT INTO aj_staff(name,email,role,active) VALUES('Test staff','staff@example.test','staff',1) RETURNING id").get().id;
    const colleague=sqlite.prepare("INSERT INTO aj_staff(name,email,role,active) VALUES('Colleague','colleague@example.test','staff',1) RETURNING id").get().id;
    const weekday=new Date(date+'T12:00Z').getUTCDay()||7;
    for (const employee of [staff, colleague]) {
      sqlite.prepare('INSERT INTO aj_hours(staff_id,weekday,start_minute,end_minute) VALUES(?,?,720,960)').run(employee,weekday);
    }
    sqlite.exec("UPDATE aj_settings SET booking_enabled=1,workshop_email='workshop@example.test'; UPDATE aj_services SET duration_minutes=45,active=1 WHERE id=1;");
    sqlite.prepare("INSERT INTO aj_sessions(token_hash,email,expires_at) VALUES(?,'staff@example.test',unixepoch()+3600)").run(createHash('sha256').update(cookie).digest('hex'));
    const env={DB:db,AJ_ICLOUD_ENABLED:'1',AJ_CALENDAR_TOKEN_KEY:randomBytes(32).toString('base64'),RESEND_API_KEY:'fake-resend',RESEND_API_BASE:'https://mail.example.test'};
    const remote={mode:'empty',mail:0,multigets:0};
    vi.stubGlobal('fetch',provider(remote,startDate,date));
    const req=(path,body,login=false)=>app.request(origin+'/api'+path,{
      method:body?'POST':'GET',headers:{Origin:origin,'Content-Type':'application/json',...(login?{Cookie:'__Host-aj_session='+cookie}:{})},...(body?{body:JSON.stringify(body)}:{})
    },env);
    const slots = async (staffId = staff, day = date) => {
      const response = await req('/slots?serviceId=1&staffId=' + staffId + '&date=' + day);
      expect(response.status).toBe(200);
      return (await response.json()).slots.map(slot => slot.startAt);
    };
    const book = (startAt, staffId = staff) => req('/bookings', {staffId,serviceId:1,startAt,name:'Test customer',email:'book@example.test',phone:'12345678'});
    const iso = (minute, day = date) => new Date(copenhagenInstants(day, minute)[0] * 1000).toISOString();
    const twelveThirty = iso(750), fourteenThirty = iso(870);
    expect((await req('/admin/icloud/connect',{email:'user@example.test',appPassword:'test-test-test-test'},true)).status).toBe(200);
    const {calendars}=await (await req('/admin/icloud/calendars',undefined,true)).json();
    expect((await req('/admin/icloud/select',{calendarIds:[calendars[0].id]},true)).status).toBe(200);
    const initiallyOffered = await slots();
    expect(initiallyOffered).toEqual(expect.arrayContaining([twelveThirty, fourteenThirty]));

    remote.mode = 'weekly';
    expect((await book(twelveThirty)).status).toBe(409);
    const withSeries = await slots();
    expect(withSeries).not.toContain(twelveThirty);
    expect(withSeries).toContain(fourteenThirty);
    expect(remote.mail).toBe(0);
    expect(sqlite.prepare('SELECT count(*) AS n FROM aj_bookings').get().n).toBe(0);
    expect(await slots(colleague)).toContain(twelveThirty);
    expect((await book(twelveThirty, colleague)).status).toBe(201);

    remote.mode = 'moved';
    expect((await book(fourteenThirty)).status).toBe(409);
    const afterMove = await slots();
    expect(afterMove).toContain(twelveThirty);
    expect(afterMove).not.toContain(fourteenThirty);

    remote.mode = 'occurrence-deleted';
    expect(await slots()).toEqual(expect.arrayContaining([twelveThirty, fourteenThirty]));
    const nextWeek = inDays(17);
    const nextWeekSlots = await slots(staff, nextWeek);
    expect(nextWeekSlots).not.toContain(iso(750, nextWeek));
    expect(nextWeekSlots).toContain(iso(870, nextWeek));
    const confirmed = await book(fourteenThirty);
    expect(confirmed.status).toBe(201);
    expect((await confirmed.json()).booking.startAt).toBe(fourteenThirty);
    expect(sqlite.prepare("SELECT count(*) AS n FROM aj_bookings WHERE status='confirmed'").get().n).toBe(2);
    expect(remote.mail).toBe(4);
    expect(remote.multigets).toBeGreaterThan(0);
    expect(await slots()).not.toContain(fourteenThirty);
  } finally {vi.unstubAllGlobals();sqlite.close();}
});
