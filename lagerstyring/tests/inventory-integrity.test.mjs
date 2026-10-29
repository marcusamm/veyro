import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stockPlan, suggestQty } from '../src/lib/stock.ts';
import { Tx, Duplicate, RaceConflict } from '../src/lib/ledger.ts';
import { closeJob, consumeDirect, getJob, getProduct, planMaterial, returnToStock } from '../src/lib/materials.ts';
import { receiveLine } from '../src/lib/purchasing.ts';
import { evaluateProducts } from '../src/lib/notices.ts';
import { syncStage } from '../src/lib/jobs.ts';
import { DEFAULT_SETTINGS } from '../src/lib/settings.ts';
import { ROOT, csrfFrom, login, startStack } from './harness.mjs';

const K = 1000;
const actor = { email: 'owner@test.example', name: 'Test Ejer' };
const base = { stock: 100*K, reserved: 0, whole_units: 1, avg_daily_usage: 10*K, lead_time_days: 5, safety_method: 'antal', safety_qty: 20*K, buffer_days: null, max_stock: null };

// Actual SQLite schema + transactions, exposed through the D1 methods used by
// the engine. Deterministic interleavings keep a transaction's read stale on
// purpose; the assertions inspect committed balances, history and notifications.
function database() {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync(path.join(ROOT,'migrations')).filter(f=>f.endsWith('.sql')).sort()) sql.exec(readFileSync(path.join(ROOT,'migrations',file),'utf8'));
  class Statement {
    constructor(query,args=[]){this.query=query;this.args=args;}
    bind(...args){return new Statement(this.query,args);}
    native(){return sql.prepare(this.query);}
    execute(){const r=this.native().run(...this.args);return { success:true, meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)} };}
    async run(){return this.execute();}
    async all(){return {success:true,results:this.native().all(...this.args)};}
    async first(column){const row=this.native().get(...this.args) ?? null;return column ? row?.[column] ?? null : row;}
  }
  const db={prepare:q=>new Statement(q),async batch(statements){sql.exec('BEGIN IMMEDIATE');try{const results=statements.map(s=>s.execute());sql.exec('COMMIT');return results;}catch(e){sql.exec('ROLLBACK');throw e;}},sql};
  sql.exec(`INSERT INTO users(email,name,role,alert_mail,created_at) VALUES ('owner@test.example','Test Ejer','ejer',1,1),('buyer@test.example','Test Indkøber','indkober',1,1),('staff@test.example','Test Medarbejder','medarbejder',1,1);
    INSERT INTO products(sku,name,unit,stock,safety_method,safety_qty,reorder_point,purchase_price,created_at,updated_at) VALUES('TEST-ONLY-1','Testvare – fiktiv','stk.',100000,'antal',10000,70000,1000,1,1);
    INSERT INTO jobs(number,name,created_at,updated_at) VALUES('TEST-ONLY-J1','Testjob – fiktivt',1,1);`);
  return db;
}
const row=(db,q)=>db.sql.prepare(q).get();
const balance=db=>row(db,'SELECT stock,reserved,purchase_price,purchase_price_source,purchase_price_at FROM products WHERE id=1');
const tx=(db,token)=>new Tx(db,actor,token,2_000_000_000);

function purchase(db) {
  db.sql.exec(`INSERT INTO purchase_lists(job_id,kind,name,created_at,updated_at) VALUES(1,'job','Testliste – fiktiv',1,1);
    INSERT INTO purchase_lines(list_id,job_id,product_id,sku,name,unit,qty,ordered,unit_price,created_at,updated_at) VALUES(1,1,1,'TEST-ONLY-1','Testvare – fiktiv','stk.',5000,5000,1000,1,1);`);
  return row(db,'SELECT * FROM purchase_lines WHERE id=1');
}

describe('Lagergrænser uden dobbelttælling',()=>{
  it('beregner leveringstidsforbrug plus sikkerhedslager én gang',()=>{
    expect(stockPlan(base)).toMatchObject({rop:70*K,suggestedRop:70*K,ropSource:'beregnet',safety:20*K,status:'normal'});
    expect(stockPlan({...base,reorder_point:65*K})).toMatchObject({rop:65*K,suggestedRop:70*K,ropSource:'manuel'});
  });
  it('bruger et manuelt punkt uden forbrugs- eller leveringstidsdata',()=>{
    const p={...base,stock:50*K,reorder_point:50*K,avg_daily_usage:null,lead_time_days:null};
    const plan=stockPlan(p);expect(plan).toMatchObject({rop:50*K,suggestedRop:null,ropSource:'manuel',status:'genbestil'});
    expect(suggestQty(p,plan,0)).toBe(0);
  });
  it('advarer særskilt om sikkerhedslager selv om genbestillingsdata mangler',()=>{
    expect(stockPlan({...base,stock:20*K,avg_daily_usage:null,lead_time_days:null})).toMatchObject({rop:null,safety:20*K,status:'kritisk'});
  });
});

describe('Atomisk lagerintegritet med produktionsskemaet',()=>{
  it('bogfører forbrug én gang og tilbagefører kun den korrigerede mængde',async()=>{
    const db=database();const op='test-consume-unique';
    let t=tx(db,op);consumeDirect(t,await getJob(db,1),await getProduct(db,1),12*K,'Testforbrug');await t.commit();
    t=tx(db,op);consumeDirect(t,await getJob(db,1),await getProduct(db,1),12*K,'Dobbeltklik');await expect(t.commit()).rejects.toBeInstanceOf(Duplicate);
    expect(balance(db)).toMatchObject({stock:88*K,reserved:0});
    const correction=tx(db,'test-return-unique');await returnToStock(correction,await getJob(db,1),await getProduct(db,1),5*K,'Fejlrettelse');await correction.commit();
    expect(balance(db)).toMatchObject({stock:93*K,reserved:0});
    expect(row(db,'SELECT issued-returned AS net FROM job_materials WHERE job_id=1 AND product_id=1').net).toBe(7*K);
    expect(row(db,'SELECT COUNT(*) AS n FROM movements').n).toBe(2);
    db.sql.close();
  });
  it('afslutning frigiver også reservationer oprettet efter afslutningens læsning',async()=>{
    const db=database(),j=await getJob(db,1),p=await getProduct(db,1);
    const ending=tx(db,'test-close-before-read');await closeJob(ending,j,'afsluttet');
    const planning=tx(db,'test-reserve-after-read');await planMaterial(planning,j,p,20*K);await planning.commit();
    await ending.commit();
    expect(balance(db)).toMatchObject({stock:100*K,reserved:0});
    expect(row(db,'SELECT reserved FROM job_materials WHERE job_id=1').reserved).toBe(0);
    expect(row(db,"SELECT qty,reserved_delta FROM movements WHERE kind='job_afsluttet'")).toMatchObject({qty:20*K,reserved_delta:-20*K});
    expect(ending.products.has(1)).toBe(true);db.sql.close();
  });
  it('en gammel reservation kan ikke gemmes efter jobbet er afsluttet',async()=>{
    const db=database(),j=await getJob(db,1),p=await getProduct(db,1);
    const planning=tx(db,'test-stale-plan');await planMaterial(planning,j,p,20*K);
    const ending=tx(db,'test-close-first');await closeJob(ending,j,'afsluttet');await ending.commit();
    await expect(planning.commit()).rejects.toBeInstanceOf(RaceConflict);
    expect(balance(db)).toMatchObject({stock:100*K,reserved:0});
    expect(row(db,"SELECT COUNT(*) AS n FROM ops WHERE token='test-stale-plan'").n).toBe(0);db.sql.close();
  });
  it('automatisk jobstatus kan ikke overskrive en samtidig afslutning',async()=>{
    const db=database();db.sql.exec("UPDATE jobs SET stage='planlagt' WHERE id=1;INSERT INTO job_materials(job_id,product_id,planned,issued,updated_at) VALUES(1,1,1000,1000,1)");
    let release,read;const held=new Promise(r=>release=r),snapshotRead=new Promise(r=>read=r);
    const delayed={...db,prepare(query){
      const statement=db.prepare(query);
      if(query!=='SELECT * FROM jobs WHERE id = ?')return statement;
      return {bind(...args){const bound=statement.bind(...args);return {async first(){const snapshot=await bound.first();read();await held;return snapshot;}};}};
    }};
    const automatic=syncStage(delayed,1,2_000_000_001,actor);await snapshotRead;
    const ending=tx(db,'test-close-before-status');await closeJob(ending,await getJob(db,1),'afsluttet');await ending.commit();
    release();await automatic;
    expect(row(db,'SELECT status,stage FROM jobs WHERE id=1')).toMatchObject({status:'afsluttet',stage:'afsluttet'});
    expect(row(db,'SELECT COUNT(*) AS n FROM job_log').n).toBe(0);db.sql.close();
  });
  it('sen varemodtagelse til et afsluttet job bliver frit lager og ændrer ikke manuelle priser',async()=>{
    const db=database(),line=purchase(db),j=await getJob(db,1);
    const delivery=tx(db,'test-late-receipt');receiveLine(delivery,line,5*K,1500,true);
    const ending=tx(db,'test-close-before-receipt');await closeJob(ending,j,'afsluttet');await ending.commit();await delivery.commit();
    expect(balance(db)).toMatchObject({stock:105*K,reserved:0,purchase_price:1000,purchase_price_source:'',purchase_price_at:null});
    expect(row(db,"SELECT reserved_delta,unit_cost FROM movements WHERE kind='modtaget'")).toMatchObject({reserved_delta:0,unit_cost:1500});
    expect(row(db,'SELECT received,actual_price FROM purchase_lines WHERE id=1')).toMatchObject({received:5*K,actual_price:1500});db.sql.close();
  });
  it('modtagelse før afslutning reserveres og frigives korrekt ved afslutningen',async()=>{
    const db=database(),line=purchase(db),j=await getJob(db,1);
    const ending=tx(db,'test-close-stale-receipt');await closeJob(ending,j,'afsluttet');
    const delivery=tx(db,'test-first-receipt');receiveLine(delivery,line,5*K,1500,true);await delivery.commit();expect(balance(db).reserved).toBe(5*K);
    await ending.commit();expect(balance(db)).toMatchObject({stock:105*K,reserved:0});
    expect(row(db,'SELECT SUM(reserved_delta) AS net FROM movements').net).toBe(0);db.sql.close();
  });
  it('låser enhed og delbarhed ved beholdning/historik, men ikke på en ubrugt tom vare',()=>{
    const db=database();expect(()=>db.sql.exec("UPDATE products SET unit='pk.' WHERE id=1")).toThrow('LAGER_UNIT_LOCKED');
    expect(()=>db.sql.exec('UPDATE products SET whole_units=0 WHERE id=1')).toThrow('LAGER_UNIT_LOCKED');
    db.sql.exec("INSERT INTO products(sku,name,created_at,updated_at) VALUES('TEST-EMPTY','Tom testvare',1,1);UPDATE products SET unit='m',whole_units=0 WHERE sku='TEST-EMPTY'");
    expect(row(db,"SELECT unit,whole_units FROM products WHERE sku='TEST-EMPTY'")).toMatchObject({unit:'m',whole_units:0});db.sql.close();
  });
  it('otte samtidige vurderinger giver én lageradvarsel og mail kun til valgte ejer/indkøber',async()=>{
    const db=database();db.sql.exec('UPDATE products SET stock=70000 WHERE id=1');const env={DB:db,APP_URL:'https://test.example'};
    await Promise.all(Array.from({length:8},()=>evaluateProducts(env,DEFAULT_SETTINGS,[1],actor.email)));
    expect(row(db,"SELECT COUNT(*) AS n FROM notices WHERE kind='lager' AND open=1").n).toBe(1);
    const mails=db.sql.prepare("SELECT recipient FROM mails WHERE kind='lageradvarsel' ORDER BY recipient").all();
    expect(mails.map(x=>x.recipient)).toEqual(['buyer@test.example','owner@test.example']);
    await evaluateProducts(env,DEFAULT_SETTINGS,[1]);expect(row(db,'SELECT COUNT(*) AS n FROM mails').n).toBe(2);
    db.sql.exec('UPDATE products SET stock=9000 WHERE id=1');await evaluateProducts(env,DEFAULT_SETTINGS,[1]);
    expect(row(db,"SELECT level FROM notices WHERE kind='lager' AND open=1").level).toBe(2);
    expect(row(db,'SELECT COUNT(*) AS n FROM mails').n).toBe(4);db.sql.close();
  });
});

describe('D1-formularer: manuelle lagerdata og prisproveniens',()=>{
  let stack,owner;
  const fields={sku:'TEST-WAREHOUSE-ONLY',name:'Tydeligt fiktiv testvare',description:'Søgeord: testkontrol',unit:'stk.',whole_units:'1',reorder_point:'12',safety_method:'antal',safety_qty:'3',purchase_price:'10',sale_price:'20',initial_stock:'20',active:'1'};
  beforeAll(async()=>{stack=await startStack();owner=await login(stack);},180_000);
  afterAll(async()=>{await stack?.stop();});
  it('opretter/søger/beskriver varen og viser manuelt genbestillingspunkt uden prognosedata',async()=>{
    const page=await owner.get('/lager/varer/ny');const result=await owner.post('/lager/varer/ny',{_csrf:csrfFrom(page.html),...fields});
    expect(result.status,result.html).toBe(303);const id=Number(result.headers.get('location').match(/varer\/(\d+)/)[1]);
    const product=stack.sql(`SELECT * FROM products WHERE id=${id}`)[0];
    expect(product).toMatchObject({reorder_point:12*K,description:fields.description,purchase_price_source:'manuel',sale_price_source:'manuel'});
    expect(product.purchase_price_at).toBeGreaterThan(0);const detail=await owner.get(`/lager/varer/${id}`);
    expect(detail.html).toContain('12 stk. (manuelt, inklusive sikkerhedslager)');expect(detail.html).toContain('Manuelt indtastet');
    const search=await owner.get('/lager/varer?q=testkontrol');expect(search.html).toContain(fields.name);
  });
  it('beskrivelsesændring opfinder ikke nye prisdatoer, og enhedsændring afvises',async()=>{
    const old=stack.sql("SELECT * FROM products WHERE sku='TEST-WAREHOUSE-ONLY'")[0];
    const page=await owner.get(`/lager/varer/${old.id}`);
    let res=await owner.post(`/lager/varer/${old.id}`,{_csrf:csrfFrom(page.html),...fields,description:'Ny beskrivelse'});expect(res.status,res.html).toBe(303);
    let current=stack.sql(`SELECT * FROM products WHERE id=${old.id}`)[0];expect(current.purchase_price_at).toBe(old.purchase_price_at);expect(current.sale_price_at).toBe(old.sale_price_at);
    res=await owner.post(`/lager/varer/${old.id}`,{_csrf:csrfFrom(page.html),...fields,unit:'pk.'});expect(res.status).toBe(400);expect(res.html).toContain('kan ikke ændres');
    current=stack.sql(`SELECT * FROM products WHERE id=${old.id}`)[0];expect(current.unit).toBe('stk.');
  });
});
