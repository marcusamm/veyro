import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { hashPassword, sha256, verifyPassword } from '../server/password.ts';
const root = new URL('../', import.meta.url);
const bundled = await build({entryPoints:[fileURLToPath(new URL('server/index.ts',root))],bundle:true,write:false,format:'esm',platform:'neutral',target:'es2022'});
const code=bundled.outputFiles[0].text;
const worker=(await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)).default;
const migration=(await Promise.all(['0001_factory_auth.sql','0002_factory_layout.sql'].map(name=>readFile(new URL('migrations/'+name,root),'utf8')))).join('\n');
const adminId='00000000-0000-4000-8000-000000000001',adminPass='test-admin-pass-only';
const adminHash=await hashPassword(adminPass);
let sqlite,env;
class Statement {
  constructor(sql,params=[]){this.sql=sql;this.params=params;}
  bind(...args){return new Statement(this.sql,args.map(v=>v instanceof ArrayBuffer?new Uint8Array(v):v));}
  execute(){const rows=sqlite.prepare(this.sql).all(...this.params);return{success:true,results:rows,meta:{changes:sqlite.prepare('SELECT changes() n').get().n}};}
  async run(){return this.execute();}
  async all(){return this.execute();}
  async first(column){const row=this.execute().results[0];return row?(column?row[column]:row):null;}
}
beforeEach(()=>{
  sqlite=new DatabaseSync(':memory:');sqlite.exec(migration);
  sqlite.prepare('INSERT INTO factory_users(id,username,display_name,password_hash,role,active,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)').run(adminId,'marcus','Marcus',adminHash,'admin','test','test');
  env={DB:{prepare:(sql)=>new Statement(sql),batch:async statements=>{sqlite.exec('BEGIN');try{const results=statements.map(s=>s.execute());sqlite.exec('COMMIT');return results;}catch(e){sqlite.exec('ROLLBACK');throw e;}}},ASSETS:{fetch:async()=>new Response('<html>Login</html>',{headers:{'Content-Type':'text/html'}})}};
});
afterEach(()=>sqlite.close());
function req(path,method='GET',body,token,extra={}){const headers={...(['POST','PUT','PATCH'].includes(method)?{'Origin':'https://factory.test','Content-Type':'application/json'}:{}),...(token?{Cookie:`__Host-factory_session=${token}`}:{}) ,...extra};return new Request('https://factory.test'+path,{method,headers,...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});}
const call=(...args)=>worker.fetch(req(...args),env);
async function login(name='marcus',password=adminPass){const r=await call('/api/auth/login','POST',{username:name,password});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0].split('=')[1];}
const fixture=()=>({workspace:{name:'Test world',playerA:'A',playerB:'B'},documents:[{id:'doc',title:'Test',shortTitle:'Test',description:'Synthetic test data',pdfUrl:'/documents/Satisfactory_Mega_Factory_Checklist.pdf',pages:[{id:'page',number:1,title:'Test',subtitle:'',blocks:[{id:'task',type:'check',text:'Build a test foundation',checked:false,assignee:'unassigned'}]}]}]});
async function makePlayer(token){const r=await call('/api/players','POST',{username:'friend',displayName:'Friend',password:'friend-test-only'},token);assert.equal(r.status,201);return (await r.json()).player;}

const layoutFixture=()=>({version:1,name:'Synthetic test factory',nodes:[{id:'smelter',kind:'machine',x:0,y:0,rotation:0,recipeId:'Recipe_IngotIron_C',clock:150}],edges:[],settings:{recipeMultiplier:1,powerMultiplier:1}});
test('factory layout is shared by players, persists clocks, and protects concurrent drafts independently of documents',async()=>{
  const admin=await login(),player=await makePlayer(admin),friend=await login('friend','friend-test-only');
  const initial=await call('/api/factory','GET',undefined,admin),fresh=await initial.json();
  assert.equal(initial.headers.get('cache-control'),'private, no-store');
  assert.equal(fresh.revision,0);assert.deepEqual(fresh.data.nodes,[]);assert.deepEqual(fresh.data.settings,{recipeMultiplier:1,powerMultiplier:1});
  const data=layoutFixture();
  const saved=await call('/api/factory','PUT',{data,revision:0},friend);assert.equal(saved.status,200,await saved.clone().text());
  const result=await (await call('/api/factory','GET',undefined,admin)).json();
  assert.equal(result.data.nodes[0].clock,150);assert.equal(result.updatedBy,player.id);assert.equal(result.revision,1);
  assert.equal((await call('/api/factory','PUT',{data:{...data,name:'Stale draft'},revision:0},admin)).status,409);
  const after=await (await call('/api/factory','GET',undefined,friend)).json();assert.equal(after.data.name,data.name);assert.equal(after.revision,1);
  assert.equal((await call('/api/plan','PUT',{data:fixture(),revision:0},friend)).status,200);
  assert.deepEqual((await (await call('/api/factory','GET',undefined,admin)).json()).data,result.data);
  assert.equal((await (await call('/api/plan','GET',undefined,admin)).json()).data.documents[0].title,'Test');
});
test('factory API rejects invalid data, excess size, cross-origin writes and revoked sessions',async()=>{
  const admin=await login(),player=await makePlayer(admin),friend=await login('friend','friend-test-only'),valid=layoutFixture();
  for(const mutate of [d=>{d.nodes[0].clock=251;},d=>{d.nodes[0].recipeId='not-a-real-recipe';},d=>{d.nodes[0].x='NaN';},d=>{d.nodes.push({...d.nodes[0]});},d=>{d.settings.powerMultiplier=-1;}]){
    const data=structuredClone(valid);mutate(data);const response=await call('/api/factory','PUT',{data,revision:0},admin);assert.equal(response.status,400,await response.text());
  }
  assert.equal((await call('/api/factory','PUT',{data:valid,revision:-1},admin)).status,400);
  assert.equal((await call('/api/factory','PUT','x'.repeat(1_000_001),admin)).status,400);
  assert.equal((await call('/api/factory','PUT',{data:valid,revision:0},admin,{Origin:'https://other.test'})).status,403);
  assert.equal((await (await call('/api/factory','GET',undefined,admin)).json()).revision,0);
  await call('/api/players/'+player.id,'PATCH',{active:false},admin);
  assert.equal((await call('/api/factory','GET',undefined,friend)).status,401);
  assert.equal((await call('/api/factory','PUT',{data:valid,revision:0},friend)).status,401);
});

test('anonymous users cannot read plans, players or PDFs; cross-origin writes rejected',async()=>{
  for(const path of ['/api/plan','/api/factory','/api/auth/me','/api/players','/documents/Satisfactory_Mega_Factory_Checklist.pdf','/%64ocuments/Satisfactory_Mega_Factory_Checklist.pdf'])assert.equal((await call(path)).status,401,path);
  assert.equal((await call('/api/auth/login','POST',{username:'marcus',password:adminPass},null,{Origin:'https://evil.test'})).status,403);
  const r=await call('/');assert.equal(r.headers.get('x-robots-tag'),'noindex, nofollow, noarchive');
});
test('password hashing uses random salt, verifies correctly and sessions contain no stored plaintext',async()=>{
  const other=await hashPassword(adminPass);assert.notEqual(other,adminHash);assert.equal(await verifyPassword(adminPass,other),true);assert.equal(await verifyPassword('wrong',other),false);
  const r=await call('/api/auth/login','POST',{username:' MARCUS ',password:adminPass});assert.equal(r.status,200);const cookie=r.headers.get('set-cookie');assert.match(cookie,/__Host-factory_session=/);assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.match(cookie,/SameSite=Lax/);assert.doesNotMatch(cookie,/Domain=/);
  const token=cookie.split(';')[0].split('=')[1],row=sqlite.prepare('SELECT * FROM factory_sessions').get();assert.equal(row.token_hash,await sha256(token));assert.notEqual(row.token_hash,token);
  const payload=await r.json();assert.equal(payload.user.username,'marcus');assert.equal(payload.user.password_hash,undefined);
});
test('only Marcus can administer players, with a database constraint against extra admins',async()=>{
  const token=await login(),player=await makePlayer(token);assert.equal(player.role,'player');assert.equal(player.active,true);
  const friend=await login('friend','friend-test-only');assert.equal((await call('/api/players','POST',{username:'other',displayName:'Other',password:'other-test-only'},friend)).status,403);
  assert.equal((await call('/api/players/'+player.id,'PATCH',{active:false},friend)).status,403);
  assert.equal((await call('/api/players','POST',{username:'evil',displayName:'Evil',password:'evil-test-only',role:'admin'},token)).status,400);
  assert.equal((await call('/api/players/'+adminId,'PATCH',{active:false},token)).status,400);
  assert.throws(()=>sqlite.prepare("UPDATE factory_users SET role='admin' WHERE username='friend'").run(),/CHECK/);
  assert.throws(()=>sqlite.prepare("UPDATE factory_users SET role='player' WHERE username='marcus'").run(),/CHECK/);
});
test('player creation, rename, deactivation, reactivation and reset revoke appropriate sessions',async()=>{
  const admin=await login(),p=await makePlayer(admin),friend=await login('friend','friend-test-only');
  assert.equal((await call('/api/players/'+p.id,'PATCH',{displayName:'New name'},admin)).status,200);
  assert.equal((await (await call('/api/auth/me','GET',undefined,friend)).json()).user.displayName,'New name');
  await call('/api/players/'+p.id,'PATCH',{active:false},admin);assert.equal((await call('/api/auth/me','GET',undefined,friend)).status,401);assert.equal((await call('/api/auth/login','POST',{username:'friend',password:'friend-test-only'})).status,401);
  await call('/api/players/'+p.id,'PATCH',{active:true},admin);const again=await login('friend','friend-test-only');
  await call('/api/players/'+p.id,'PATCH',{password:'replacement-pass'},admin);assert.equal((await call('/api/auth/me','GET',undefined,again)).status,401);assert.equal((await call('/api/auth/login','POST',{username:'friend',password:'friend-test-only'})).status,401);await login('friend','replacement-pass');
});
test('own-password change requires current password and rotates all sessions; logout revokes cookie',async()=>{
  const first=await login(),second=await login();assert.equal((await call('/api/auth/password','POST',{currentPassword:'wrong',newPassword:'new-password-test'},first)).status,400);
  const r=await call('/api/auth/password','POST',{currentPassword:adminPass,newPassword:'new-password-test'},first);assert.equal(r.status,200);const next=r.headers.get('set-cookie').split(';')[0].split('=')[1];
  for(const token of [first,second])assert.equal((await call('/api/auth/me','GET',undefined,token)).status,401);
  assert.equal((await call('/api/auth/me','GET',undefined,next)).status,200);await call('/api/auth/logout','POST',{},next);assert.equal((await call('/api/auth/me','GET',undefined,next)).status,401);
});
test('login throttles incorrect account and IP attempts, and expired sessions fail',async()=>{
  const token=await login();sqlite.prepare('UPDATE factory_sessions SET expires_at=0').run();assert.equal((await call('/api/auth/me','GET',undefined,token)).status,401);
  for(let i=0;i<8;i++)assert.equal((await call('/api/auth/login','POST',{username:'missing',password:'bad'})).status,401);
  const blocked=await call('/api/auth/login','POST',{username:'missing',password:'bad'});assert.equal(blocked.status,429);assert.equal(blocked.headers.get('retry-after'),'900');
});
test('shared plan saves persist player IDs and reject stale revisions and unknown assignments',async()=>{
  const admin=await login(),p=await makePlayer(admin),friend=await login('friend','friend-test-only');
  const fresh=await (await call('/api/plan','GET',undefined,admin)).json();assert.deepEqual(fresh.data.documents,[]);
  const data=fixture();data.documents[0].pages[0].blocks[0].assignee=p.id;
  assert.equal((await call('/api/plan','PUT',{data,revision:0},friend)).status,200);
  const saved=await (await call('/api/plan','GET',undefined,admin)).json();assert.deepEqual(saved.data,data);assert.equal(saved.revision,1);
  assert.equal((await call('/api/plan','PUT',{data,revision:0},admin)).status,409);
  data.documents[0].pages[0].blocks[0].assignee='00000000-0000-4000-8000-000000000009';assert.equal((await call('/api/plan','PUT',{data,revision:1},admin)).status,400);
  assert.equal(sqlite.prepare('SELECT updated_by FROM factory_plans').get().updated_by,p.id);
});
test('PDF originals are uploaded only by Marcus and served only to signed-in players',async()=>{
  const admin=await login();await makePlayer(admin);const friend=await login('friend','friend-test-only'),name='Satisfactory_Mega_Factory_Checklist.pdf',pdf='%PDF-1.4\nsynthetic fixture';
  assert.equal((await call('/api/documents/'+name,'PUT',pdf,friend,{'Content-Type':'application/pdf'})).status,403);
  assert.equal((await call('/api/documents/'+name,'PUT',pdf,admin,{'Content-Type':'application/pdf'})).status,201);
  const r=await call('/documents/'+name,'GET',undefined,friend);assert.equal(r.status,200);assert.equal(await r.text(),pdf);assert.equal(r.headers.get('cache-control'),'private, no-store');
  assert.equal((await call('/api/documents/'+name,'PUT','not a pdf',admin,{'Content-Type':'application/pdf'})).status,400);
  assert.equal((await call('/api/documents/'+name,'PUT','%PDF-'+'.'.repeat(1_000_000),admin,{'Content-Type':'application/pdf'})).status,400);
});
test('bootstrap requires valid, expiring token and cannot overwrite Marcus',async()=>{
  const bootstrap='a'.repeat(64);env.BOOTSTRAP_TOKEN_HASH=await sha256(bootstrap);env.BOOTSTRAP_EXPIRES_AT=new Date(Date.now()+600000).toISOString();
  assert.equal((await call('/api/setup','POST',{password:'bootstrap-test-pass'},null,{Authorization:'Bearer '+bootstrap})).status,409);
  sqlite.prepare('DELETE FROM factory_users').run();
  assert.equal((await call('/api/setup','POST',{password:'bootstrap-test-pass'},null,{Authorization:'Bearer '+'b'.repeat(64)})).status,404);
  const r=await call('/api/setup','POST',{password:'bootstrap-test-pass'},null,{Authorization:'Bearer '+bootstrap});assert.equal(r.status,201);assert.equal((await r.json()).user.role,'admin');
  assert.equal((await call('/api/setup','POST',{password:'another-pass'},null,{Authorization:'Bearer '+bootstrap})).status,409);
  await login('marcus','bootstrap-test-pass');
  env.BOOTSTRAP_EXPIRES_AT=new Date(Date.now()-1000).toISOString();assert.equal((await call('/api/setup','POST',{password:'bootstrap-test-pass'},null,{Authorization:'Bearer '+bootstrap})).status,404);
});

test('a delayed rename cannot restore a concurrently changed password or reactivate a disabled player',async()=>{
  const admin=await login(),p=await makePlayer(admin),friend=await login('friend','friend-test-only');
  let release,notify;const ready=new Promise(resolve=>notify=resolve),gate=new Promise(resolve=>release=resolve),prepare=env.DB.prepare;
  let intercepted=false;
  env.DB.prepare=(sql)=>{
    const statement=prepare(sql);
    if(sql!== 'SELECT * FROM factory_users WHERE id=?')return statement;
    const originalBind=statement.bind.bind(statement);
    statement.bind=(...args)=>{
      const bound=originalBind(...args),first=bound.first.bind(bound);
      bound.first=async(...arg)=>{
        const row=await first(...arg);
        if(!intercepted){intercepted=true;notify();await gate;}
        return row;
      };return bound;
    };return statement;
  };
  const rename=call('/api/players/'+p.id,'PATCH',{displayName:'Renamed'},admin);
  await ready;
  assert.equal((await call('/api/auth/password','POST',{currentPassword:'friend-test-only',newPassword:'new-friend-password'},friend)).status,200);
  assert.equal((await call('/api/players/'+p.id,'PATCH',{active:false},admin)).status,200);
  release();assert.equal((await rename).status,200);
  const row=sqlite.prepare('SELECT * FROM factory_users WHERE id=?').get(p.id);
  assert.equal(row.display_name,'Renamed');assert.equal(row.active,0);assert.equal(await verifyPassword('new-friend-password',row.password_hash),true);assert.equal(await verifyPassword('friend-test-only',row.password_hash),false);
});
