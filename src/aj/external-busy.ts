import type { Env } from '../env';
import { nowSec, randomToken, sha256Hex } from '../lib/crypto';
import { AjError } from './types';
import { discoverAppleCalendars, readAppleBusy } from './apple-caldav';

export type CalendarFence = { sessionHash: string; email: string };
type Login = { email: string; password: string };
type AppleLogin = { username: string; appSpecificPassword: string };
type Choice = { id: string; url: string };
type Payload = { auth: AppleLogin; calendars: Choice[] };
type State = 'pending' | 'connected' | 'reconnect';
type Row = { staff_id: number; link_id: string; sealed: string; state: State; enforced:number; revision: number };
type Window = { start: number; end: number };
const MAX_CALENDARS = 8, enc = new TextEncoder();
const unavailable = () => new AjError('iCloud-kalenderen kan ikke kontrolleres lige nu.', 503);
const changed = () => new AjError('Forbindelsen eller din session er ændret. Genindlæs siden.', 409);

// Credentials stay server-side; never derive the key from a different application secret.
function keyBytes(env: Env): Uint8Array<ArrayBuffer> {
  const b64 = env.AJ_CALENDAR_TOKEN_KEY || '';
  if (!/^[A-Za-z0-9+/]{43}=$/.test(b64)) throw unavailable();
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  if (bytes.length !== 32) throw unavailable();
  return bytes;
}
export function calendarConfigured(env: Env): boolean {
  if (env.AJ_ICLOUD_ENABLED !== '1') return false;
  try { keyBytes(env); return true; } catch { return false; }
}
const to64 = (bytes: Uint8Array) => btoa(Array.from(bytes, c => String.fromCharCode(c)).join(''));
const from64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function key(env: Env) { return crypto.subtle.importKey('raw', keyBytes(env), 'AES-GCM', false, ['encrypt','decrypt']); }
const aad = (staff: number, link: string) => enc.encode(`AJ/iCloud/1/${staff}/${link}`);
async function seal(env: Env, staff: number, link: string, value: Payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const result = await crypto.subtle.encrypt({ name:'AES-GCM', iv, additionalData:aad(staff,link) },await key(env),enc.encode(JSON.stringify(value)));
  return `${to64(iv)}.${to64(new Uint8Array(result))}`;
}
async function open(env: Env, row: Row): Promise<Payload> {
  const [iv, data] = row.sealed.split('.');
  if (!iv || !data) throw unavailable();
  const text = await crypto.subtle.decrypt({ name:'AES-GCM', iv:from64(iv), additionalData:aad(row.staff_id,row.link_id) },await key(env),from64(data));
  return JSON.parse(new TextDecoder().decode(text));
}
async function rowFor(env: Env,staff: number): Promise<Row|null> {
  try {
    return await env.DB.prepare('SELECT * FROM aj_icloud_connections WHERE staff_id=?').bind(staff).first<Row>();
  } catch(e) {
    // Older installs with the feature disabled may still be awaiting migration 0028.
    if(env.AJ_ICLOUD_ENABLED!=='1' && e instanceof Error && /no such table: (?:main\.)?aj_icloud_connections\b/i.test(e.message))return null;
    throw e;
  }
}
// Make authorization and the mutation one database statement rather than relying solely on a route-time check.
const ownership = `EXISTS (SELECT 1 FROM aj_staff s JOIN aj_sessions t ON t.email=s.email COLLATE NOCASE
  WHERE s.id=? AND s.active=1 AND s.email=? COLLATE NOCASE AND t.token_hash=? AND t.expires_at>?)`;
const ownerArgs = (staff: number, f: CalendarFence) => [staff,f.email,f.sessionHash,nowSec()];
function assertConfigured(env: Env) { if (!calendarConfigured(env)) throw unavailable(); }

// The Veyro feed already blocks via local bookings. Exclude its published title even
// if Apple returns a writable/imported duplicate that no longer advertises a subscription.
const eligible = (calendar:{name:string}) => !/^(?:AJ\s+Auto\s*[-–—]|Veyro(?:\s*[-–—:]|\s+(?:AJ Auto|Booking)|$))/iu.test(calendar.name.trim());

export async function connectPrivateCalendar(env: Env,staff: number,login: Login,fence: CalendarFence): Promise<void> {
  assertConfigured(env);
  const auth = { username:login.email.trim(), appSpecificPassword:login.password };
  if (!/^[^\s@:]+@[^\s@:]+\.[^\s@:]+$/.test(auth.username) || auth.username.length>254 ||
      !/^[a-z]{4}(?:-[a-z]{4}){3}$/i.test(auth.appSpecificPassword)) throw new AjError('Brug din Apple-kontos e-mail og en app-specifik adgangskode.');
  const nonce = randomToken(), link = randomToken();
  const reserved = await env.DB.prepare(`INSERT INTO aj_icloud_attempts(staff_id,nonce,expires_at)
    SELECT ?,?,? WHERE ${ownership} AND NOT EXISTS (SELECT 1 FROM aj_icloud_connections WHERE staff_id=? AND state<>'reconnect')
    ON CONFLICT(staff_id) DO UPDATE SET nonce=excluded.nonce,expires_at=excluded.expires_at`).bind(staff,nonce,nowSec()+90,...ownerArgs(staff,fence),staff).run();
  if (!reserved.meta.changes) throw changed();
  try {
    let choices;
    try { choices = await discoverAppleCalendars(auth); }
    catch (e) { throw e instanceof Error && e.message==='unauthorized' ? new AjError('Apple afviste adgangen. Kontrollér e-mail og app-specifik adgangskode.',400) : unavailable(); }
    if (!choices.some(eligible)) throw new AjError('Der blev ikke fundet nogen privat iCloud-kalender til aftaler.');
    const blob = await seal(env,staff,link,{ auth,calendars:[] });
    const saved = await env.DB.prepare(`INSERT INTO aj_icloud_connections(staff_id,link_id,sealed,state)
      SELECT ?,?,?,'pending' WHERE ${ownership} AND EXISTS(SELECT 1 FROM aj_icloud_attempts WHERE staff_id=? AND nonce=? AND expires_at>?)
      ON CONFLICT(staff_id) DO UPDATE SET link_id=excluded.link_id,sealed=excluded.sealed,state='pending',revision=revision+1
      WHERE aj_icloud_connections.state='reconnect'`).bind(staff,link,blob,...ownerArgs(staff,fence),staff,nonce,nowSec()).run();
    if (!saved.meta.changes) throw changed();
  } finally { await env.DB.prepare('DELETE FROM aj_icloud_attempts WHERE staff_id=? AND nonce=?').bind(staff,nonce).run(); }
}
export async function calendarConnection(env: Env, staff: number): Promise<{ state:State|'disconnected';selectedIds:string[] }> {
  const row = await rowFor(env,staff);
  if (!row) return { state:'disconnected',selectedIds:[] };
  if (!calendarConfigured(env)) return { state:'reconnect',selectedIds:[] };
  try { return { state:row.state,selectedIds:(await open(env,row)).calendars.map(c=>c.id) }; }
  catch { return { state:'reconnect',selectedIds:[] }; }
}
const markReconnect = (env: Env,r: Row) => env.DB.prepare(`UPDATE aj_icloud_connections SET state='reconnect',revision=revision+1
  WHERE staff_id=? AND link_id=? AND revision=?`).bind(r.staff_id,r.link_id,r.revision).run();
async function choicesFor(env: Env,r: Row,p: Payload) {
  try {
    const choices = await discoverAppleCalendars(p.auth);
    return await Promise.all(choices.filter(eligible).map(async c=>({id:await sha256Hex(c.url),name:c.name,url:c.url})));
  } catch(e) {
    if (e instanceof Error && e.message==='unauthorized') await markReconnect(env,r);
    throw unavailable();
  }
}
export async function listPrivateCalendars(env: Env,staff: number): Promise<{id:string;name:string}[]> {
  assertConfigured(env);
  const r = await rowFor(env,staff); if (!r || r.state==='reconnect') throw changed();
  return (await choicesFor(env,r,await open(env,r))).map(({id,name})=>({id,name}));
}

export async function setCalendarSelection(env: Env, staff: number, ids: string[], fence: CalendarFence): Promise<void> {
  assertConfigured(env);
  if (!Array.isArray(ids) || !ids.length || ids.length>MAX_CALENDARS || ids.some(id=>typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id)) ||
      new Set(ids).size!==ids.length) throw new AjError('Vælg mellem én og otte forskellige private kalendere.');
  const r = await rowFor(env,staff); if (!r || r.state==='reconnect') throw changed();
  const p = await open(env,r);
  const offered = await choicesFor(env,r,p);
  const calendars = ids.map(id=>{ const c=offered.find(c=>c.id===id); if (!c) throw new AjError('En valgt kalender er ikke tilgængelig.'); return {id,url:c.url}; });
  // Confirm each collection can actually return a complete time window before enabling it.
  const start = nowSec(); if (!(await readWindow(p.auth,calendars,start,start+86400)).ok) throw unavailable();
  const sealed = await seal(env,staff,r.link_id,{auth:p.auth,calendars});
  const updated = await env.DB.prepare(`UPDATE aj_icloud_connections SET sealed=?,state='connected',enforced=1,revision=revision+1
    WHERE staff_id=? AND link_id=? AND revision=? AND ${ownership}`).bind(sealed,staff,r.link_id,r.revision,...ownerArgs(staff,fence)).run();
  if (!updated.meta.changes) throw changed();
}
export async function disconnectCalendar(env: Env,staff: number,fence: CalendarFence): Promise<void> {
  // Works even if the rollout switch is off or the key was lost. Invalidate slow connects before erasing secrets.
  await env.DB.prepare(`DELETE FROM aj_icloud_attempts WHERE staff_id=? AND ${ownership}`).bind(staff,...ownerArgs(staff,fence)).run();
  await env.DB.prepare(`DELETE FROM aj_icloud_connections WHERE staff_id=? AND ${ownership}`).bind(staff,...ownerArgs(staff,fence)).run();
}

async function readWindow(auth:AppleLogin, choices:Choice[], start:number,end:number):
  Promise<{ok:false;unauthorized:boolean}|{ok:true;windows:Window[]}> {
  if (!choices.length || choices.length>MAX_CALENDARS) return {ok:false,unauthorized:false};
  const bounds = { start:new Date(start*1000).toISOString(),end:new Date(end*1000).toISOString() };
  const out:Window[]=[];
  for(let i=0;i<choices.length;i+=2) {
    const results=await Promise.all(choices.slice(i,i+2).map(c=>readAppleBusy({...auth,...bounds,collectionUrl:c.url})));
    for(const result of results) {
      if(result.status!=='ok') return {ok:false,unauthorized:result.reason==='unauthorized'};
      for(const win of result.busy) {
        const a=Date.parse(win.start)/1000,b=Date.parse(win.end)/1000;
        if(!Number.isFinite(a)||!Number.isFinite(b)||a>=b) return {ok:false,unauthorized:false};
        if(a<end&&b>start) out.push({start:Math.max(start,Math.floor(a)),end:Math.min(end,Math.ceil(b))});
      }
    }
  }
  out.sort((a,b)=>a.start-b.start);
  const merged:Window[]=[];
  for(const win of out) {const prev=merged[merged.length-1]; if(prev && win.start<=prev.end)prev.end=Math.max(prev.end,win.end);else merged.push(win);}
  return {ok:true,windows:merged};
}

// [] means no activated selection or successfully checked with no busy periods.
// null means unknown: callers MUST withhold slots. Never cache or store busy intervals here.
export async function getStaffBusyWindows(env: Env, staff: number,start: number,end: number): Promise<Window[]|null> {
  try {
    const r=await rowFor(env,staff);
    // Initial setup is opt-in. Abandoning before selection never disables ordinary bookings.
    // Once enforced, reopening requires an explicit disconnect (even after a key loss or reconnect).
    if(!r || !r.enforced)return [];
    if (!calendarConfigured(env)||r.state!=='connected'||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||
        end<=start||end-start>32*86400) return null;
    const p = await open(env,r);
    const result = await readWindow(p.auth,p.calendars,start,end);
    if(!result.ok) { if(result.unauthorized) await markReconnect(env,r); return null; }
    // A disconnect, account replacement or selection edit during I/O invalidates this result.
    const current=await env.DB.prepare('SELECT 1 AS ok FROM aj_icloud_connections WHERE staff_id=? AND link_id=? AND revision=?')
      .bind(staff,r.link_id,r.revision).first<{ok:number}>();
    return current?result.windows:null;
  } catch { return null; }
}
