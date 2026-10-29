// Real SQLite transactions behind the production D1 interface. Fault injection
// exercises rollback/commit boundaries without touching any company's database.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { allocations, addAllocation, approveBilag, bilagLines, checkBilag, createBilag, getBilag, performAllocation, readBilag, saveBilag } from '../src/lib/bilag.ts';
import { fileBytes, storeFile } from '../src/lib/files.ts';
import { Tx } from '../src/lib/ledger.ts';
import { DEFAULT_SETTINGS } from '../src/lib/settings.ts';
import { execTx } from '../src/render.ts';
import { samplePdf } from '../src/lib/samplepdf.ts';
import { resetDemo } from '../src/lib/demo.ts';

const actor = { email: 'test-ejer@example.invalid', name: 'TESTDATA ejer' };
const time = 1793220000;
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
const open = [];
function database() {
  const sqlite = new DatabaseSync(':memory:'); open.push(sqlite);
  sqlite.exec('PRAGMA foreign_keys = ON');
  const folder = fileURLToPath(new URL('../migrations/', import.meta.url));
  for (const file of readdirSync(folder).filter(f => f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(`${folder}/${file}`, 'utf8'));
  function prepared(sql, params = []) {
    const stmt = () => sqlite.prepare(sql);
    const values = () => params.map(x => x instanceof ArrayBuffer ? Buffer.from(x) : x === undefined ? null : x);
    return {
      bind: (...p) => prepared(sql, p),
      first: async column => { const row = stmt().get(...values()) ?? null; return column && row ? row[column] : row; },
      all: async () => ({ results: stmt().all(...values()), success: true }),
      run: async () => { const r = stmt().run(...values()); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) }, success: true }; },
    };
  }
  let queue = Promise.resolve();
  return {
    sqlite, prepare: sql => prepared(sql),
    batch(statements) {
      const execute = async () => {
        sqlite.exec('BEGIN');
        try { const results = []; for (const s of statements) results.push(await s.run()); sqlite.exec('COMMIT'); return results; }
        catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      };
      const result = queue.then(execute, execute);
      queue = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}
afterEach(() => { for (const db of open.splice(0)) db.close(); });

async function setup() {
  const DB = database(), env = { DB, APP_URL: 'https://test.invalid' };
  const settings = { ...DEFAULT_SETTINGS, company_name: 'TESTDATA firma', vat_registered: 'ja', alert_mail_enabled: false };
  await DB.prepare("INSERT INTO products (sku,name,unit,stock,purchase_price,created_at,updated_at) VALUES ('TEST-RECEIPT','TESTDATA lagervare','stk.',1000,700,?,?)").bind(time,time).run();
  const product = await DB.prepare("SELECT * FROM products WHERE sku = 'TEST-RECEIPT'").first();
  const original = await storeFile(DB, png, actor.email, time);
  expect(original.ok).toBe(true);
  const create = async (name = 'TESTDATA.png') => createBilag(DB, original.file, name, { doc_type: 'kvittering', payment: 'virksomhed', paid_by: '', job_hint: null, origin: 'test', note: 'TESTDATA', preview_file_id: null }, actor, time);
  const manual = async id => { await DB.prepare("UPDATE bilag SET supplier_name='TESTDATA grossist',doc_number=?,doc_date='2026-10-29',net=10000,vat=2500,total=12500,status='klar',reading_source='manuel' WHERE id=?").bind(`TEST-${id}`,id).run(); return getBilag(DB,id); };
  const allocate = async id => { const b = await getBilag(DB,id); await addAllocation(DB,b,{ line_id:null,target:'lager',job_id:null,amount:10000,action:'ny_modtagelse',purchase_line_id:null,product_id:product.id,qty:2000,note:'TESTDATA modtagelse' },actor,time); return (await allocations(DB,id))[0]; };
  let seq = 0;
  const run = build => execTx(env,settings,actor,'TESTDATA-receipt',`TEST_receipt_op_${++seq}`,build,time);
  const stock = async () => (await DB.prepare('SELECT stock FROM products WHERE id=?').bind(product.id).first()).stock;
  return { DB,env,settings,product,original,create,manual,allocate,run,stock };
}

describe('Bilag: original, OCR-kontrol og atomisk varemodtagelse', () => {
  it('marker identiske fotos og scanninger også uden tekst/OCR, uden lagerændring', async () => {
    const x = await setup(), first = await x.create(), second = await x.create('TESTDATA-kopi.png');
    await readBilag(x.env,x.settings,second,actor,time);
    const b = await getBilag(x.DB,second);
    expect(b.dup_of).toBe(first); expect(b.dup_reason).toBe('identisk fil');
    expect(b.reading_note).toContain('OCR er ikke tilsluttet');
    expect((await getBilag(x.DB,first)).dup_of).toBeNull();
    expect(await fileBytes(x.DB,x.original.file)).toEqual(png);
    expect(await x.stock()).toBe(1000);
    await x.manual(second); const a = await x.allocate(second);
    expect(await performAllocation(x.env,x.settings,b,a.id,actor,time,x.run)).toContain('Mulig dublet');
    expect(await x.stock()).toBe(1000);
  });

  it('ruller køb, modtagelse, historik og engangsnøgler tilbage ved fejl i sidste trin', async () => {
    const x = await setup(), id = await x.create(); const b = await x.manual(id), a = await x.allocate(id);
    x.DB.sqlite.exec(`CREATE TRIGGER TEST_fail_finalization BEFORE UPDATE OF done_at ON bilag_allocations WHEN NEW.id=${a.id} AND NEW.done_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'TESTDATA finalization failure'); END`);
    await expect(performAllocation(x.env,x.settings,b,a.id,actor,time,x.run)).rejects.toThrow('TESTDATA finalization failure');
    expect(await x.stock()).toBe(1000);
    expect((await allocations(x.DB,id))[0]).toMatchObject({done_at:null,purchase_line_id:null});
    expect(x.DB.sqlite.prepare('SELECT COUNT(*) n FROM purchase_lines').get().n).toBe(0);
    expect(x.DB.sqlite.prepare("SELECT COUNT(*) n FROM ops WHERE token LIKE 'bilag-fordeling:%'").get().n).toBe(0);
    expect(x.DB.sqlite.prepare("SELECT COUNT(*) n FROM movements WHERE kind='modtaget'").get().n).toBe(0);
    x.DB.sqlite.exec('DROP TRIGGER TEST_fail_finalization');
    expect(await performAllocation(x.env,x.settings,b,a.id,actor,time,x.run)).toBeNull();
    expect(await x.stock()).toBe(3000);
    expect((await allocations(x.DB,id))[0].purchase_line_id).toBeGreaterThan(0);
  });

  it('kan ikke modtage to gange efter fejl EFTER commit og et nyt form-token', async () => {
    const x = await setup(), id = await x.create(); const b = await x.manual(id), a = await x.allocate(id);
    const failAfterCommit = async build => { const tx = new Tx(x.DB,actor,'TEST_failure_after_commit',time); await build(tx); await tx.commit('TESTDATA'); throw new Error('TESTDATA notification failure after commit'); };
    await expect(performAllocation(x.env,x.settings,b,a.id,actor,time,failAfterCommit)).rejects.toThrow('after commit');
    expect(await x.stock()).toBe(3000);
    expect((await allocations(x.DB,id))[0].done_at).toBe(time);
    expect(await performAllocation(x.env,x.settings,b,a.id,actor,time,x.run)).toContain('allerede registreret');
    expect(await x.stock()).toBe(3000);
    expect(x.DB.sqlite.prepare('SELECT COUNT(*) n FROM purchase_lines').get().n).toBe(1);
    expect(x.DB.sqlite.prepare("SELECT COUNT(*) n FROM movements WHERE kind='modtaget'").get().n).toBe(1);
    expect((await x.DB.prepare('SELECT purchase_price FROM products WHERE id=?').bind(x.product.id).first()).purchase_price).toBe(700);
  });

  it('afviser samtidige nye form-token for samme bilagfordeling og modtager præcis én gang', async () => {
    const x = await setup(), id = await x.create(); const b = await x.manual(id), a = await x.allocate(id);
    // Both requests build before either starts committing, like concurrent D1 requests.
    let waiting = 0, release; const gate = new Promise(r => { release = r; });
    const concurrent = async build => {
      const tx = new Tx(x.DB,actor,`TEST_concurrent_${++waiting}`,time); await build(tx);
      if (waiting === 2) release(); await gate;
      try { await tx.commit('TESTDATA'); return {ok:true}; } catch(error) { return {ok:false,error:error.message}; }
    };
    const results = await Promise.all([performAllocation(x.env,x.settings,b,a.id,actor,time,concurrent),performAllocation(x.env,x.settings,b,a.id,actor,time,concurrent)]);
    expect(results.filter(v => v === null)).toHaveLength(1);
    expect(results.find(v => v !== null)).toContain('allerede gennemført');
    expect(await x.stock()).toBe(3000);
    expect(x.DB.sqlite.prepare('SELECT COUNT(*) n FROM purchase_lines').get().n).toBe(1);
    expect(x.DB.sqlite.prepare("SELECT COUNT(*) n FROM movements WHERE kind='modtaget'").get().n).toBe(1);
  });

  it('to forskellige fordelinger kan modtages samtidigt med genforsøg ved ID-kollision', async () => {
    const x = await setup(), id = await x.create(); const b = await x.manual(id), first = await x.allocate(id);
    await x.DB.prepare('UPDATE bilag_allocations SET amount=5000,qty=1000 WHERE id=?').bind(first.id).run();
    await addAllocation(x.DB,b,{line_id:null,target:'lager',job_id:null,amount:5000,action:'ny_modtagelse',purchase_line_id:null,product_id:x.product.id,qty:1000,note:'TESTDATA anden halvdel'},actor,time);
    const second = (await allocations(x.DB,id))[1];
    const results = await Promise.all([performAllocation(x.env,x.settings,b,first.id,actor,time,x.run),performAllocation(x.env,x.settings,b,second.id,actor,time,x.run)]);
    expect(results).toEqual([null,null]); expect(await x.stock()).toBe(3000);
    expect(x.DB.sqlite.prepare('SELECT COUNT(*) n FROM purchase_lines').get().n).toBe(2);
    expect(x.DB.sqlite.prepare("SELECT COUNT(*) n FROM movements WHERE kind='modtaget'").get().n).toBe(2);
  });

  it('bevarer registrerede fordelinger ved senere genaflæsning og forsøg på linjesletning', async () => {
    const x = await setup(), id = await x.create(); const b = await x.manual(id);
    await x.DB.prepare("INSERT INTO bilag_lines (bilag_id,pos,name,qty,unit,unit_price,amount) VALUES (?,1,'TESTDATA linje',2000,'stk.',5000,10000)").bind(id).run();
    const line = (await bilagLines(x.DB,id))[0]; const a = await x.allocate(id);
    await x.DB.prepare('UPDATE bilag_allocations SET line_id=? WHERE id=?').bind(line.id,a.id).run();
    expect(await performAllocation(x.env,x.settings,b,a.id,actor,time,x.run)).toBeNull();
    const reread = await readBilag(x.env,x.settings,id,actor,time);
    expect(reread.ok).toBe(false); expect(reread.message).toContain('allerede fordelt');
    await expect(saveBilag(x.DB,await getBilag(x.DB,id),b,[],actor,time)).rejects.toThrow('kan ikke fjernes');
    expect((await allocations(x.DB,id))[0]).toMatchObject({id:a.id,done_at:time});
    await expect(x.DB.prepare('DELETE FROM bilag_lines WHERE id=?').bind(line.id).run()).rejects.toThrow('BILAG_LINE_POSTED');
    await expect(x.DB.prepare('DELETE FROM bilag_allocations WHERE id=?').bind(a.id).run()).rejects.toThrow('BILAG_ALLOCATION_POSTED');
    expect(await bilagLines(x.DB,id)).toHaveLength(1); expect(await x.stock()).toBe(3000);
    expect(await performAllocation(x.env,x.settings,b,a.id,actor,time,x.run)).toContain('allerede registreret');
  });

  it('nulstiller kun demodata og efterlader ingen omgåelse af historikbeskyttelsen', async () => {
    const x = await setup(), id = await x.create(); const b = await x.manual(id), a = await x.allocate(id);
    expect(await performAllocation(x.env,x.settings,b,a.id,actor,time,x.run)).toBeNull();
    await expect(resetDemo(x.env)).rejects.toThrow('kun mulig i demoen');
    expect(await x.stock()).toBe(3000);
    await resetDemo({...x.env,DEMO_MODE:'1'});
    expect(x.DB.sqlite.prepare("SELECT COUNT(*) n FROM settings WHERE key='_internal_demo_reset'").get().n).toBe(0);
    expect(x.DB.sqlite.prepare("SELECT COUNT(*) n FROM products WHERE sku='TEST-RECEIPT'").get().n).toBe(0);
    expect(x.DB.sqlite.prepare('SELECT COUNT(*) n FROM products').get().n).toBeGreaterThan(0);
    // An ordinary session cannot delete a posted allocation after the reset.
    const fresh = await x.DB.prepare('SELECT id FROM bilag LIMIT 1').first();
    const product = await x.DB.prepare('SELECT id FROM products LIMIT 1').first();
    await x.DB.prepare("INSERT INTO bilag_allocations (bilag_id,target,amount,action,product_id,qty,done_at,created_by,created_at) VALUES (?,'lager',100,'ny_modtagelse',?,1000,?,'TESTDATA',?)").bind(fresh.id,product.id,time,time).run();
    await expect(x.DB.prepare('DELETE FROM bilag_allocations WHERE done_at=?').bind(time).run()).rejects.toThrow('BILAG_ALLOCATION_POSTED');
  });

  it('OCR gemmer kun forslag fra en tilsluttet testtjeneste og kræver udtrykkelig kontrol', async () => {
    const x = await setup(), id = await x.create();
    const page = ['Faktura','TESTDATA OCR Grossist ApS','CVR: 12345678','Fakturanr. TEST-OCR-1','Dato: 29.10.2026','Beskrivelse  Antal  Enhed  Á-pris  Moms  Beløb','TESTDATA OCR-materiale  2  stk.  50,00  25%  100,00','Netto  100,00','Moms  25,00','I alt inkl. moms  125,00'].join('\n');
    const env = {...x.env,RECEIPT_OCR:{fetch:async request=>{expect(new Uint8Array(await request.arrayBuffer())).toEqual(png);return Response.json({provider:'TESTDATA OCR',pages:[page]});}}};
    expect((await readBilag(env,x.settings,id,actor,time)).ok).toBe(true);
    let b = await getBilag(x.DB,id); let lines = await bilagLines(x.DB,id);
    expect(b.ocr_provider).toBe('TESTDATA OCR'); expect(b.reading_source).toBe('');
    expect(b).toMatchObject({net:10000,vat:2500,total:12500});
    expect(JSON.parse(b.uncertain)).toContain('total'); expect(lines).toHaveLength(1); expect(lines[0].uncertain).toBe(1);
    expect(await fileBytes(x.DB,x.original.file)).toEqual(png); expect(await x.stock()).toBe(1000);
    const a = await x.allocate(id);
    expect((await approveBilag(x.DB,x.settings,b,actor,time)).join(' ')).toContain('OCR-forslag');
    expect(await performAllocation(env,x.settings,b,a.id,actor,time,x.run)).toContain('OCR-forslag');
    await saveBilag(x.DB,b,{...b,note:'TESTDATA intern note'},lines,actor,time);
    b = await getBilag(x.DB,id); lines = await bilagLines(x.DB,id);
    expect(checkBilag(b,lines,await allocations(x.DB,id),x.settings).errors.join(' ')).toContain('OCR-forslag');
    await saveBilag(x.DB,b,b,lines,actor,time,{confirmOCR:true});
    b = await getBilag(x.DB,id); lines = await bilagLines(x.DB,id);
    expect(JSON.parse(b.uncertain)).toEqual([]); expect(lines[0].uncertain).toBe(0);
    expect(await performAllocation(env,x.settings,b,a.id,actor,time,x.run)).toBeNull(); expect(await x.stock()).toBe(3000);
  });

  it('bruger PDF-tekst før OCR og bevarer originalen byte for byte', async () => {
    const x = await setup();
    const pdf = await samplePdf({kind:'faktura',supplier:'TESTDATA PDF Grossist',address:'Testvej 1',cvr:'12345678',number:'TEST-PDF-1',date:'2026-10-29',buyer:'TESTDATA firma',lines:[{name:'TESTDATA PDF-materiale',qty:1000,unit:'stk.',price:10000}]});
    const f = await storeFile(x.DB,pdf,actor.email,time); expect(f.ok).toBe(true);
    const id = await createBilag(x.DB,f.file,'TESTDATA.pdf',{doc_type:'faktura',payment:'virksomhed',paid_by:'',job_hint:null,origin:'test',note:'TESTDATA',preview_file_id:null},actor,time);
    const env = {...x.env,RECEIPT_OCR:{fetch:async()=>{throw new Error('OCR must not run for text PDFs');}}};
    expect((await readBilag(env,x.settings,id,actor,time)).ok).toBe(true);
    const b = await getBilag(x.DB,id); expect(b.reading_source).toBe('pdf-tekst'); expect(b.ocr_provider).toBe('');
    expect(await fileBytes(x.DB,f.file)).toEqual(pdf); expect(await x.stock()).toBe(1000);
  });
});
