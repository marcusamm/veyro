import { PlanValidationError, isSameOriginWrite, readPlanUpdate, validatePlanUpdate } from '../app/lib/plan-validation';
import { hashPassword, randomToken, sha256, verifyPassword } from './password';
import { factoryApi } from './factory';
import { worldApi, worldIngest } from './world';

export interface Env { DB: D1Database; ASSETS: Fetcher; APP_URL?: string; BOOTSTRAP_TOKEN_HASH?: string; BOOTSTRAP_EXPIRES_AT?: string }
export type User = { id: string; username: string; displayName: string; role: 'admin' | 'player'; active: boolean };
type UserRow = { id:string; username:string; display_name:string; role:'admin'|'player'; active:number; password_hash:string; auth_version:number };
type PlanRow = { data:string; revision:number; updated_at:string|null };
const emptyPlan = {workspace:{name:'Our factory',playerA:'Pioneer A',playerB:'Pioneer B'},documents:[]};
const PDF_NAMES = new Set(['Satisfactory_Mega_Factory_Checklist.pdf','Satisfactory_Connected_Recipe_Plan.pdf']);
const MAX_PDF_BYTES=1_000_000;
const SESSION_AGE = 7 * 24 * 60 * 60;
const LOGIN_WINDOW = 15 * 60;
const json = (body:unknown, status=200, extra:HeadersInit={}) => Response.json(body,{status,headers:{'Cache-Control':'private, no-store','Vary':'Cookie',...extra}});
const safeUser = (u:UserRow):User => ({id:u.id,username:u.username,displayName:u.display_name,role:u.role,active:u.active===1});
const admin = (u:UserRow) => u.role === 'admin' && u.username === 'marcus';
const local = (request:Request) => new URL(request.url).protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(new URL(request.url).hostname);
const cookieName = (request:Request) => local(request) ? 'factory_session_dev' : '__Host-factory_session';
function sessionCookie(request:Request, token:string, age=SESSION_AGE) {
  return `${cookieName(request)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${local(request)?'':'; Secure'}`;
}
function cookieToken(request:Request):string|null {
  const prefix=cookieName(request)+'=';
  const parts=(request.headers.get('cookie')||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(prefix));
  if(parts.length!==1)return null;
  const token=parts[0].slice(prefix.length);
  return /^[0-9a-f]{64}$/.test(token)?token:null;
}
async function signedIn(request:Request,env:Env):Promise<UserRow|null> {
  const token=cookieToken(request);if(!token)return null;
  return env.DB.prepare(`SELECT u.* FROM factory_sessions s JOIN factory_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1 AND s.auth_version=u.auth_version`).bind(await sha256(token),Math.floor(Date.now()/1000)).first<UserRow>();
}
async function players(env:Env):Promise<User[]> {
  const result=await env.DB.prepare('SELECT id,username,display_name,role,active FROM factory_users ORDER BY CASE WHEN username=\'marcus\' THEN 0 ELSE 1 END, display_name COLLATE NOCASE').all<UserRow>();
  return result.results.map(safeUser);
}
async function withSession(request:Request,env:Env,user:UserRow,oldToken?:string|null):Promise<Response> {
  const token=randomToken(), now=Math.floor(Date.now()/1000);
  // An auth-version check makes a simultaneous password reset invalidate this login too.
  const insert=env.DB.prepare('INSERT INTO factory_sessions(token_hash,user_id,expires_at,created_at,auth_version) SELECT ?,id,?,?,auth_version FROM factory_users WHERE id=? AND active=1 AND auth_version=? AND password_hash=?').bind(await sha256(token),now+SESSION_AGE,now,user.id,user.auth_version,user.password_hash);
  if(oldToken)await env.DB.prepare('DELETE FROM factory_sessions WHERE token_hash=?').bind(await sha256(oldToken)).run();
  const result=await insert.run();
  if(result.meta.changes!==1)return json({error:'Your account changed. Sign in again.'},401);
  return json({user:safeUser(user),players:await players(env)},200,{'Set-Cookie':sessionCookie(request,token)});
}
async function limitedBody(request:Request):Promise<Record<string,unknown>> {
  if(!(request.headers.get('content-type')||'').toLowerCase().startsWith('application/json'))throw new PlanValidationError('Send JSON.');
  if(Number(request.headers.get('content-length'))>8192)throw new PlanValidationError('Request is too large.');
  const reader=request.body?.getReader();if(!reader)throw new PlanValidationError('Request is empty.');
  const chunks:Uint8Array[]=[];let length=0;
  try{while(true){const {value,done}=await reader.read();if(done)break;length+=value.byteLength;if(length>8192){await reader.cancel();throw new PlanValidationError('Request is too large.');}chunks.push(value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.byteLength;}
  let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new PlanValidationError('Invalid JSON.');}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new PlanValidationError('An object is required.');return value;
}
function password(value:unknown):string {if(typeof value!=='string'||value.length<8||value.length>128)throw new PlanValidationError('Use a password with 8–128 characters.');return value;}
function username(value:unknown):string {const name=typeof value==='string'?value.trim().toLowerCase():'';if(!/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(name))throw new PlanValidationError('Use 3–32 letters, numbers, dots, hyphens or underscores for the username.');return name;}
function displayName(value:unknown):string {if(typeof value!=='string'||!value.trim()||value.trim().length>80)throw new PlanValidationError('Use a display name with 1–80 characters.');return value.trim();}
function allowedFields(body:Record<string,unknown>,allowed:string[]){if(Object.keys(body).some(k=>!allowed.includes(k)))throw new PlanValidationError('The request contains unsupported fields.');}
async function loginAllowed(env:Env,request:Request,name:string):Promise<boolean>{
  const now=Math.floor(Date.now()/1000),ip=request.headers.get('CF-Connecting-IP')||(local(request)?'loopback':'unknown');
  const keys=await Promise.all([sha256('user:'+name),sha256('ip:'+ip)]);
  const results=await env.DB.batch(keys.map(key=>env.DB.prepare(`INSERT INTO factory_login_limits(bucket,attempts,resets_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET attempts=CASE WHEN resets_at<=? THEN 1 ELSE attempts+1 END,resets_at=CASE WHEN resets_at<=? THEN excluded.resets_at ELSE resets_at END RETURNING attempts`).bind(key,now+LOGIN_WINDOW,now,now)));
  return Number((results[0].results[0] as {attempts:number}).attempts)<=8 && Number((results[1].results[0] as {attempts:number}).attempts)<=40;
}
function audit(env:Env,actor:string,action:string,target:string){return env.DB.prepare('INSERT INTO factory_audit(id,actor_id,action,target_id,created_at) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),actor,action,target,new Date().toISOString());}
async function getPlan(env:Env):Promise<PlanRow>{
  let row=await env.DB.prepare('SELECT data,revision,updated_at FROM factory_plans WHERE id=1').first<PlanRow>();
  if(!row){await env.DB.prepare('INSERT INTO factory_plans(id,data,revision) VALUES(1,?,0) ON CONFLICT(id) DO NOTHING').bind(JSON.stringify(emptyPlan)).run();row=await env.DB.prepare('SELECT data,revision,updated_at FROM factory_plans WHERE id=1').first<PlanRow>();}
  if(!row)throw new Error('Plan initialization failed');return row;
}
const planReply=(row:PlanRow)=>({data:JSON.parse(row.data),revision:row.revision,updatedAt:row.updated_at});

async function api(request:Request,env:Env):Promise<Response>{
  const path=new URL(request.url).pathname, method=request.method;
  // The bridge authenticates using its own ingest-only token, never a player cookie.
  // Keep this exception exact; every other write retains the browser Origin check.
  if(path==='/api/world/ingest')return worldIngest(request,env.DB);
  if(!['GET','HEAD'].includes(method)&&!isSameOriginWrite(request))return json({error:'Use this website to make changes.'},403);
  if(path==='/api/setup'&&method==='POST'){
    const expiry=Date.parse(env.BOOTSTRAP_EXPIRES_AT||''),now=Date.now(),expected=env.BOOTSTRAP_TOKEN_HASH||'';
    const authorization=request.headers.get('authorization')||'';
    const token=/^Bearer [a-f0-9]{64}$/.test(authorization)?authorization.slice(7):'';
    if(!Number.isFinite(expiry)||expiry<=now||expiry>now+60*60*1000||!/^[a-f0-9]{64}$/.test(expected)||token.length!==64)return json({error:'Setup is unavailable.'},404);
    const actual=await sha256(token);let difference=0;for(let i=0;i<64;i++)difference|=actual.charCodeAt(i)^expected.charCodeAt(i);
    if(difference)return json({error:'Setup is unavailable.'},404);
    if(await env.DB.prepare("SELECT id FROM factory_users WHERE username='marcus'").first())return json({error:'Setup has already been completed.'},409);
    if(!await loginAllowed(env,request,'bootstrap'))return json({error:'Try again later.'},429,{'Retry-After':String(LOGIN_WINDOW)});
    const body=await limitedBody(request);allowedFields(body,['password']);const hash=await hashPassword(password(body.password)),id=crypto.randomUUID(),created=new Date().toISOString();
    const added=await env.DB.prepare("INSERT INTO factory_users(id,username,display_name,password_hash,role,active,created_at,updated_at) VALUES(?,'marcus','Marcus',?,'admin',1,?,?) ON CONFLICT(username) DO NOTHING").bind(id,hash,created,created).run();
    if(added.meta.changes!==1)return json({error:'Setup has already been completed.'},409);
    return json({user:{id,username:'marcus',displayName:'Marcus',role:'admin',active:true}},201);
  }
  if(path==='/api/auth/login'&&method==='POST'){
    const body=await limitedBody(request);allowedFields(body,['username','password']);
    // Invalid credentials and nonexistent accounts deliberately have the same response.
    const name=typeof body.username==='string'?body.username.trim().toLowerCase().slice(0,128):'';
    const pass=typeof body.password==='string'&&body.password.length<=128?body.password:'';
    if(!await loginAllowed(env,request,name))return json({error:'Too many sign-in attempts. Try again in 15 minutes.'},429,{'Retry-After':String(LOGIN_WINDOW)});
    const user=await env.DB.prepare('SELECT * FROM factory_users WHERE username=?').bind(name).first<UserRow>();
    const valid=user?await verifyPassword(pass,user.password_hash):(await hashPassword(pass),false);
    if(!user||!user.active||!valid)return json({error:'Incorrect username or password.'},401);
    return withSession(request,env,user,cookieToken(request));
  }
  const user=await signedIn(request,env);
  if(path==='/api/auth/logout'&&method==='POST'){
    const token=cookieToken(request);if(token)await env.DB.prepare('DELETE FROM factory_sessions WHERE token_hash=?').bind(await sha256(token)).run();
    return json({ok:true},200,{'Set-Cookie':sessionCookie(request,'',0)});
  }
  if(!user)return json({error:'Sign in to use your factory plan.'},401);
  if(path==='/api/factory')return factoryApi(request,env.DB,user.id);
  if(['/api/world','/api/world/plan','/api/world/connection'].includes(path))return worldApi(request,env.DB,user);
  if(path==='/api/auth/me'&&method==='GET')return json({user:safeUser(user),players:await players(env)});
  if(path==='/api/auth/password'&&method==='POST'){
    const body=await limitedBody(request);allowedFields(body,['currentPassword','newPassword']);const next=password(body.newPassword);
    if(!await loginAllowed(env,request,'password:'+user.id))return json({error:'Too many attempts. Try again in 15 minutes.'},429,{'Retry-After':String(LOGIN_WINDOW)});
    if(typeof body.currentPassword!=='string'||body.currentPassword.length>128||!await verifyPassword(body.currentPassword,user.password_hash))return json({error:'Your current password is incorrect.'},400);
    const hash=await hashPassword(next),now=new Date().toISOString();
    const changed=await env.DB.batch([
      env.DB.prepare('UPDATE factory_users SET password_hash=?,auth_version=auth_version+1,updated_at=? WHERE id=? AND auth_version=?').bind(hash,now,user.id,user.auth_version),
      env.DB.prepare('DELETE FROM factory_sessions WHERE user_id=?').bind(user.id),audit(env,user.id,'password_changed',user.id)
    ]);
    if(changed[0].meta.changes!==1)return json({error:'Your account changed. Sign in again.'},409);
    return withSession(request,env,{...user,password_hash:hash,auth_version:user.auth_version+1});
  }
  if(path==='/api/players'&&method==='GET')return json({players:await players(env)});
  if(path==='/api/players'&&method==='POST'){
    if(!admin(user))return json({error:'Only Marcus can manage players.'},403);
    const body=await limitedBody(request);allowedFields(body,['username','displayName','password']);
    const name=username(body.username),label=displayName(body.displayName),pass=password(body.password);
    if(name==='marcus')return json({error:'That username is already in use.'},409);
    const existing=await env.DB.prepare('SELECT id FROM factory_users WHERE username=?').bind(name).first();if(existing)return json({error:'That username is already in use.'},409);
    const id=crypto.randomUUID(),now=new Date().toISOString(),hash=await hashPassword(pass);
    try{await env.DB.batch([env.DB.prepare("INSERT INTO factory_users(id,username,display_name,password_hash,role,active,created_at,updated_at) VALUES(?,?,?,?,'player',1,?,?)").bind(id,name,label,hash,now,now),audit(env,user.id,'player_created',id)]);}catch(error){if(String(error).includes('UNIQUE'))return json({error:'That username is already in use.'},409);throw error;}
    const player={id,username:name,displayName:label,role:'player',active:true};return json({player,players:await players(env)},201);
  }
  if(path.startsWith('/api/players/')&&method==='PATCH'){
    if(!admin(user))return json({error:'Only Marcus can manage players.'},403);
    const id=path.slice('/api/players/'.length),body=await limitedBody(request);allowedFields(body,['displayName','active','password']);
    const target=await env.DB.prepare('SELECT * FROM factory_users WHERE id=?').bind(id).first<UserRow>();if(!target)return json({error:'Player not found.'},404);
    if(target.username==='marcus'&&(body.active!==undefined||body.password!==undefined))return json({error:'Marcus remains administrator. Change your own password in account settings.'},400);
    if(!Object.keys(body).length)throw new PlanValidationError('Choose a change to apply.');
    if(body.active!==undefined&&typeof body.active!=='boolean')throw new PlanValidationError('Active must be true or false.');
    // Only update fields explicitly supplied. A concurrent rename must never restore
    // a password or active state read before another request changed it.
    const columns:string[]=[],values:(string|number)[]=[];
    if(body.displayName!==undefined){columns.push('display_name=?');values.push(displayName(body.displayName));}
    if(body.active!==undefined){columns.push('active=?');values.push(body.active?1:0);}
    if(body.password!==undefined){columns.push('password_hash=?');values.push(await hashPassword(password(body.password)));}
    const invalidate=body.password!==undefined||body.active!==undefined;
    if(invalidate)columns.push('auth_version=auth_version+1');
    columns.push('updated_at=?');values.push(new Date().toISOString(),id);
    const statements=[env.DB.prepare(`UPDATE factory_users SET ${columns.join(',')} WHERE id=?`).bind(...values)];
    if(invalidate)statements.push(env.DB.prepare('DELETE FROM factory_sessions WHERE user_id=?').bind(id));
    statements.push(audit(env,user.id,body.password!==undefined?'player_password_reset':body.active!==undefined?(body.active?'player_enabled':'player_disabled'):'player_updated',id));await env.DB.batch(statements);
    const updated=await env.DB.prepare('SELECT * FROM factory_users WHERE id=?').bind(id).first<UserRow>();
    return json({player:updated?safeUser(updated):null,players:await players(env)});
  }
  if(path.startsWith('/api/documents/')&&method==='PUT'){
    if(!admin(user))return json({error:'Only Marcus can upload original documents.'},403);
    const name=decodeURIComponent(path.slice('/api/documents/'.length));if(!PDF_NAMES.has(name))return json({error:'Unknown original document.'},404);
    if(!(request.headers.get('content-type')||'').toLowerCase().startsWith('application/pdf'))throw new PlanValidationError('Upload a PDF file.');
    if(Number(request.headers.get('content-length'))>MAX_PDF_BYTES)throw new PlanValidationError('The PDF is too large.');
    const reader=request.body?.getReader();if(!reader)throw new PlanValidationError('The PDF is empty.');
    const chunks:Uint8Array[]=[];let length=0;
    try{while(true){const {value,done}=await reader.read();if(done)break;length+=value.byteLength;if(length>MAX_PDF_BYTES){await reader.cancel();throw new PlanValidationError('The PDF is too large.');}chunks.push(value);}}finally{reader.releaseLock();}
    const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    if(new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-')throw new PlanValidationError('The file is not a PDF.');
    await env.DB.prepare("INSERT INTO private_documents(name,content,mime,updated_at) VALUES(?,?,'application/pdf',?) ON CONFLICT(name) DO UPDATE SET content=excluded.content,mime=excluded.mime,updated_at=excluded.updated_at").bind(name,bytes.buffer,new Date().toISOString()).run();
    return json({name,size:length},201);
  }
  if(path==='/api/plan'&&method==='GET')return json(planReply(await getPlan(env)));
  if(path==='/api/plan'&&method==='PUT'){
    const {data,revision}=validatePlanUpdate(await readPlanUpdate(request));
    const known=new Set(['unassigned','a','b',...(await players(env)).map(p=>p.id)]);
    for(const d of data.documents)for(const p of d.pages)for(const b of p.blocks)if(b.type==='check'&&!known.has(b.assignee))throw new PlanValidationError('A task is assigned to a player who does not exist.');
    await getPlan(env);const row=await env.DB.prepare('UPDATE factory_plans SET data=?,revision=revision+1,updated_at=?,updated_by=? WHERE id=1 AND revision=? RETURNING data,revision,updated_at').bind(JSON.stringify(data),new Date().toISOString(),user.id,revision).first<PlanRow>();
    if(!row)return json({error:'This plan changed in another session. Download your draft, then load the latest plan.',code:'revision_conflict'},409);
    return json(planReply(row));
  }
  return json({error:'Not found.'},404);
}
function secure(response:Response):Response{
  const headers=new Headers(response.headers);
  headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','same-origin');headers.set('X-Frame-Options','DENY');headers.set('X-Robots-Tag','noindex, nofollow, noarchive');
  headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'");
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}
export default {
  async fetch(request:Request,env:Env):Promise<Response>{
    const url=new URL(request.url);
    if(url.protocol!=='https:'&&!local(request)){url.protocol='https:';return secure(Response.redirect(url.toString(),308));}
    try{
      if(url.pathname.startsWith('/api/'))return secure(await api(request,env));
      if(request.method!=='GET'&&request.method!=='HEAD')return secure(json({error:'Method not allowed.'},405));
      const decodedPath=decodeURIComponent(url.pathname);
      if(decodedPath.startsWith('/documents/')){
        if(!await signedIn(request,env))return secure(json({error:'Sign in to view these documents.'},401));
        const name=decodedPath.slice('/documents/'.length);if(!PDF_NAMES.has(name))return secure(json({error:'Document not found.'},404));
        const row=await env.DB.prepare('SELECT content,mime FROM private_documents WHERE name=?').bind(name).first<{content:ArrayBuffer|number[];mime:string}>();
        if(!row)return secure(json({error:'Document not found.'},404));
        const bytes=new Uint8Array(row.content as ArrayBuffer);
        return secure(new Response(request.method==='HEAD'?null:bytes,{headers:{'Content-Type':'application/pdf','Cache-Control':'private, no-store','Vary':'Cookie','Content-Disposition':`inline; filename="${name}"`}}));
      }
      const response=await env.ASSETS.fetch(request);
      if((response.headers.get('content-type')||'').includes('text/html')){const h=new Headers(response.headers);h.set('Cache-Control','no-store');return secure(new Response(response.body,{status:response.status,headers:h}));}
      return secure(response);
    }catch(error){
      if(error instanceof PlanValidationError)return secure(json({error:error.message},400));
      console.error('Factory request failed',error instanceof Error?error.name:'UnknownError');
      return secure(json({error:'The request could not be completed. Please try again.'},503));
    }
  },
  async scheduled(_event:ScheduledController,env:Env):Promise<void>{
    const now=Math.floor(Date.now()/1000);await env.DB.batch([env.DB.prepare('DELETE FROM factory_sessions WHERE expires_at<=?').bind(now),env.DB.prepare('DELETE FROM factory_login_limits WHERE resets_at<=?').bind(now)]);
  }
};
