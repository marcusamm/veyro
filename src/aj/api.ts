import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { AppEnv } from '../env';
import { nowSec, randomToken, sha256Hex } from '../lib/crypto';
import { normalizeEmail, rateLimit } from '../lib/db';
import { escapeHtml, sendEmail } from '../lib/email';
import { parseAdminEmails } from '../lib/session';
import { AjError, type AjUser, type Campaign, type Settings } from './types';
import { addCarPhoto, adminCars, carId, carPhotoUploadPath, saveCar } from './car-admin';
import { ajOrigin, bookingView, calendarIcs, cancelBooking, createBooking, databaseError, deliverAjMail, getBlocks, getBooking, getHours, getServices, getSettings, getSlots, getStaff, iso, listBookings, mailConfigured, parseInstant, readiness, rescheduleBooking, saveContact, timeMinute, tokenBooking, validDate, zonedParts } from './store';

type C=Context<AppEnv>;
const api=new Hono<AppEnv>();
const jsonLimit = bodyLimit({maxSize:20*1024,onError:c=>c.json({error:'Beskeden er for stor.'},413)});
const photoLimit = bodyLimit({maxSize:680*1024,onError:c=>c.json({error:'Billedet er for stort.'},413)});
api.use('*',(c,next)=>(c.req.method === 'POST' && carPhotoUploadPath.test(c.req.path) ? photoLimit : jsonLimit)(c,next));
api.use('*',async(c,next)=>{
  c.header('Cache-Control','no-store');c.header('Referrer-Policy','no-referrer');c.header('X-Robots-Tag','noindex, nofollow');
  if(c.req.method==='POST'){
    // Same-origin JSON is the CSRF boundary; no permissive CORS and no form POST fallback.
    if(c.req.header('Origin')!==new URL(c.req.url).origin||c.req.header('Sec-Fetch-Site')==='cross-site')return c.json({error:'Anmodningen kunne ikke godkendes. Genindlæs siden og prøv igen.'},403);
    if(!/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type')||''))return c.json({error:'Vi kunne ikke læse formularen. Genindlæs siden, og prøv igen.'},415);
  }
  await next();
});
api.onError((error,c)=>{
  if(error instanceof AjError)return c.json({error:error.message},error.status);
  try{databaseError(error);}catch(mapped){if(mapped instanceof AjError)return c.json({error:mapped.message},mapped.status);}
  console.error('AJ Auto request failed');
  return c.json({error:'Der opstod en fejl. Prøv igen, eller ring på 60 64 41 43.'},500);
});
async function body(c:C):Promise<Record<string,unknown>>{
  try{const value=await c.req.json();if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value;}catch{throw new AjError('Anmodningen indeholder ugyldige oplysninger.');}
}
function str(value:unknown,max:number,required=false):string{
  if(value===undefined||value===null){if(required)throw new AjError('Udfyld de obligatoriske felter.');return '';}
  if(typeof value!=='string')throw new AjError('Kontrollér de indtastede oplysninger.');
  const clean=value.trim();if(clean.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(clean))throw new AjError('Et felt er for langt eller indeholder ugyldige tegn.');
  if(required&&!clean)throw new AjError('Udfyld de obligatoriske felter.');return clean;
}
function id(value:unknown):number{const n=Number(value);if(!Number.isSafeInteger(n)||n<=0)throw new AjError('Vælg en gyldig ydelse eller kalender.');return n;}
function bool(value:unknown,previous=false):boolean{if(value===undefined)return previous;if(typeof value!=='boolean')throw new AjError('Kontrollér indstillingerne.');return value;}
function email(value:unknown):string{const v=normalizeEmail(value);if(!v)throw new AjError('Indtast en gyldig e-mailadresse.');return v;}
function phone(value:unknown,required=false):string{const v=str(value,30,required);if(v&&!/^\+?[\d\s().-]{6,30}$/.test(v))throw new AjError('Indtast et gyldigt telefonnummer.');return v;}
async function limited(c:C,action:string,max:number,window=3600,identity?:string){const ip=c.req.header('CF-Connecting-IP')||'local';if(!await rateLimit(c.env.DB,`aj:${action}:${await sha256Hex(identity??ip)}`,max,window))throw new AjError('For mange forsøg. Vent lidt, og prøv igen.',429);}
function origin(c:C){return ajOrigin(c.env,new URL(c.req.url).origin);}
function cookieName(c:C){return new URL(c.req.url).protocol==='https:'?'__Host-aj_session':'aj_session';}
const sessionSeconds=12*3600;
async function identity(c:C,value:string):Promise<AjUser|null>{
  if(!normalizeEmail(value))return null;
  const staff=await c.env.DB.prepare('SELECT id,email,role FROM aj_staff WHERE email=? COLLATE NOCASE AND active=1').bind(value).first<{id:number;email:string;role:'owner'|'staff'}>();
  if(staff)return{email:staff.email,role:staff.role,staffId:staff.id};
  return parseAdminEmails(c.env).has(value)?{email:value,role:'operator',staffId:null}:null;
}
async function user(c:C):Promise<AjUser|null>{
  const token=getCookie(c,cookieName(c));if(!token||!/^[A-Za-z0-9_-]{43}$/.test(token))return null;
  const row=await c.env.DB.prepare('SELECT email FROM aj_sessions WHERE token_hash=? AND expires_at>?').bind(await sha256Hex(token),nowSec()).first<{email:string}>();
  return row?identity(c,row.email):null;
}
async function requireUser(c:C,owner=false):Promise<AjUser>{const u=await user(c);if(!u)throw new AjError('Log ind for at fortsætte.',401);if(owner&&u.role==='staff')throw new AjError('Kun ejeren kan ændre denne indstilling.',403);return u;}
function requireCalendar(u:AjUser,staffId:number){if(u.role==='staff'&&u.staffId!==staffId)throw new AjError('Du har kun adgang til din egen kalender.',403);}
async function authorizedBooking(c:C,bookingId:string){const u=await requireUser(c);const b=await getBooking(c.env.DB,bookingId);if(!b)throw new AjError('Aftalen findes ikke.',404);requireCalendar(u,b.staff_id);return{u,b};}

api.get('/config',async c=>{
  const [settings,services,staff]=await Promise.all([getSettings(c.env.DB),getServices(c.env.DB),getStaff(c.env.DB)]);
  const ready=await readiness(c.env,settings),campaign=settings.campaign;
  const visibleCampaign=campaign.enabled&&campaign.confirmed&&campaign.expiresOn&&campaign.expiresOn>=zonedParts(nowSec()).date?campaign:null;
  return c.json({services,staff:staff.filter(s=>s.active).map(s=>({id:s.id,name:s.name})),campaign:visibleCampaign,bookingReady:ready.ready,contactReady:true,contactEmailReady:ready.mailConfigured,timezone:'Europe/Copenhagen'});
});
api.get('/slots',async c=>{
  const serviceId=id(c.req.query('serviceId')),staffId=c.req.query('staffId')?id(c.req.query('staffId')):undefined,date=str(c.req.query('date'),10,true);
  let exclude:string|undefined;
  const manageToken=c.req.header('X-AJ-Token')||c.req.query('token');
  if(manageToken)exclude=(await tokenBooking(c.env.DB,manageToken)).id;
  else if(c.req.query('bookingId'))exclude=(await authorizedBooking(c,c.req.query('bookingId')!)).b.id;
  return c.json({slots:await getSlots(c.env,serviceId,date,staffId,exclude),timezone:'Europe/Copenhagen',bookingReady:(await readiness(c.env)).ready});
});
api.post('/bookings',async c=>{
  await limited(c,'booking',10);const b=await body(c);
  const result=await createBooking(c.env,{serviceId:id(b.serviceId),staffId:id(b.staffId),startAt:str(b.startAt,40,true),name:str(b.name,100,true),email:email(b.email),phone:phone(b.phone,true),registration:str(b.registration,20).toUpperCase(),note:str(b.note,1500)},origin(c));
  return c.json(result,201);
});
api.get('/manage',async c=>{
  await limited(c,'manage-read',90,900);
  const row=await tokenBooking(c.env.DB,str(c.req.header('X-AJ-Token')||c.req.query('token'),64,true));
  return c.json({booking:bookingView(row),services:await getServices(c.env.DB),staff:(await getStaff(c.env.DB)).filter(s=>s.active).map(s=>({id:s.id,name:s.name})),bookingReady:(await readiness(c.env)).ready});
});
api.post('/manage/reschedule',async c=>{
  await limited(c,'manage-write',30,900);const b=await body(c),token=str(b.token,64,true),row=await tokenBooking(c.env.DB,token);
  return c.json(await rescheduleBooking(c.env,row,str(b.startAt,40,true),id(b.staffId),origin(c),token));
});
api.post('/manage/cancel',async c=>{
  await limited(c,'manage-write',30,900);const b=await body(c),row=await tokenBooking(c.env.DB,str(b.token,64,true));
  return c.json(await cancelBooking(c.env,row,origin(c)));
});
api.post('/contact',async c=>{
  await limited(c,'contact',8);const b=await body(c);
  if(str(b.website,200))throw new AjError('Beskeden kunne ikke sendes. Ring i stedet på 60 64 41 43.');
  return c.json(await saveContact(c.env,{name:str(b.name,100,true),email:email(b.email),phone:phone(b.phone),message:str(b.message,5000,true)}),201);
});

api.post('/admin/login',async c=>{
  await limited(c,'login-ip',20,900);const b=await body(c),address=email(b.email);
  await limited(c,'login-email',6,900,address);
  const u=await identity(c,address);let devLink:string|undefined;
  if(u){
    const token=randomToken(32),link=`${origin(c)}/admin#token=${token}`;
    await c.env.DB.prepare('INSERT INTO aj_login_tokens(token_hash,email,expires_at) VALUES(?,?,?)').bind(await sha256Hex(token),address,nowSec()+900).run();
    if(c.env.RESEND_API_KEY){
      // Do not reveal account membership or provider status in the HTTP response.
      c.executionCtx.waitUntil(sendEmail(c.env,{to:address,subject:'Log ind på AJ Autos booking',text:`Log ind på AJ Autos booking:\n\n${link}\n\nLinket gælder i 15 minutter og kan kun bruges én gang. Hvis du ikke bad om et login, kan du se bort fra mailen.`,html:`<p><a href="${escapeHtml(link)}">Log ind på AJ Autos booking</a></p><p>Linket gælder i 15 minutter og kan kun bruges én gang.</p>`}).catch(()=>{/* generic login response; never log tokens or recipients */}));
    }else if(c.env.DEV_MODE==='1'&&['localhost','127.0.0.1'].includes(new URL(c.req.url).hostname))devLink=link;
  }
  return c.json({ok:true,message:'Hvis e-mailadressen har adgang, får du et login-link. Linket gælder i 15 minutter.',...(devLink?{devLink}:{})});
});
api.post('/admin/verify',async c=>{
  await limited(c,'verify',30,900);const b=await body(c),token=str(b.token,64,true);
  if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw new AjError('Login-linket er ugyldigt eller udløbet.',401);
  const row=await c.env.DB.prepare('UPDATE aj_login_tokens SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires_at>? RETURNING email').bind(nowSec(),await sha256Hex(token),nowSec()).first<{email:string}>();
  const u=row?await identity(c,row.email):null;if(!u)throw new AjError('Login-linket er ugyldigt eller udløbet.',401);
  const raw=randomToken(32);
  await c.env.DB.prepare('INSERT INTO aj_sessions(token_hash,email,expires_at) VALUES(?,?,?)').bind(await sha256Hex(raw),u.email,nowSec()+sessionSeconds).run();
  setCookie(c,cookieName(c),raw,{path:'/',secure:new URL(c.req.url).protocol==='https:',httpOnly:true,sameSite:'Strict',maxAge:sessionSeconds});
  return c.json({ok:true,user:u});
});
api.get('/admin/session',async c=>{const u=await user(c);return c.json({authenticated:!!u,user:u,mailConfigured:!!c.env.RESEND_API_KEY});});
api.use('/admin/cars/*',async(c,next)=>{await requireUser(c);await next();});
api.get('/admin/cars',async c=>c.json({cars:await adminCars(c.env.DB)}));
api.post('/admin/cars',async c=>c.json(await saveCar(c.env.DB,await body(c))));
api.post('/admin/cars/:id/photos',async c=>{
  const data=await body(c);
  return c.json(await addCarPhoto(c.env.DB,carId(c.req.param('id')),data.data),201);
});
api.get('/admin/cars/:id/photos/:photoId',async c=>{
  const photo=await c.env.DB.prepare('SELECT data FROM aj_car_photos WHERE car_id=? AND id=?')
    .bind(carId(c.req.param('id')),carId(c.req.param('photoId'))).first<{data:ArrayBuffer}>();
  if(!photo)throw new AjError('Billedet findes ikke.',404);
  return c.body(new Uint8Array(photo.data),200,{'Content-Type':'image/jpeg','Cache-Control':'private, no-store'});
});
api.post('/admin/cars/:id/photos/:photoId/remove',async c=>{
  await c.env.DB.prepare('DELETE FROM aj_car_photos WHERE car_id=? AND id=?')
    .bind(carId(c.req.param('id')),carId(c.req.param('photoId'))).run();
  return c.json({ok:true});
});
api.post('/admin/logout',async c=>{
  const raw=getCookie(c,cookieName(c));if(raw)await c.env.DB.prepare('DELETE FROM aj_sessions WHERE token_hash=?').bind(await sha256Hex(raw)).run();
  deleteCookie(c,cookieName(c),{path:'/',secure:new URL(c.req.url).protocol==='https:'});return c.json({ok:true});
});
api.get('/admin/data',async c=>{
  const u=await requireUser(c),own=u.role==='staff'?u.staffId!:undefined;
  const [settings,services,staff,hours,blocks,bookings]=await Promise.all([getSettings(c.env.DB),getServices(c.env.DB),getStaff(c.env.DB),getHours(c.env.DB),getBlocks(c.env.DB,own),listBookings(c.env.DB,own)]);
  const messages=own?[]:(await c.env.DB.prepare('SELECT id,name,email,phone,message,created_at AS createdAt FROM aj_messages ORDER BY created_at DESC LIMIT 200').all()).results;
  const outbox=own?[]:(await c.env.DB.prepare('SELECT id,booking_id AS bookingId,event,recipient_kind AS recipientKind,status,attempts,last_error AS lastError,created_at AS createdAt,sent_at AS sentAt FROM aj_outbox ORDER BY created_at DESC LIMIT 200').all()).results;
  return c.json({user:u,settings,services,staff:own?staff.filter(s=>s.id===own):staff,hours:own?hours.filter(h=>h.staffId===own):hours,blocks,bookings,messages,outbox,readiness:await readiness(c.env,settings)});
});
api.post('/admin/settings',async c=>{
  await requireUser(c,true);const b=await body(c),current=await getSettings(c.env.DB);
  const workshopEmail=b.workshopEmail===undefined?current.workshopEmail:b.workshopEmail===''?'':email(b.workshopEmail);
  const bookingEnabled=bool(b.bookingEnabled,current.bookingEnabled);let campaign:Campaign=current.campaign;
  if(b.campaign!==undefined){
    if(!b.campaign||typeof b.campaign!=='object'||Array.isArray(b.campaign))throw new AjError('Kontrollér kampagnen.');
    const v=b.campaign as Record<string,unknown>;
    const expiresOn=v.expiresOn===null||v.expiresOn===''?null:v.expiresOn===undefined?campaign.expiresOn:str(v.expiresOn,10);
    if(expiresOn!==null&&!validDate(expiresOn))throw new AjError('Vælg en gyldig udløbsdato.');
    const priceOre=v.priceOre===undefined?campaign.priceOre:Number(v.priceOre);
    if(!Number.isSafeInteger(priceOre)||priceOre<0||priceOre>100000000)throw new AjError('Indtast en gyldig kampagnepris i øre.');
    campaign={enabled:bool(v.enabled,campaign.enabled),confirmed:bool(v.confirmed,campaign.confirmed),title:v.title===undefined?campaign.title:str(v.title,160,true),priceOre,expiresOn};
    if(campaign.enabled&&(!campaign.confirmed||!campaign.expiresOn||campaign.expiresOn<zonedParts(nowSec()).date))throw new AjError('Bekræft kampagnens gyldighed, og angiv en fremtidig udløbsdato, før den vises.');
  }
  const settings:Settings={workshopEmail,bookingEnabled,campaign};
  await c.env.DB.prepare('UPDATE aj_settings SET workshop_email=?,booking_enabled=?,campaign_json=?,updated_at=? WHERE id=1').bind(workshopEmail,bookingEnabled?1:0,JSON.stringify(campaign),nowSec()).run();
  return c.json({ok:true,settings,readiness:await readiness(c.env,settings)});
});
api.post('/admin/services',async c=>{
  await requireUser(c,true);const b=await body(c),serviceId=b.id?id(b.id):null;
  const current=serviceId?(await getServices(c.env.DB)).find(s=>s.id===serviceId):null;if(serviceId&&!current)throw new AjError('Ydelsen findes ikke.',404);
  const name=b.name===undefined&&current?current.name:str(b.name,100,true),description=b.description===undefined&&current?current.description:str(b.description,1500);
  const durationMinutes=b.durationMinutes===undefined&&current?current.durationMinutes:b.durationMinutes===null||b.durationMinutes===''?null:Number(b.durationMinutes);
  if(durationMinutes!==null&&(!Number.isInteger(durationMinutes)||durationMinutes<15||durationMinutes>480||durationMinutes%5!==0))throw new AjError('Varigheden skal være 15–480 minutter i intervaller på 5 minutter.');
  const active=bool(b.active,current?.active??false);if(active&&!durationMinutes)throw new AjError('Bekræft ydelsens varighed, før den aktiveres.');
  const row=serviceId?await c.env.DB.prepare('UPDATE aj_services SET name=?,description=?,duration_minutes=?,active=? WHERE id=? RETURNING id').bind(name,description,durationMinutes,active?1:0,serviceId).first<{id:number}>():await c.env.DB.prepare('INSERT INTO aj_services(name,description,duration_minutes,active) VALUES(?,?,?,?) RETURNING id').bind(name,description,durationMinutes,active?1:0).first<{id:number}>();
  return c.json({ok:true,id:row!.id,service:{id:row!.id,name,description,durationMinutes,active}});
});
api.post('/admin/staff',async c=>{
  const u=await requireUser(c,true),b=await body(c),staffId=b.id?id(b.id):null;
  const current=staffId?(await getStaff(c.env.DB)).find(s=>s.id===staffId):null;if(staffId&&!current)throw new AjError('Medarbejderen findes ikke.',404);
  const name=b.name===undefined&&current?current.name:str(b.name,100,true);
  const role=b.role===undefined&&current?current.role:b.role;if(role!=='owner'&&role!=='staff')throw new AjError('Vælg ejer eller medarbejder.');
  const suppliedEmail=b.email===undefined?current?.email:b.email;
  const address=current?.email===''&&role==='staff'&&suppliedEmail===''?'':email(suppliedEmail);
  const active=bool(b.active,current?.active??true);
  if(u.staffId===staffId&&!active)throw new AjError('Du kan ikke deaktivere din egen adgang.');
  const row=staffId?await c.env.DB.prepare('UPDATE aj_staff SET name=?,email=?,role=?,active=?,calendar_token_hash=CASE WHEN active<>? OR email<>? THEN NULL ELSE calendar_token_hash END WHERE id=? RETURNING id').bind(name,address,role,active?1:0,active?1:0,address,staffId).first<{id:number}>():await c.env.DB.prepare('INSERT INTO aj_staff(name,email,role,active) VALUES(?,?,?,?) RETURNING id').bind(name,address,role,active?1:0).first<{id:number}>();
  if(current&&current.email!==address)await c.env.DB.prepare('DELETE FROM aj_sessions WHERE email=?').bind(current.email).run();
  return c.json({ok:true,id:row!.id,staff:{id:row!.id,name,email:address,role,active}});
});
api.post('/admin/hours',async c=>{
  const u=await requireUser(c),b=await body(c),hourId=b.id?id(b.id):null;
  const current=hourId?await c.env.DB.prepare('SELECT staff_id FROM aj_hours WHERE id=?').bind(hourId).first<{staff_id:number}>():null;
  if(hourId&&!current)throw new AjError('Åbningstiden findes ikke.',404);
  if(current)requireCalendar(u,current.staff_id);
  if(b.delete===true){if(!hourId)throw new AjError('Vælg en åbningstid.');await c.env.DB.prepare('DELETE FROM aj_hours WHERE id=?').bind(hourId).run();return c.json({ok:true});}
  const staffId=id(b.staffId);requireCalendar(u,staffId);
  const weekday=Number(b.weekday),start=timeMinute(b.startTime),end=b.endTime==='24:00'?1440:timeMinute(b.endTime);
  if(!Number.isInteger(weekday)||weekday<1||weekday>7||end<=start)throw new AjError('Kontrollér ugedag og åbningstid.');
  if(!(await getStaff(c.env.DB)).some(s=>s.id===staffId&&s.active))throw new AjError('Vælg en aktiv medarbejder.');
  const row=hourId?await c.env.DB.prepare('UPDATE aj_hours SET staff_id=?,weekday=?,start_minute=?,end_minute=? WHERE id=? RETURNING id').bind(staffId,weekday,start,end,hourId).first<{id:number}>():await c.env.DB.prepare('INSERT INTO aj_hours(staff_id,weekday,start_minute,end_minute) VALUES(?,?,?,?) RETURNING id').bind(staffId,weekday,start,end).first<{id:number}>();
  return c.json({ok:true,id:row!.id});
});
api.post('/admin/blocks',async c=>{
  const u=await requireUser(c),b=await body(c),blockId=b.id?id(b.id):null;
  const current=blockId?await c.env.DB.prepare('SELECT staff_id FROM aj_blocks WHERE id=?').bind(blockId).first<{staff_id:number}>():null;
  if(blockId&&!current)throw new AjError('Blokeringen findes ikke.',404);if(current)requireCalendar(u,current.staff_id);
  if(b.delete===true){if(!blockId)throw new AjError('Vælg en blokering.');await c.env.DB.prepare('DELETE FROM aj_blocks WHERE id=?').bind(blockId).run();return c.json({ok:true});}
  const staffId=id(b.staffId);requireCalendar(u,staffId);const start=parseInstant(b.startAt),end=parseInstant(b.endAt),reason=str(b.reason,300);
  if(end<=start||end-start>366*86400)throw new AjError('Vælg en gyldig start og slutning på blokeringen.');
  if(!(await getStaff(c.env.DB)).some(s=>s.id===staffId&&s.active))throw new AjError('Vælg en aktiv medarbejder.');
  const row=blockId?await c.env.DB.prepare('UPDATE aj_blocks SET staff_id=?,start_at=?,end_at=?,reason=? WHERE id=? RETURNING id').bind(staffId,start,end,reason,blockId).first<{id:number}>():await c.env.DB.prepare('INSERT INTO aj_blocks(staff_id,start_at,end_at,reason) VALUES(?,?,?,?) RETURNING id').bind(staffId,start,end,reason).first<{id:number}>();
  return c.json({ok:true,id:row!.id});
});
api.post('/admin/bookings/:id/reschedule',async c=>{const {u,b:booking}=await authorizedBooking(c,c.req.param('id')),b=await body(c),staffId=id(b.staffId);requireCalendar(u,staffId);return c.json(await rescheduleBooking(c.env,booking,str(b.startAt,40,true),staffId,origin(c)));});
api.post('/admin/bookings/:id/cancel',async c=>{const {b}=await authorizedBooking(c,c.req.param('id'));return c.json(await cancelBooking(c.env,b,origin(c)));});
api.post('/admin/calendar',async c=>{
  const u=await requireUser(c),b=await body(c),staffId=id(b.staffId);requireCalendar(u,staffId);
  if(!(await getStaff(c.env.DB)).some(s=>s.id===staffId&&s.active))throw new AjError('Vælg en aktiv medarbejder.');
  const token=randomToken(32);await c.env.DB.prepare('UPDATE aj_staff SET calendar_token_hash=? WHERE id=?').bind(await sha256Hex(token),staffId).run();
  return c.json({ok:true,url:`${origin(c)}/api/calendar.ics?token=${token}`,message:'Kalenderen viser aftaler. Ændringer foretages i bookingsystemet. Det tidligere kalenderlink er nu ugyldigt.'});
});
api.get('/calendar.ics',async c=>{
  const token=c.req.query('token')||'';if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw new AjError('Kalenderlinket er ugyldigt.',404);
  const staff=await c.env.DB.prepare('SELECT id,name FROM aj_staff WHERE calendar_token_hash=? AND active=1').bind(await sha256Hex(token)).first<{id:number;name:string}>();
  if(!staff)throw new AjError('Kalenderlinket er ugyldigt.',404);
  const bookings=(await listBookings(c.env.DB,staff.id)).filter(b=>parseInstant(b.endAt)>nowSec()-30*86400);
  return c.body(calendarIcs(bookings,staff.name),200,{'Content-Type':'text/calendar; charset=utf-8','Content-Disposition':'inline; filename="aj-auto.ics"','Cache-Control':'private, no-store'});
});
api.post('/admin/retry-mail',async c=>{
  await requireUser(c,true);await c.env.DB.prepare("UPDATE aj_outbox SET next_attempt_at=0 WHERE status IN ('failed','not_configured')").run();await deliverAjMail(c.env);return c.json({ok:true});
});
export default api;
