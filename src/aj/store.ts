import type { Env } from '../env';
import { nowSec, randomToken, sha256Hex } from '../lib/crypto';
import { escapeHtml, sendEmail, type EmailMessage } from '../lib/email';
import { getStaffBusyWindows } from './external-busy';
import { AjError, bookingTimingNote, type AjEnv, type Settings, type Service, type Staff, type Hours, type Block, type Booking, type BookingInput, type Slot } from './types';

export const TIMEZONE = 'Europe/Copenhagen';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const danishDate = new Intl.DateTimeFormat('da-DK', { timeZone: TIMEZONE, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
export const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
export const timeText = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2,'0')}:${String(minute % 60).padStart(2,'0')}`;
export function timeMinute(value: unknown): number {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new AjError('Angiv et gyldigt klokkeslæt.');
  const [h,m] = value.split(':').map(Number); return h! * 60 + m!;
}
export function zonedParts(seconds: number): { date: string; minute: number; weekday: number } {
  const p = Object.fromEntries(formatter.formatToParts(new Date(seconds * 1000)).map(x => [x.type,x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
  return {date,minute: Number(p.hour) * 60 + Number(p.minute),weekday};
}
/** Returns zero instants for a spring gap and both instants for an autumn repeated hour. */
export function copenhagenInstants(date: string, minute: number): number[] {
  if (!validDate(date) || !Number.isInteger(minute) || minute < 0 || minute >= 1440) return [];
  const target = Date.parse(`${date}T00:00:00Z`) / 1000 + minute * 60;
  const offsets = new Set<number>();
  for (const delta of [-43200,0,43200]) {
    const sample = target + delta;
    const parts = zonedParts(sample);
    offsets.add(Date.parse(`${parts.date}T00:00:00Z`) / 1000 + parts.minute*60 - sample);
  }
  return [...offsets].map(offset => target-offset).filter(t => { const p=zonedParts(t);return p.date===date&&p.minute===minute; }).sort((a,b)=>a-b);
}
export function validDate(date: unknown): date is string {
  return typeof date === 'string' && DATE_RE.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0,10) === date;
}
export function parseInstant(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) throw new AjError('Vælg en gyldig dato og tid.');
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || millis % 60000 !== 0) throw new AjError('Vælg en gyldig dato og tid.');
  return millis / 1000;
}
export function ajOrigin(env: AjEnv, requestOrigin?: string): string {
  if (requestOrigin) { const u=new URL(requestOrigin); if (['localhost','127.0.0.1','[::1]'].includes(u.hostname)) return u.origin; }
  try { return new URL(env.AJ_URL || 'https://aj.veyro.dk').origin; } catch { return 'https://aj.veyro.dk'; }
}
export const manageLink = (origin: string,token: string) => `${origin}/booking/aftale#token=${token}`;
export function databaseError(error: unknown): never {
  const text = String(error);
  if (/AJ_CAR_NEEDS_PHOTO/.test(text)) throw new AjError('Tilføj mindst ét billede, før du sætter bilen til salg.',409);
  if (/AJ_CAR_LAST_PHOTO/.test(text)) throw new AjError('Tilføj et andet billede, eller gem bilen som kladde, før du fjerner det sidste billede.',409);
  if (/AJ_STAFF_LIMIT/.test(text)) throw new AjError('Der kan højst være 3 aktive medarbejdere, inklusive ejeren.',409);
  if (/AJ_BLOCK_HAS_BOOKING/.test(text)) throw new AjError('Der ligger allerede en aftale i tidsrummet. Flyt eller aflys den først.',409);
  if (/AJ_HOURS_HAS_BOOKING/.test(text)) throw new AjError('Åbningstiden bruges af en kommende aftale. Flyt eller aflys aftalen først.',409);
  if (/AJ_OVERLAP|AJ_BLOCKED|AJ_HOURS|AJ_STAFF_UNAVAILABLE|AJ_SERVICE_UNAVAILABLE|AJ_PAST/.test(text)) throw new AjError('Tiden er ikke længere ledig. Vælg en anden tid.',409);
  if (/AJ_NOT_READY/.test(text)) throw new AjError('Onlinebooking er lukket. Ring på 60 64 41 43 for at aftale en tid.',503);
  if (/UNIQUE constraint failed/.test(text)) throw new AjError('Oplysningen findes allerede. Kontrollér de indtastede værdier.',409);
  throw error;
}

export async function getSettings(db:D1Database):Promise<Settings> {
  const row=await db.prepare('SELECT * FROM aj_settings WHERE id=1').first<{workshop_email:string;booking_enabled:number;campaign_json:string}>();
  if(!row)throw new AjError('Booking er ikke konfigureret endnu.',503);
  return {workshopEmail:row.workshop_email,bookingEnabled:!!row.booking_enabled,campaign:JSON.parse(row.campaign_json)};
}
export async function getServices(db:D1Database):Promise<Service[]> {
  const {results}=await db.prepare('SELECT * FROM aj_services ORDER BY id').all<{id:number;name:string;description:string;duration_minutes:number|null;active:number}>();
  return results.map(r=>({id:r.id,name:r.name,description:r.description,durationMinutes:r.duration_minutes,active:!!r.active}));
}
export async function getStaff(db:D1Database):Promise<Staff[]> {
  const {results}=await db.prepare('SELECT id,name,email,role,active,calendar_token_hash IS NOT NULL AS hasCalendarLink FROM aj_staff ORDER BY id').all<{id:number;name:string;email:string;role:'owner'|'staff';active:number;hasCalendarLink:number}>();
  return results.map(r=>({...r,active:!!r.active,hasCalendarLink:!!r.hasCalendarLink}));
}
export async function getHours(db:D1Database):Promise<Hours[]> {
  const {results}=await db.prepare('SELECT * FROM aj_hours ORDER BY staff_id,weekday,start_minute').all<{id:number;staff_id:number;weekday:number;start_minute:number;end_minute:number}>();
  return results.map(r=>({id:r.id,staffId:r.staff_id,weekday:r.weekday,startTime:timeText(r.start_minute),endTime:timeText(r.end_minute)}));
}
export async function getBlocks(db:D1Database,staffId?:number):Promise<Block[]> {
  const {results}=await db.prepare(`SELECT * FROM aj_blocks ${staffId?'WHERE staff_id=?':''} ORDER BY start_at`).bind(...(staffId?[staffId]:[])).all<{id:number;staff_id:number;start_at:number;end_at:number;reason:string}>();
  return results.map(r=>({id:r.id,staffId:r.staff_id,startAt:iso(r.start_at),endAt:iso(r.end_at),reason:r.reason}));
}
export function mailConfigured(env:Env,settings:Settings):boolean { return !!env.RESEND_API_KEY&&!!settings.workshopEmail; }
export async function readiness(env:Env,settings?:Settings) {
  const s=settings??await getSettings(env.DB);
  const [services,staff,hours]=await Promise.all([getServices(env.DB),getStaff(env.DB),getHours(env.DB)]);
  const missing:string[]=[];
  if(!env.RESEND_API_KEY)missing.push('Resend-mailintegration');
  if(!staff.some(x=>x.active))missing.push('Mindst én medarbejder med bekræftet navn og e-mail');
  if(!services.some(x=>x.active&&x.durationMinutes))missing.push('Aktiv ydelse med bekræftet varighed');
  if(!hours.some(x=>staff.some(y=>y.active&&y.id===x.staffId)))missing.push('Bekræftede åbningstider på en aktiv kalender');
  if(!s.bookingEnabled)missing.push('Aktivering af onlinebooking');
  const warnings = s.workshopEmail ? [] : ['Værkstedets mails afventer en modtager. Aftalerne vises i kalenderen med det samme.'];
  return {ready:missing.length===0,missing,warnings,mailConfigured:mailConfigured(env,s),customerMailConfigured:!!env.RESEND_API_KEY,workshopMailConfigured:mailConfigured(env,s)};
}
export async function getSlots(env:Env,serviceId:number,date:string,staffId?:number,excludeBookingId?:string):Promise<Slot[]> {
  if(!validDate(date))throw new AjError('Vælg en gyldig dato.');
  const today=zonedParts(nowSec()).date;
  const future=Date.parse(date)-Date.parse(today);
  if(future<0||future>180*86400000)throw new AjError('Vælg en dato inden for de næste 180 dage.');
  const settings=await getSettings(env.DB);
  if(!settings.bookingEnabled||!env.RESEND_API_KEY)return [];
  const [services,allStaff,hours]=await Promise.all([getServices(env.DB),getStaff(env.DB),getHours(env.DB)]);
  const service=services.find(s=>s.id===serviceId&&s.active&&s.durationMinutes);
  if(!service)return [];
  const staff=allStaff.filter(s=>s.active&&(!staffId||s.id===staffId));
  const weekday=new Date(`${date}T12:00:00Z`).getUTCDay()||7;
  const from=Date.parse(`${date}T00:00:00Z`)/1000-4*3600;
  const to=from+32*3600;
  const [busyResult,blockedResult]=await Promise.all([
    env.DB.prepare("SELECT id,staff_id,start_at,end_at FROM aj_bookings WHERE status='confirmed' AND start_at<? AND end_at>? AND id<>?").bind(to,from,excludeBookingId??'').all<{staff_id:number;start_at:number;end_at:number}>(),
    env.DB.prepare('SELECT staff_id,start_at,end_at FROM aj_blocks WHERE start_at<? AND end_at>?').bind(to,from).all<{staff_id:number;start_at:number;end_at:number}>()
  ]);
  const busy=[...busyResult.results,...blockedResult.results];
  const slots:Slot[]=[];const seen=new Set<string>();
  for(const member of staff) for(const h of hours.filter(x=>x.staffId===member.id&&x.weekday===weekday)) {
    const begin=timeMinute(h.startTime),end=h.endTime==='24:00'?1440:timeMinute(h.endTime);
    for(let minute=begin;minute+service.durationMinutes!<=end;minute+=15) for(const start of copenhagenInstants(date,minute)) {
      const finish=start+service.durationMinutes!*60,p=zonedParts(finish);
      // Avoid an appointment crossing a DST jump or local midnight: its stated wall duration must be exact.
      if(start<=nowSec()||p.date!==date||p.minute!==minute+service.durationMinutes!)continue;
      if(busy.some(b=>b.staff_id===member.id&&b.start_at<finish&&b.end_at>start))continue;
      const key=`${start}:${member.id}`;if(seen.has(key))continue;seen.add(key);
      slots.push({startAt:iso(start),staffId:member.id,staffName:member.name});
    }
  }
  // The write paths call getSlots again; never trust availability previously shown to a customer.
  // Only query staff with bookable time left after applying working hours and AJ appointments.
  const durationSeconds=service.durationMinutes!*60;
  const available=await Promise.all(staff.map(async member=>{
    const candidates=slots.filter(slot=>slot.staffId===member.id)
      .map(slot=>({slot,start:parseInstant(slot.startAt)}));
    if(!candidates.length)return [];
    const starts=candidates.map(candidate=>candidate.start);
    const external=await getStaffBusyWindows(env,member.id,Math.min(...starts),Math.max(...starts)+durationSeconds);
    if(external===null)return []; // Connected calendar unavailable: suppress this member only.
    return candidates.filter(({start})=>!external.some(window=>window.start<start+durationSeconds&&window.end>start))
      .map(({slot})=>slot);
  }));
  return available.flat().sort((a,b)=>a.startAt.localeCompare(b.startAt)||a.staffId-b.staffId);
}

interface BookingRow {id:string;service_id:number;service_name:string;staff_id:number;staff_name:string;start_at:number;end_at:number;name:string;email:string;phone:string;registration:string;note:string;status:'confirmed'|'cancelled';version:number;manage_token_hash:string;mutation_id:string}
export function bookingView(r:BookingRow):Booking { return {id:r.id,serviceId:r.service_id,serviceName:r.service_name,staffId:r.staff_id,staffName:r.staff_name,startAt:iso(r.start_at),endAt:iso(r.end_at),name:r.name,email:r.email,phone:r.phone,registration:r.registration,note:r.note,status:r.status,version:r.version}; }
export async function getBooking(db:D1Database,id:string):Promise<BookingRow|null> { return db.prepare('SELECT * FROM aj_bookings WHERE id=?').bind(id).first<BookingRow>(); }
export async function tokenBooking(db:D1Database,token:string):Promise<BookingRow> {
  if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw new AjError('Linket er ugyldigt eller udløbet.',404);
  const row=await db.prepare('SELECT * FROM aj_bookings WHERE manage_token_hash=?').bind(await sha256Hex(token)).first<BookingRow>();
  if(!row||row.end_at<nowSec()-86400)throw new AjError('Linket er ugyldigt eller udløbet.',404);
  return row;
}
export async function listBookings(db:D1Database,staffId?:number):Promise<Booking[]> {
  const {results}=await db.prepare(`SELECT * FROM aj_bookings ${staffId?'WHERE staff_id=?':''} ORDER BY start_at DESC LIMIT 1000`).bind(...(staffId?[staffId]:[])).all<BookingRow>();
  return results.map(bookingView);
}

function mailForBooking(
  booking: Booking, kind: 'created' | 'rescheduled' | 'cancelled',
  token: string, origin: string, workshop: boolean,
): Omit<EmailMessage, 'to'> {
  const status = { created: 'bekræftet', rescheduled: 'flyttet', cancelled: 'aflyst' }[kind];
  const subject = workshop ? `Aftale ${status} hos AJ Auto` : `Din tid hos AJ Auto er ${status}`;
  const details = [
    booking.serviceName,
    danishDate.format(new Date(booking.startAt)),
    'Sorøvej 5kl, Slagelse',
  ];
  if (kind !== 'cancelled') {
    const minutes = (Date.parse(booking.endAt) - Date.parse(booking.startAt)) / 60000;
    details.push(`Forventet varighed: ${minutes} minutter.`);
  }
  if (workshop) {
    details.push(`Kalender: ${booking.staffName}`, booking.name, booking.phone, booking.email);
    if (booking.registration) details.push(`Nummerplade: ${booking.registration}`);
    if (booking.note) details.push(`Bemærkning: ${booking.note}`);
  }
  const link = !workshop && kind !== 'cancelled' ? manageLink(origin, token) : null;
  const text = [subject, '', ...details];
  if (kind !== 'cancelled') text.push(bookingTimingNote);
  if (link) text.push('', 'Se, flyt eller aflys din aftale med dit personlige link.', link);
  text.push('', 'AJ Auto', '60 64 41 43');

  const html = `<!doctype html><html lang="da"><body style="font:16px/1.55 Arial,sans-serif;color:#19191c">
    <h1 style="font-size:26px;line-height:1.15">${escapeHtml(subject)}</h1>
    <p>${details.map(detail => escapeHtml(detail)).join('<br>')}</p>
    ${kind !== 'cancelled' ? `<p><small>${escapeHtml(bookingTimingNote)}</small></p>` : ''}
    ${link ? `<p><a style="color:#40258e" href="${escapeHtml(link)}">Se, flyt eller aflys din aftale</a><br>Linket er personligt.</p>` : ''}
    <p>AJ Auto<br><a style="color:#40258e" href="tel:+4560644143">60 64 41 43</a></p>
  </body></html>`;
  return { subject, text: text.join('\n'), html };
}
const enc=new TextEncoder();
function toBase64(bytes:Uint8Array):string {let out='';for(const byte of bytes)out+=String.fromCharCode(byte);return btoa(out);}
function fromBase64(value:string):Uint8Array {return Uint8Array.from(atob(value),c=>c.charCodeAt(0));}
async function outboxKey(env:AjEnv):Promise<CryptoKey> {
  const secret=env.AJ_OUTBOX_KEY||env.RESEND_API_KEY;
  if(!secret)throw new AjError('Mailintegration mangler.',503);
  const hash=await crypto.subtle.digest('SHA-256',enc.encode(`AJ Auto outbox v1\0${secret}`));
  return crypto.subtle.importKey('raw',hash,'AES-GCM',false,['encrypt','decrypt']);
}
async function sealMail(env:AjEnv,msg:EmailMessage):Promise<string> {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv},await outboxKey(env),enc.encode(JSON.stringify(msg)));
  return `v1.${toBase64(iv)}.${toBase64(new Uint8Array(encrypted))}`;
}
async function openMail(env:AjEnv,payload:string):Promise<EmailMessage> {
  const [version,iv,data]=payload.split('.');if(version!=='v1'||!iv||!data)throw new Error('Invalid mail envelope');
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:fromBase64(iv)},await outboxKey(env),fromBase64(data))));
}
async function bookingMails(env:AjEnv,b:Booking,event:'created'|'rescheduled'|'cancelled',token:string,origin:string,mutationId:string) {
  const settings=await getSettings(env.DB);
  const statements:D1PreparedStatement[]=[];const ids:string[]=[];
  for(const [to,kind] of [[b.email,'customer'],[settings.workshopEmail,'workshop']] as const) {
    const id=crypto.randomUUID();ids.push(id);
    const replyTo=kind==='workshop'?b.email:settings.workshopEmail;
    const payload=await sealMail(env,{to,...mailForBooking(b,event,token,origin,kind==='workshop'),...(replyTo?{replyTo}:{})});
    // Freeze the exact event, even when the workshop's destination is supplied later.
    const initialStatus=kind==='workshop'&&!to?'not_configured':'pending';
    statements.push(env.DB.prepare("INSERT INTO aj_outbox(id,booking_id,event,recipient_kind,payload,status) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM aj_bookings WHERE id=? AND mutation_id=?)").bind(id,b.id,event,kind,payload,initialStatus,b.id,mutationId));
  }
  return {statements,ids};
}
async function contactMail(env:AjEnv,messageId:string):Promise<EmailMessage> {
  const settings=await getSettings(env.DB);
  const input=await env.DB.prepare('SELECT name,email,phone,message FROM aj_messages WHERE id=?').bind(messageId).first<{name:string;email:string;phone:string;message:string}>();
  if(!input)throw new Error('Contact message missing');
  const text=`Ny besked til AJ Auto\n\nNavn: ${input.name}\nE-mail: ${input.email}\nTelefon: ${input.phone}\n\n${input.message}`;
  return {to:settings.workshopEmail,replyTo:input.email,subject:'Ny besked fra AJ Autos hjemmeside',text,html:`<div style="white-space:pre-wrap">${escapeHtml(text)}</div>`};
}
async function deliveryAfterSave(env:AjEnv,ids:string[]):Promise<'sent'|'pending'|'not_configured'> {
  try{return await deliverAjMail(env,ids);}catch{console.error('AJ Auto mail processing deferred');return env.RESEND_API_KEY?'pending':'not_configured';}
}
type MailStatus = 'sent' | 'pending' | 'not_configured';
interface NotificationStatus { customer: MailStatus; workshop: MailStatus }
async function recipientStatuses(env:AjEnv,ids:string[]):Promise<NotificationStatus> {
  const statuses:NotificationStatus={customer:'not_configured',workshop:'not_configured'};
  if(!ids.length)return statuses;
  const {results}=await env.DB.prepare(`SELECT recipient_kind,status FROM aj_outbox WHERE id IN (${ids.map(()=>'?').join(',')})`).bind(...ids).all<{recipient_kind:'customer'|'workshop';status:string}>();
  for(const kind of ['customer','workshop'] as const) {
    const rows=results.filter(row=>row.recipient_kind===kind);
    if(!rows.length)continue;
    statuses[kind]=rows.some(row=>row.status==='not_configured')?'not_configured':rows.some(row=>row.status!=='sent')?'pending':'sent';
  }
  return statuses;
}
async function bookingDelivery(env:AjEnv,ids:string[]) {
  const notificationStatus=await deliveryAfterSave(env,ids);
  try{return {notificationStatus,notifications:await recipientStatuses(env,ids)};}
  catch{return {notificationStatus,notifications:{customer:'pending',workshop:'pending'} as NotificationStatus};}
}
export async function deliverAjMail(env:AjEnv,ids?:string[]):Promise<'sent'|'pending'|'not_configured'> {
  if(!env.RESEND_API_KEY)return 'not_configured';
  const now=nowSec();
  const filter=ids?.length?`AND id IN (${ids.map(()=>'?').join(',')})`:'';
  const {results}=await env.DB.prepare(`SELECT id FROM aj_outbox WHERE (status IN ('pending','failed','not_configured') OR (status='sending' AND lease_until<?)) AND next_attempt_at<=? ${filter} ORDER BY created_at,rowid LIMIT 30`).bind(now,now,...(ids??[])).all<{id:string}>();
  for(const {id} of results) {
    const row=await env.DB.prepare("UPDATE aj_outbox SET status='sending',lease_until=?,attempts=attempts+1 WHERE id=? AND (status IN ('pending','failed','not_configured') OR (status='sending' AND lease_until<?)) RETURNING payload,attempts,booking_id,message_id,event,recipient_kind").bind(now+120,id,now).first<{payload:string;attempts:number;booking_id:string|null;message_id:string|null;event:string;recipient_kind:string}>();
    if(!row)continue;
    try {
      let message:EmailMessage;
      if(row.payload.startsWith('deferred:')) {
        const settings=await getSettings(env.DB);
        if(row.payload==='deferred:contact'&&row.message_id)message=await contactMail(env,row.message_id);
        else if(row.payload==='deferred:cancelled'&&row.booking_id){
          const booking=await getBooking(env.DB,row.booking_id);if(!booking)throw new Error('Booking missing');
          const workshop=row.recipient_kind==='workshop';
          const replyTo=workshop?booking.email:settings.workshopEmail;
          message={to:workshop?settings.workshopEmail:booking.email,...mailForBooking(bookingView(booking),'cancelled','',ajOrigin(env),workshop),...(replyTo?{replyTo}:{})};
        }else throw new Error('Unknown deferred message');
      }else message=await openMail(env,row.payload);
      if(row.recipient_kind==='workshop'&&!message.to) {
        message.to=(await getSettings(env.DB)).workshopEmail;
      }
      if(!message.to) {
        await env.DB.prepare("UPDATE aj_outbox SET status='not_configured',lease_until=NULL,next_attempt_at=? WHERE id=?").bind(nowSec()+600,id).run();
        continue;
      }
      const sent=await sendEmail(env,message);
      if(!sent)throw new Error('Mail not configured');
      await env.DB.prepare("UPDATE aj_outbox SET status='sent',payload='',sent_at=?,lease_until=NULL,last_error=NULL WHERE id=?").bind(nowSec(),id).run();
    } catch {
      // No recipient, token or mail body is written to logs or error fields.
      await env.DB.prepare("UPDATE aj_outbox SET status='failed',lease_until=NULL,last_error='E-mail kunne ikke sendes. Forsøges igen.',next_attempt_at=? WHERE id=?").bind(nowSec()+Math.min(3600,30*Math.pow(2,Math.min(row.attempts,6))),id).run();
    }
  }
  if(ids?.length) {
    const row=await env.DB.prepare(`SELECT count(*) AS n,sum(CASE WHEN status='not_configured' THEN 1 ELSE 0 END) AS unconfigured FROM aj_outbox WHERE id IN (${ids.map(()=>'?').join(',')}) AND status<>'sent'`).bind(...ids).first<{n:number;unconfigured:number}>();
    return row?.unconfigured?'not_configured':row?.n?'pending':'sent';
  }
  return 'pending';
}
export async function retryAjMail(env:Env):Promise<void> {
  // Old deployments / preview databases without this migration should not break unrelated cron work.
  const exists=await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='aj_outbox'").first();
  if(!exists)return;
  await deliverAjMail(env);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM aj_login_tokens WHERE expires_at<?').bind(nowSec()-3600),
    env.DB.prepare('DELETE FROM aj_sessions WHERE expires_at<?').bind(nowSec()),
    env.DB.prepare("DELETE FROM aj_outbox WHERE status='sent' AND sent_at<?").bind(nowSec()-90*86400),
  ]);
}

export async function createBooking(env:AjEnv,input:BookingInput,origin:string) {
  const settings=await getSettings(env.DB);
  if(!(await readiness(env,settings)).ready)throw new AjError('Onlinebooking er lukket. Ring på 60 64 41 43 for at aftale en tid.',503);
  const start=parseInstant(input.startAt),local=zonedParts(start);
  const slot=(await getSlots(env,input.serviceId,local.date,input.staffId)).find(s=>parseInstant(s.startAt)===start&&s.staffId===input.staffId);
  if(!slot)throw new AjError('Tiden er ikke længere ledig. Vælg en anden tid.',409);
  const service=(await getServices(env.DB)).find(s=>s.id===input.serviceId)!;
  const token=randomToken(32),id=crypto.randomUUID(),mutationId=crypto.randomUUID();
  const end=start+service.durationMinutes!*60;
  const booking:Booking={...input,id,serviceName:service.name,staffName:slot.staffName,startAt:iso(start),endAt:iso(end),status:'confirmed',version:1};
  const queued=await bookingMails(env,booking,'created',token,origin,mutationId);
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO aj_bookings(id,service_id,service_name,staff_id,staff_name,start_at,end_at,local_date,local_weekday,local_start,local_end,name,email,phone,registration,note,manage_token_hash,mutation_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,input.serviceId,service.name,input.staffId,slot.staffName,start,end,local.date,local.weekday,local.minute,local.minute+service.durationMinutes!,input.name,input.email,input.phone,input.registration,input.note,await sha256Hex(token),mutationId),
      ...queued.statements
    ]);
  }catch(e){databaseError(e);}
  return {ok:true,booking,manageUrl:manageLink(origin,token),...await bookingDelivery(env,queued.ids)};
}
export async function rescheduleBooking(env:AjEnv,row:BookingRow,startAt:string,staffId:number,origin:string,existingToken?:string) {
  if(row.status!=='confirmed')throw new AjError('En aflyst aftale kan ikke flyttes.',409);
  if(row.start_at<=nowSec())throw new AjError('Aftalen er allerede startet. Ring til værkstedet.',409);
  if(!(await readiness(env)).ready)throw new AjError('Tiden kan ikke flyttes online lige nu. Ring på 60 64 41 43.',503);
  const start=parseInstant(startAt),local=zonedParts(start);
  const slot=(await getSlots(env,row.service_id,local.date,staffId,row.id)).find(s=>parseInstant(s.startAt)===start&&s.staffId===staffId);
  if(!slot)throw new AjError('Tiden er ikke længere ledig. Vælg en anden tid.',409);
  const service=(await getServices(env.DB)).find(s=>s.id===row.service_id)!;
  const end=start+service.durationMinutes!*60,token=existingToken||randomToken(32),mutationId=crypto.randomUUID();
  const booking:Booking={...bookingView(row),staffId,staffName:slot.staffName,startAt:iso(start),endAt:iso(end),version:row.version+1};
  const queued=await bookingMails(env,booking,'rescheduled',token,origin,mutationId);
  try {
    const result=await env.DB.batch([
      env.DB.prepare(`UPDATE aj_bookings SET staff_id=?,staff_name=?,start_at=?,end_at=?,local_date=?,local_weekday=?,local_start=?,local_end=?,manage_token_hash=?,version=version+1,mutation_id=?,updated_at=? WHERE id=? AND version=? AND status='confirmed'`).bind(staffId,slot.staffName,start,end,local.date,local.weekday,local.minute,local.minute+service.durationMinutes!,await sha256Hex(token),mutationId,nowSec(),row.id,row.version),...queued.statements
    ]);
    if(!result[0]?.meta.changes)throw new AjError('Aftalen er blevet ændret. Genindlæs siden og prøv igen.',409);
  }catch(e){databaseError(e);}
  return {ok:true,booking,manageUrl:manageLink(origin,token),...await bookingDelivery(env,queued.ids)};
}
export async function cancelBooking(env:AjEnv,row:BookingRow,origin:string) {
  if(row.status==='cancelled'){
    const mails=await env.DB.prepare("SELECT id,status FROM aj_outbox WHERE booking_id=? AND event='cancelled'").bind(row.id).all<{id:string;status:string}>();
    const notificationStatus=mails.results.some(m=>m.status==='not_configured')?'not_configured':mails.results.some(m=>m.status!=='sent')?'pending':mails.results.length?'sent':'not_configured';
    return {ok:true,booking:bookingView(row),notificationStatus,notifications:await recipientStatuses(env,mails.results.map(mail=>mail.id))};
  }
  if(row.start_at<=nowSec())throw new AjError('Aftalen er allerede startet. Ring til værkstedet.',409);
  const mutationId=crypto.randomUUID(),booking:Booking={...bookingView(row),status:'cancelled',version:row.version+1};
  const queued=env.RESEND_API_KEY?await bookingMails(env,booking,'cancelled','',origin,mutationId):{statements:[] as D1PreparedStatement[],ids:[] as string[]};
  if(!queued.ids.length)for(const kind of ['customer','workshop']){
    const mailId=crypto.randomUUID();queued.ids.push(mailId);
    queued.statements.push(env.DB.prepare("INSERT INTO aj_outbox(id,booking_id,event,recipient_kind,payload,status) SELECT ?,?,'cancelled',?,'deferred:cancelled','not_configured' WHERE EXISTS(SELECT 1 FROM aj_bookings WHERE id=? AND mutation_id=?)").bind(mailId,row.id,kind,row.id,mutationId));
  }
  try {
    const result=await env.DB.batch([
      env.DB.prepare("UPDATE aj_bookings SET status='cancelled',version=version+1,mutation_id=?,updated_at=? WHERE id=? AND version=? AND status='confirmed'").bind(mutationId,nowSec(),row.id,row.version),...queued.statements
    ]);
    if(!result[0]?.meta.changes)throw new AjError('Aftalen er blevet ændret. Genindlæs siden og prøv igen.',409);
  }catch(e){databaseError(e);}
  return {ok:true,booking,...await bookingDelivery(env,queued.ids)};
}
export async function saveContact(env:AjEnv,input:{name:string;email:string;phone:string;message:string}) {
  const settings=await getSettings(env.DB),id=crypto.randomUUID(),mailId=crypto.randomUUID();
  const configured=mailConfigured(env,settings);
  // A deferred job refers to the saved message. No recipient or private content is duplicated in the queue.
  await env.DB.batch([
    env.DB.prepare('INSERT INTO aj_messages(id,name,email,phone,message) VALUES(?,?,?,?,?)').bind(id,input.name,input.email,input.phone,input.message),
    env.DB.prepare("INSERT INTO aj_outbox(id,message_id,event,recipient_kind,payload,status) VALUES(?,?,'contact','workshop','deferred:contact',?)").bind(mailId,id,configured?'pending':'not_configured')
  ]);
  return {ok:true,id,notificationStatus:configured?await deliveryAfterSave(env,[mailId]):'not_configured',message:configured?'Din besked er gemt.':'Din besked er gemt, men værkstedets mail er endnu ikke tilkoblet. Ring på 60 64 41 43, hvis du vil have fat i os nu.'};
}

function icsEscape(value:string):string {return value.replace(/\\/g,'\\\\').replace(/\r?\n/g,'\\n').replace(/;/g,'\\;').replace(/,/g,'\\,');}
function icsTime(instant:string):string {return instant.replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');}
/** Fold by UTF-8 octets, as RFC 5545 requires, without splitting a Unicode code point. */
function foldIcs(line:string):string {let out='',part='',n=0;for(const char of line){const size=enc.encode(char).length;if(n+size>74){out+=part+'\r\n ';part='';n=1;}part+=char;n+=size;}return out+part;}
export function calendarIcs(bookings:Booking[],staffName:string):string {
  const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Veyro//AJ Auto Booking//DA','CALSCALE:GREGORIAN','METHOD:PUBLISH',`X-WR-CALNAME:${icsEscape(`AJ Auto – ${staffName}`)}`,'X-WR-TIMEZONE:Europe/Copenhagen','REFRESH-INTERVAL;VALUE=DURATION:PT30M','X-PUBLISHED-TTL:PT30M'];
  for(const b of bookings)lines.push('BEGIN:VEVENT',`UID:${b.id}@aj.veyro.dk`,`DTSTAMP:${icsTime(iso(nowSec()))}`,`DTSTART:${icsTime(b.startAt)}`,`DTEND:${icsTime(b.endAt)}`,`SEQUENCE:${b.version}`,`STATUS:${b.status==='cancelled'?'CANCELLED':'CONFIRMED'}`,`SUMMARY:${icsEscape(`${b.serviceName} – ${b.name}`)}`,`DESCRIPTION:${icsEscape(`Telefon: ${b.phone}${b.registration?`\nNummerplade: ${b.registration}`:''}\n${bookingTimingNote}\nAdministrer aftalen i AJ Autos bookingsystem.`)}`,'LOCATION:Sorøvej 5kl\, Slagelse','END:VEVENT');
  lines.push('END:VCALENDAR');return lines.map(foldIcs).join('\r\n')+'\r\n';
}
