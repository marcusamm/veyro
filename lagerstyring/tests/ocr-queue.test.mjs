import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addAllocation, bilagLines, checkBilag, createBilag, getBilag, saveBilag } from '../src/lib/bilag.ts';
import { BilagOcrQueue, enqueueOcr, ocrJob, processNextOcr, requestBilagRead } from '../src/lib/bilagqueue.ts';
import { fileBytes, storeFile } from '../src/lib/files.ts';
import { DEFAULT_SETTINGS } from '../src/lib/settings.ts';
import { samplePdf } from '../src/lib/samplepdf.ts';
import { detailPage } from '../src/views/bilag.ts';

const actor = { email: 'test-ocr@example.invalid', name: 'TESTDATA OCR ejer' };
const time = 1793220000;
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
const page = ['Faktura','TESTDATA OCR Grossist ApS','CVR: 12345678','Fakturanr. TEST-OCR-KOE','Dato: 29.10.2026','Beskrivelse  Antal  Enhed  Á-pris  Moms  Beløb','TESTDATA træskrue  2  stk.  50,00  25%  100,00','Netto  100,00','Moms  25,00','I alt inkl. moms  125,00'].join('\n');
const open = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(time * 1000); });
afterEach(() => { vi.useRealTimers(); for (const db of open.splice(0)) db.close(); });

function database() {
  const sqlite = new DatabaseSync(':memory:'); open.push(sqlite); sqlite.exec('PRAGMA foreign_keys=ON');
  const folder = fileURLToPath(new URL('../migrations/', import.meta.url));
  for (const file of readdirSync(folder).filter(f => f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(`${folder}/${file}`, 'utf8'));
  function prepared(sql, params = []) {
    const values = () => params.map(x => x instanceof ArrayBuffer ? Buffer.from(x) : x === undefined ? null : x);
    return {
      bind: (...p) => prepared(sql, p),
      first: async column => { const row = sqlite.prepare(sql).get(...values()) ?? null; return column && row ? row[column] : row; },
      all: async () => ({ results: sqlite.prepare(sql).all(...values()), success: true }),
      run: async () => { const r = sqlite.prepare(sql).run(...values()); return { meta: { changes: Number(r.changes) }, success: true }; },
    };
  }
  let chain = Promise.resolve();
  return {
    sqlite, prepare: sql => prepared(sql),
    batch(statements) {
      const execute = async () => { sqlite.exec('BEGIN'); try { const r = []; for (const s of statements) r.push(await s.run()); sqlite.exec('COMMIT'); return r; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } };
      const result = chain.then(execute, execute); chain = result.then(() => undefined, () => undefined); return result;
    },
  };
}

async function setup() {
  const DB = database();
  const settings = { ...DEFAULT_SETTINGS, company_name: 'TESTDATA firma', vat_registered: 'ja' };
  const original = await storeFile(DB, png, actor.email, time); expect(original.ok).toBe(true);
  const create = () => createBilag(DB, original.file, 'TESTDATA.png', {doc_type:'faktura',payment:'virksomhed',paid_by:'',job_hint:null,origin:'test',note:'TESTDATA',preview_file_id:null}, actor, time);
  const env = { DB, APP_URL:'https://test.invalid', RECEIPT_OCR: { fetch:vi.fn(async () => Response.json({pages:[page],provider:'TESTDATA CPU OCR'})) } };
  const alarms = [];
  const ctx = { blockConcurrencyWhile:fn=>fn(), storage:{setAlarm:async at=>alarms.push(at)} };
  const queue = new BilagOcrQueue(ctx, env);
  env.BILAG_OCR_QUEUE = {getByName:name=>{expect(name).toBe('bilag-ocr');return{fetch:request=>queue.fetch(request)};}};
  return { DB, settings, original, create, env, alarms, queue, ctx };
}

describe('Vedvarende OCR-kø uden lager- eller omkostningsbogføring', () => {
  it('gemmer upload og kømetadata straks, deduplikerer og aflæser på et senere alarmkald', async () => {
    const x = await setup(), id = await x.create();
    expect(await requestBilagRead(x.env,x.settings,id,actor,time)).toMatchObject({ok:true});
    expect(await requestBilagRead(x.env,x.settings,id,actor,time)).toMatchObject({ok:true});
    expect(x.env.RECEIPT_OCR.fetch).not.toHaveBeenCalled();
    expect((await ocrJob(x.DB,id)).state).toBe('queued'); expect(x.alarms).toHaveLength(2);
    expect((await getBilag(x.DB,id)).status).toBe('under_aflaesning');
    await x.queue.alarm();
    expect(x.env.RECEIPT_OCR.fetch).toHaveBeenCalledTimes(1); expect((await ocrJob(x.DB,id)).state).toBe('done');
    const b = await getBilag(x.DB,id), lines = await bilagLines(x.DB,id);
    expect(b).toMatchObject({status:'klar',reading_token:'',net:10000,vat:2500,total:12500,ocr_provider:'TESTDATA CPU OCR'});
    expect(lines).toHaveLength(1); expect(lines[0]).toMatchObject({qty:2000,amount:10000,uncertain:1});
    expect(checkBilag(b,lines,[],x.settings).errors.join(' ')).toContain('OCR-forslag');
    expect(await fileBytes(x.DB,x.original.file)).toEqual(png);
    expect(x.DB.sqlite.prepare('SELECT COUNT(*) n FROM movements').get().n).toBe(0);
    expect(x.DB.sqlite.prepare('SELECT COUNT(*) n FROM purchase_lines').get().n).toBe(0);
  });

  it('kan genaktivere en gemt kø efter fejl mellem databasecommit og alarmopsætning', async () => {
    const x = await setup(), id = await x.create();
    x.ctx.storage.setAlarm = vi.fn().mockRejectedValueOnce(new Error('TESTDATA alarm interrupted')).mockImplementation(async at=>x.alarms.push(at));
    expect(await requestBilagRead(x.env,x.settings,id,actor,time)).toMatchObject({ok:false});
    const first = await ocrJob(x.DB,id); expect(first.state).toBe('queued');
    expect(await requestBilagRead(x.env,x.settings,id,actor,time)).toMatchObject({ok:true});
    expect((await ocrJob(x.DB,id)).token).toBe(first.token); expect(x.alarms).toHaveLength(1);
    expect(x.DB.sqlite.prepare("SELECT COUNT(*) n FROM bilag_events WHERE kind='ocr_koe'").get().n).toBe(1);
    await x.queue.alarm(); expect((await ocrJob(x.DB,id)).state).toBe('done');
  });

  it('behandler én fil pr. alarm og blander aldrig virksomheders køer eller originaler', async () => {
    const x = await setup(), other = await setup(), a = await x.create(), b = await x.create();
    await enqueueOcr(x.DB,a,actor,time); await enqueueOcr(x.DB,b,actor,time);
    await x.queue.alarm();
    expect((await ocrJob(x.DB,a)).state).toBe('done'); expect((await ocrJob(x.DB,b)).state).toBe('queued');
    expect(other.DB.sqlite.prepare('SELECT COUNT(*) n FROM bilag_ocr_jobs').get().n).toBe(0);
    await x.queue.alarm(); expect((await ocrJob(x.DB,b)).state).toBe('done');
    expect(other.env.RECEIPT_OCR.fetch).not.toHaveBeenCalled();
  });

  it('genprøver en midlertidig fejl én gang med pause og stopper derefter', async () => {
    const x = await setup(), id = await x.create(); x.env.RECEIPT_OCR.fetch.mockImplementation(async()=>new Response('',{status:503}));
    await enqueueOcr(x.DB,id,actor,time); await processNextOcr(x.env,time);
    expect(await ocrJob(x.DB,id)).toMatchObject({state:'queued',attempts:1,available_at:time+30});
    await processNextOcr(x.env,time+29); expect(x.env.RECEIPT_OCR.fetch).toHaveBeenCalledTimes(1);
    vi.setSystemTime((time+30)*1000); await processNextOcr(x.env,time+30);
    expect(await ocrJob(x.DB,id)).toMatchObject({state:'failed',attempts:2});
    expect(await processNextOcr(x.env,time+3600)).toBe(false); expect(x.env.RECEIPT_OCR.fetch).toHaveBeenCalledTimes(2);
    expect((await getBilag(x.DB,id)).reading_token).toBe('');
  });

  it('genprøver ikke en daglig kapacitetsgrænse og viser originalen til manuel kontrol', async () => {
    const x = await setup(), id = await x.create(); x.env.RECEIPT_OCR.fetch.mockImplementation(async()=>new Response('',{status:429}));
    await enqueueOcr(x.DB,id,actor,time); await processNextOcr(x.env,time);
    const job = await ocrJob(x.DB,id), b = await getBilag(x.DB,id);
    expect(job).toMatchObject({state:'failed',attempts:1}); expect(job.last_error).toContain('grænse');
    expect(b).toMatchObject({status:'modtaget',reading_token:''}); expect(b.reading_note).toContain('grænse');
  });

  it('bevarer manuelle rettelser, når et gammelt OCR-resultat kommer senere', async () => {
    const x = await setup(), id = await x.create(); let release, began;
    const started = new Promise(resolve=>{began=resolve;});
    x.env.RECEIPT_OCR.fetch.mockImplementation(()=>{began();return new Promise(resolve=>{release=()=>resolve(Response.json({pages:[page],provider:'TESTDATA sent svar'}));});});
    await enqueueOcr(x.DB,id,actor,time); const running = processNextOcr(x.env,time); await started;
    const b = await getBilag(x.DB,id);
    await saveBilag(x.DB,b,{...b,supplier_name:'TESTDATA brugerens rettelse',note:'TESTDATA manuel kontrol'},null,actor,time+1);
    release(); await running;
    expect(await ocrJob(x.DB,id)).toMatchObject({state:'cancelled'});
    expect(await getBilag(x.DB,id)).toMatchObject({supplier_name:'TESTDATA brugerens rettelse',note:'TESTDATA manuel kontrol',ocr_provider:'',reading_token:''});
    expect(await bilagLines(x.DB,id)).toHaveLength(0);
  });

  it('afviser et sent resultat efter fordeling og bevarer fordelingen', async () => {
    const x = await setup(), id = await x.create(); let release, began;
    const started = new Promise(resolve=>{began=resolve;});
    x.env.RECEIPT_OCR.fetch.mockImplementation(()=>{began();return new Promise(resolve=>{release=()=>resolve(Response.json({pages:[page],provider:'TESTDATA sent svar'}));});});
    await enqueueOcr(x.DB,id,actor,time); const running = processNextOcr(x.env,time); await started;
    await addAllocation(x.DB,await getBilag(x.DB,id),{line_id:null,target:'drift',job_id:null,amount:10000,action:'udgift',purchase_line_id:null,product_id:null,qty:null,note:'TESTDATA fordeling'},actor,time+1);
    release(); await running;
    expect(await ocrJob(x.DB,id)).toMatchObject({state:'cancelled'});
    expect(x.DB.sqlite.prepare('SELECT COUNT(*) n FROM bilag_allocations WHERE bilag_id=?').get(id).n).toBe(1);
    expect((await getBilag(x.DB,id)).ocr_provider).toBe('');
    expect(await bilagLines(x.DB,id)).toHaveLength(0);
  });

  it('kan genoptage en afbrudt alarm, men aldrig udføre mere end to forsøg', async () => {
    const x = await setup(), id = await x.create(); await enqueueOcr(x.DB,id,actor,time);
    await x.DB.prepare("UPDATE bilag_ocr_jobs SET state='processing',attempts=2,lease_until=? WHERE bilag_id=?").bind(time-1,id).run();
    await processNextOcr(x.env,time);
    expect(await ocrJob(x.DB,id)).toMatchObject({state:'failed',attempts:2}); expect(x.env.RECEIPT_OCR.fetch).not.toHaveBeenCalled();
    expect((await getBilag(x.DB,id)).reading_token).toBe('');
  });

  it('læser en tekst-PDF direkte uden at sende den til OCR eller køen', async () => {
    const x = await setup();
    const pdf = await samplePdf({kind:'faktura',supplier:'TESTDATA PDF Grossist',address:'Testvej 1',cvr:'12345678',number:'TEST-KOE-PDF',date:'2026-10-29',buyer:'TESTDATA firma',lines:[{name:'TESTDATA materiale',qty:1000,unit:'stk.',price:10000}]});
    const f = await storeFile(x.DB,pdf,actor.email,time);
    const id = await createBilag(x.DB,f.file,'TESTDATA.pdf',{doc_type:'faktura',payment:'virksomhed',paid_by:'',job_hint:null,origin:'test',note:'TESTDATA',preview_file_id:null},actor,time);
    expect(await requestBilagRead(x.env,x.settings,id,actor,time)).toMatchObject({ok:true});
    expect((await getBilag(x.DB,id)).reading_source).toBe('pdf-tekst'); expect(await ocrJob(x.DB,id)).toBeNull();
    expect(x.env.RECEIPT_OCR.fetch).not.toHaveBeenCalled(); expect(x.alarms).toHaveLength(0);
  });

  it('viser køstatus og mulighed for manuel kontrol uden automatisk genindlæsning', async () => {
    const x = await setup(), id = await x.create(); await enqueueOcr(x.DB,id,actor,time);
    const b = await getBilag(x.DB,id), ocr = await ocrJob(x.DB,id);
    const html = String(await detailPage({base:'/lager/bilag',csrf:'TESTDATA',op:'TESTDATA',b:{...b,uploader:actor.name,payer:null,approver:null},file:{mime:'image/png',pages:null,size:png.length},lines:[],allocs:[],events:[],checks:checkBilag(b,[],[],x.settings),canEdit:true,canDelete:true,manager:true,jobs:[],products:[],users:[],suggestions:[],dupOf:null,vatRegistered:true,errs:[],ocr}));
    expect(html).toContain('Bilaget er i OCR-kø'); expect(html).toContain('Opdatér status'); expect(html).toContain('afbrydes aflæsningen');
    expect(html).not.toContain('>Aflæs igen</button>'); expect(html).toContain('name="supplier_name"');
  });
});
