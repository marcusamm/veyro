import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { describe, expect, it, vi } from 'vitest';
import { createBilag, getBilag } from '../src/lib/bilag.ts';
import { ocrJob } from '../src/lib/bilagqueue.ts';
import { storeFile } from '../src/lib/files.ts';

describe('Cloudflare-runtime: privat OCR-kø og alarm', () => {
  it('kører den eksporterede Durable Object med rigtig D1 og gemmer kun kontrollerbare forslag', async () => {
    const bundle = await build({entryPoints:[fileURLToPath(new URL('../src/index.ts',import.meta.url))],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'});
    let calls = 0;
    const mf = new Miniflare(convertV4MiniflareOptions({
      modules:true, script:bundle.outputFiles[0].text, compatibilityDate:'2026-10-01',
      bindings:{APP_URL:'https://test.invalid'}, d1Databases:['DB'],
      durableObjects:{BILAG_OCR_QUEUE:{className:'BilagOcrQueue',useSQLite:true}},
      serviceBindings:{RECEIPT_OCR:async request=>{
        expect(request.url).toBe('https://receipt-ocr.internal/v1/extract');
        expect((await request.arrayBuffer()).byteLength).toBeGreaterThan(0); calls++;
        return Response.json({pages:['TESTDATA CPU Grossist ApS\nFaktura\nDato: 29.10.2026\nNetto  100,00\nMoms  25,00\nI alt inkl. moms  125,00'],provider:'TESTDATA runtime OCR'});
      }},
    }));
    try {
      const db = await mf.getD1Database('DB');
      const folder = fileURLToPath(new URL('../migrations/',import.meta.url));
      // D1.exec splits by newline, which is unsuitable for multiline trigger
      // bodies. Compile the migrated schema with SQLite and submit each full
      // schema statement separately to the actual workerd D1 instance.
      const schema = new DatabaseSync(':memory:');
      try {
        for (const file of readdirSync(folder).filter(f=>f.endsWith('.sql')).sort()) schema.exec(readFileSync(`${folder}/${file}`,'utf8'));
        for (const row of schema.prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,rowid").all()) await db.prepare(row.sql).run();
      } finally { schema.close(); }
      const actor = {email:'test-runtime@example.invalid',name:'TESTDATA runtime ejer'}, now = Math.floor(Date.now()/1000);
      const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'));
      const file = await storeFile(db,png,actor.email,now); expect(file.ok).toBe(true);
      const id = await createBilag(db,file.file,'TESTDATA-runtime.png',{doc_type:'faktura',payment:'virksomhed',paid_by:'',job_hint:null,origin:'test',note:'TESTDATA',preview_file_id:null},actor,now);
      const namespace = await mf.getDurableObjectNamespace('BILAG_OCR_QUEUE');
      const response = await namespace.getByName('bilag-ocr').fetch('https://bilag-ocr.internal/enqueue',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,actor})});
      expect(await response.json()).toMatchObject({ok:true});
      await vi.waitFor(async()=>expect((await ocrJob(db,id)).state).toBe('done'),{timeout:15000,interval:100});
      expect(calls).toBe(1); expect(await getBilag(db,id)).toMatchObject({status:'klar',total:12500,ocr_provider:'TESTDATA runtime OCR',reading_token:''});
      expect((await db.prepare('SELECT COUNT(*) n FROM movements').first()).n).toBe(0);
      expect((await db.prepare('SELECT COUNT(*) n FROM purchase_lines').first()).n).toBe(0);
    } finally { await mf.dispose(); }
  });
});
