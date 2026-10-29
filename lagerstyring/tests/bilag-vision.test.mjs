import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatOriginalImage, RECEIPT_VISION_MODEL, runVisionChat } from '../src/lib/bilagvision.ts';
import { createBilag, getBilag } from '../src/lib/bilag.ts';
import * as files from '../src/lib/files.ts';
import { samplePdf } from '../src/lib/samplepdf.ts';

const actor = { email:'vision@example.invalid',name:'TESTDATA billedkontrol' }, time = 1793220000;
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
const open = [];
afterEach(()=>{vi.restoreAllMocks();for(const db of open.splice(0))db.close();});
function database() {
  const sqlite=new DatabaseSync(':memory:');open.push(sqlite);sqlite.exec('PRAGMA foreign_keys=ON');
  const dir=fileURLToPath(new URL('../migrations/',import.meta.url));
  for(const f of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort())sqlite.exec(readFileSync(`${dir}/${f}`,'utf8'));
  function prepared(sql,params=[]) {
    const values=()=>params.map(x=>x instanceof ArrayBuffer?Buffer.from(x):x===undefined?null:x);
    return {bind:(...p)=>prepared(sql,p),first:async col=>{const row=sqlite.prepare(sql).get(...values())??null;return col&&row?row[col]:row;},all:async()=>({results:sqlite.prepare(sql).all(...values()),success:true}),run:async()=>{const r=sqlite.prepare(sql).run(...values());return {meta:{changes:Number(r.changes)},success:true};}};
  }
  return {sqlite,prepare:sql=>prepared(sql),async batch(statements){sqlite.exec('BEGIN');try{const r=[];for(const s of statements)r.push(await s.run());sqlite.exec('COMMIT');return r;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
}
async function setup(bytes=png,name='TESTDATA.png') {
  const db=database(),stored=await files.storeFile(db,bytes,actor.email,time);
  expect(stored.ok).toBe(true);
  const id=await createBilag(db,stored.file,name,{doc_type:'kvittering',payment:'virksomhed',paid_by:'',job_hint:null,origin:'test',note:'TESTDATA',preview_file_id:null},actor,time);
  return {db,b:await getBilag(db,id),file:stored.file};
}
const schema={type:'object',properties:{answer:{type:'string'},sources:{type:'array'}},required:['answer','sources']};
function model(content=JSON.stringify({answer:'TESTDATA svar',sources:[]}),other={}) {return {run:vi.fn(async()=>({choices:[{finish_reason:'stop',message:{content,refusal:null},...other}]}))};}

describe('Privat originalbillede til bilagschat',()=>{
  it('bruger originalens præcise PNG-bytes uden offentlige links eller dataskrivninger',async()=>{
    const x=await setup(),image=await chatOriginalImage(x.db,x.b);
    expect(image).toEqual({mime:'image/png',dataUrl:`data:image/png;base64,${Buffer.from(png).toString('base64')}`});
    expect(await getBilag(x.db,x.b.id)).toEqual(x.b);
    expect(x.db.sqlite.prepare('SELECT COUNT(*) n FROM bilag_ocr_evidence').get().n).toBe(0);
  });
  it('accepterer JPEG-byteformat, men sender aldrig PDF eller et for stort billede som billedinput',async()=>{
    const jpeg=Uint8Array.from([0xff,0xd8,0xff,0xe0,0x00,0x10,0x4a,0x46,0x49,0x46]);
    const j=await setup(jpeg,'TESTDATA.jpg');
    expect(await chatOriginalImage(j.db,j.b)).toEqual({mime:'image/jpeg',dataUrl:`data:image/jpeg;base64,${Buffer.from(jpeg).toString('base64')}`});
    const pdf=await samplePdf({kind:'kvittering',supplier:'TESTDATA',address:'Testvej',cvr:'12345678',number:'TEST',date:'2026-10-29',buyer:'TESTDATA',lines:[]});
    const p=await setup(pdf,'TESTDATA.pdf');expect(await chatOriginalImage(p.db,p.b)).toBeNull();
    const big=await setup();await big.db.prepare('UPDATE files SET size=? WHERE id=?').bind(6*1024*1024+1,big.file.id).run();
    const read=vi.spyOn(files,'fileBytes');expect(await chatOriginalImage(big.db,big.b)).toBeNull();expect(read).not.toHaveBeenCalled();
  });
  it('afviser filskift, også hvis det sker mens originalbytes læses',async()=>{
    const x=await setup(),pdf=await samplePdf({kind:'kvittering',supplier:'TESTDATA ny original',address:'Testvej',cvr:'12345678',number:'TEST2',date:'2026-10-29',buyer:'TESTDATA',lines:[]});
    const replacement=await files.storeFile(x.db,pdf,actor.email,time+1),read=files.fileBytes;
    vi.spyOn(files,'fileBytes').mockImplementation(async(db,file)=>{const bytes=await read(db,file);await db.prepare('UPDATE bilag SET file_id=? WHERE id=?').bind(replacement.file.id,x.b.id).run();return bytes;});
    await expect(chatOriginalImage(x.db,x.b)).rejects.toMatchObject({status:409,message:expect.stringContaining('Originalbilaget er ændret')});
    await expect(chatOriginalImage(x.db,x.b)).rejects.toMatchObject({status:409});
  });
  it('sender kun valideret inlinebillede i Gemmas dokumenterede format og normaliserer choices-svaret',async()=>{
    const x=await setup(),image=await chatOriginalImage(x.db,x.b),ai=model();
    expect(await runVisionChat(ai,'TESTDATA system','TESTDATA spørgsmål',schema,image)).toEqual({response:{answer:'TESTDATA svar',sources:[]}});
    expect(ai.run).toHaveBeenCalledWith(RECEIPT_VISION_MODEL,{
      messages:[{role:'system',content:'TESTDATA system'},{role:'user',content:[{type:'image_url',image_url:{url:image.dataUrl,detail:'high'}},{type:'text',text:'TESTDATA spørgsmål'}]}],
      chat_template_kwargs:{enable_thinking:false},temperature:0.1,max_completion_tokens:1100,store:false,stream:false,
      response_format:{type:'json_schema',json_schema:{name:'receipt_review',schema,strict:true}},
    });
  });
  it('afviser eksterne URLer, forfalskede datatyper, ugyldig base64 og for stort billedinput før modelkald',async()=>{
    const ai=model();
    for(const image of [
      {mime:'image/png',dataUrl:'https://private.invalid/file'},
      {mime:'image/png',dataUrl:`data:image/jpeg;base64,${Buffer.from(png).toString('base64')}`},
      {mime:'application/pdf',dataUrl:'data:application/pdf;base64,JVBERg=='},
      {mime:'image/png',dataUrl:'data:image/png;base64,not base64'},
      {mime:'image/png',dataUrl:`data:image/png;base64,${'A'.repeat(8388612)}`},
    ])await expect(runVisionChat(ai,'TESTDATA','TESTDATA',schema,image)).rejects.toMatchObject({status:502});
    expect(ai.run).not.toHaveBeenCalled();
  });
  it('afviser refusal, afkortede svar og ugyldig JSON uden at vise rå modeldata',async()=>{
    const x=await setup(),image=await chatOriginalImage(x.db,x.b);
    for(const ai of [model('{"answer":"afkortet"',{finish_reason:'length'}),model(null),model('TESTDATA ukontrolleret fritekst'),model('{}',{message:{content:'{}',refusal:'TESTDATA afvisning'}})]) {
      await expect(runVisionChat(ai,'TESTDATA','TESTDATA',schema,image)).rejects.toMatchObject({status:502});
    }
    const failed={run:vi.fn(async()=>{throw new Error('TESTDATA internal https://provider.invalid/secret');})};
    await expect(runVisionChat(failed,'TESTDATA','TESTDATA',schema,image)).rejects.toMatchObject({status:502,message:'Billedgennemgangen kunne ikke gennemføres. Originalen og dine oplysninger er uændrede; prøv igen senere.'});
  });
});
