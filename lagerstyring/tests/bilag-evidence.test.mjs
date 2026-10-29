import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBilag, getBilag, getBilagEvidence, readBilag, saveBilag } from '../src/lib/bilag.ts';
import { fileBytes, storeFile } from '../src/lib/files.ts';
import * as pdfReader from '../src/lib/pdftext.ts';
import { samplePdf } from '../src/lib/samplepdf.ts';
import { DEFAULT_SETTINGS } from '../src/lib/settings.ts';

const actor = { email: 'evidence@example.invalid', name: 'TESTDATA bilagskontrol' };
const time = 1793220000;
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
const pages = [['TESTDATA Grossist ApS', 'CVR: 12345678', 'Bilag: 0000012', 'Dato: 29.10.2026', 'TESTDATA vare', '2 x 50,00  100,00', 'Netto 100,00', 'Moms 25,00', 'I alt inkl. moms 125,00']];
const open = [];
afterEach(() => { vi.restoreAllMocks(); for (const sqlite of open.splice(0)) sqlite.close(); });

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
  return { sqlite, prepare: sql => prepared(sql), async batch(statements) {
    sqlite.exec('BEGIN');
    try { const results = []; for (const s of statements) results.push(await s.run()); sqlite.exec('COMMIT'); return results; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
}

async function setup(bytes = png, name = 'TESTDATA.png') {
  const DB = database();
  const stored = await storeFile(DB, bytes, actor.email, time); expect(stored.ok).toBe(true);
  const id = await createBilag(DB, stored.file, name, { doc_type:'kvittering',payment:'virksomhed',paid_by:'',job_hint:null,origin:'test',note:'TESTDATA',preview_file_id:null }, actor, time);
  const settings = { ...DEFAULT_SETTINGS, company_name: 'TESTDATA firma' };
  const env = { DB, RECEIPT_OCR: { fetch:vi.fn(async () => Response.json({ pages:pages.map(p=>p.join('\n')),provider:'TESTDATA OCR' })) } };
  return { DB, stored, id, settings, env };
}

describe('OCR-kilder til bilagsgennemgang', () => {
  it('gemmer det læste kildemateriale adskilt fra forslag og uændret original i virksomhedens egen database', async () => {
    const x = await setup(), other = await setup();
    expect(await getBilagEvidence(x.DB,x.id)).toBeNull();
    expect(await readBilag(x.env,x.settings,x.id,actor,time)).toMatchObject({ok:true});
    expect(await getBilagEvidence(x.DB,x.id)).toEqual({ bilag_id:x.id,file_id:x.stored.file.id,sourceVersion:1,currentVersion:1,pages,source:'ocr',provider:'TESTDATA OCR',read_at:time,truncated:false });
    expect(await getBilagEvidence(other.DB,other.id)).toBeNull();
    expect(await fileBytes(x.DB,x.stored.file)).toEqual(png);
    for (const table of ['movements','purchase_lines','bilag_allocations']) expect(x.DB.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n).toBe(0);
  });

  it('bevarer kilde og kildeversion efter rettelser, men bruger aldrig en tidligere original som kilde for en ny fil', async () => {
    const x = await setup(); await readBilag(x.env,x.settings,x.id,actor,time);
    const b = await getBilag(x.DB,x.id);
    await saveBilag(x.DB,b,{...b,supplier_name:'TESTDATA manuel rettelse'},null,actor,time+1);
    expect((await getBilagEvidence(x.DB,x.id)).pages).toEqual(pages);
    await x.DB.prepare('UPDATE bilag SET version=version+1 WHERE id=?').bind(x.id).run();
    expect(await getBilagEvidence(x.DB,x.id)).toMatchObject({sourceVersion:1,currentVersion:2,pages});
    // A different immutable file can be shared by another document. Switching
    // the reference must not make former OCR look like text of that new file.
    const pdf = await samplePdf({kind:'kvittering',supplier:'TESTDATA ny original',address:'Testvej 1',cvr:'12345678',number:'TEST-NY',date:'2026-10-29',buyer:'TESTDATA',lines:[]});
    const replacement = await storeFile(x.DB,pdf,actor.email,time+2);
    await x.DB.prepare('UPDATE bilag SET file_id=? WHERE id=?').bind(replacement.file.id,x.id).run();
    expect(await getBilagEvidence(x.DB,x.id)).toBeNull();
    expect(x.DB.sqlite.prepare('SELECT COUNT(*) n FROM bilag_ocr_evidence WHERE bilag_id=?').get(x.id).n).toBe(1);
  });

  it('et sent OCR-svar kan ikke erstatte tidligere kilder eller brugerens rettelser', async () => {
    const x = await setup(); await readBilag(x.env,x.settings,x.id,actor,time);
    let release, began; const started = new Promise(resolve => { began=resolve; });
    x.env.RECEIPT_OCR.fetch.mockImplementation(() => { began(); return new Promise(resolve => { release=()=>resolve(Response.json({pages:['TESTDATA FORSINKET SVAR'],provider:'TESTDATA sent'})); }); });
    const reading = readBilag(x.env,x.settings,x.id,actor,time+1); await started;
    const b = await getBilag(x.DB,x.id);
    await saveBilag(x.DB,b,{...b,supplier_name:'TESTDATA bevar min rettelse'},null,actor,time+2);
    release(); expect(await reading).toMatchObject({ok:false,cancelled:true});
    expect(await getBilagEvidence(x.DB,x.id)).toMatchObject({pages,read_at:time,provider:'TESTDATA OCR'});
    expect((await getBilag(x.DB,x.id)).supplier_name).toBe('TESTDATA bevar min rettelse');
  });

  it('filskift under aflæsning annullerer både forslag og kildelagring atomisk', async () => {
    const x = await setup();
    let release, began; const started = new Promise(resolve => { began=resolve; });
    x.env.RECEIPT_OCR.fetch.mockImplementation(() => { began(); return new Promise(resolve => { release=()=>resolve(Response.json({pages:pages.map(p=>p.join('\n')),provider:'TESTDATA sent'})); }); });
    const reading = readBilag(x.env,x.settings,x.id,actor,time); await started;
    const pdf = await samplePdf({kind:'kvittering',supplier:'TESTDATA ny original',address:'Testvej 1',cvr:'12345678',number:'TEST-NY',date:'2026-10-29',buyer:'TESTDATA',lines:[]});
    const replacement = await storeFile(x.DB,pdf,actor.email,time+1);
    await x.DB.prepare('UPDATE bilag SET file_id=? WHERE id=?').bind(replacement.file.id,x.id).run();
    release(); expect(await reading).toMatchObject({ok:false,cancelled:true});
    expect(await getBilagEvidence(x.DB,x.id)).toBeNull();
    expect(x.DB.sqlite.prepare('SELECT COUNT(*) n FROM bilag_ocr_evidence').get().n).toBe(0);
    expect((await getBilag(x.DB,x.id)).supplier_name).toBe('');
  });

  it('fejl fra OCR gemmes aldrig som læst kilde', async () => {
    const x = await setup(); x.env.RECEIPT_OCR.fetch.mockImplementation(async()=>new Response('',{status:503}));
    expect(await readBilag(x.env,x.settings,x.id,actor,time)).toMatchObject({ok:false});
    expect(await getBilagEvidence(x.DB,x.id)).toBeNull();
  });

  it('erstatter kun den aktuelle versions kilde ved en ny vellykket aflæsning', async () => {
    const x = await setup(); await readBilag(x.env,x.settings,x.id,actor,time);
    const reread = ['TESTDATA ny aflæsning', 'Total 125,00'];
    x.env.RECEIPT_OCR.fetch.mockImplementation(async()=>Response.json({pages:[reread.join('\n')],provider:'TESTDATA ny model'}));
    expect(await readBilag(x.env,x.settings,x.id,actor,time+1)).toMatchObject({ok:true});
    expect(await getBilagEvidence(x.DB,x.id)).toMatchObject({pages:[reread],provider:'TESTDATA ny model',read_at:time+1});
    expect(x.DB.sqlite.prepare('SELECT COUNT(*) n FROM bilag_ocr_evidence WHERE bilag_id=?').get(x.id).n).toBe(1);
    await x.DB.prepare('DELETE FROM bilag WHERE id=?').bind(x.id).run();
    expect(x.DB.sqlite.prepare('SELECT COUNT(*) n FROM bilag_ocr_evidence').get().n).toBe(0);
  });

  it('gemmer også PDF-tekst og markerer en udtrykkelig grænse på 100.000 kildetegn', async () => {
    const pdf = await samplePdf({kind:'faktura',supplier:'TESTDATA PDF',address:'Testvej 1',cvr:'12345678',number:'TEST-PDF',date:'2026-10-29',buyer:'TESTDATA',lines:[]});
    const x = await setup(pdf,'TESTDATA.pdf');
    vi.spyOn(pdfReader,'pdfText').mockResolvedValue({hasText:true,pages:[['TESTDATA '+ 'tekst '.repeat(20_000)]]});
    expect(await readBilag(x.env,x.settings,x.id,actor,time)).toMatchObject({ok:true});
    const evidence = await getBilagEvidence(x.DB,x.id);
    expect(evidence).toMatchObject({source:'pdf-tekst',provider:'',truncated:true});
    expect(evidence.pages.flat().join('\n')).toHaveLength(100_000);
    expect(x.env.RECEIPT_OCR.fetch).not.toHaveBeenCalled();
  });
});
