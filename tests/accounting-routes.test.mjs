// Synthetic data only. Real migrations, SQL transactions, auth/CSRF and multipart uploads.
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import routes from '../src/routes/admin-accounting.ts';
import { sessionMiddleware, csrfMiddleware } from '../src/lib/session.ts';
import { accountingReport, bankTotals } from '../src/lib/accounting.ts';

const base='/admin/bogfoering', origin='http://accounting.test', csrf='synthetic-csrf-token-01234567890123456789';
const period={from:'2026-11-01',to:'2026-11-30'};
const bankCsv='Date,Description,Amount,Currency,Balance,Transaction ID,State\n2026-11-23,Netto,-82.00,DKK,918.00,TEST-NETTO,COMPLETED\n2026-11-23,Apple,-125.00,DKK,793.00,TEST-APPLE-BUY,COMPLETED\n2026-11-24,Refund from Apple,125.00,DKK,918.00,TEST-APPLE-REFUND,COMPLETED';
const feeLines=['Revolut Business','Transaction confirmation','Status: Completed','Completed date: 23.11.2026','Description: Basic plan fee','Money out: 85,00 DKK','Currency: DKK','Transaction ID: TEST-FEE-001','Balance: 915,00 DKK'];
let sqlite,db,env,app;
function adapter(database){
  const normal=value=>value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  const stmt=(sql,values=[])=>({sql,values,bind:(...args)=>stmt(sql,args.map(normal)),
    first:async column=>{const row=database.prepare(sql).get(...values);return column ? row?.[column]??null : row??null;},
    all:async()=>({success:true,results:database.prepare(sql).all(...values)}),
    run:async()=>{const r=database.prepare(sql).run(...values);return{success:true,meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}});
  return {prepare:sql=>stmt(sql),batch:async statements=>{
    database.exec('BEGIN');try{const result=statements.map(s=>({success:true,results:database.prepare(s.sql).all(...s.values)}));database.exec('COMMIT');return result;}
    catch(error){database.exec('ROLLBACK');throw error;}
  }};
}
beforeEach(()=>{
  sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
  for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  db=adapter(sqlite);env={DB:db,ADMIN_EMAILS:'bookkeeper@example.test,colleague@example.test',APP_URL:origin,TEST_LABEL:'Testmiljø'};
  for(const [key,email] of [['a','bookkeeper@example.test'],['b','customer@example.test'],['c','colleague@example.test']]){
    sqlite.prepare('INSERT INTO sessions(id_hash,email,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)').run(createHash('sha256').update(key.repeat(48)).digest('hex'),email,csrf,Math.floor(Date.now()/1000)+366*86400,1);
  }
  app=new Hono();app.use('*',sessionMiddleware);app.use('*',csrfMiddleware);app.route('/admin',routes);
});
afterEach(()=>sqlite.close());
function request(path,{method='GET',body,as='a',headers={}}={}){
  return app.request(origin+path,{method,body,headers:{...(as?{Cookie:'vk_session='+as.repeat(48)}:{}),...(method==='POST'?{Origin:origin}:{}),...headers}},env);
}
function post(path,fields={},options={}){return request(path,{method:'POST',body:new URLSearchParams({_csrf:csrf,...fields}),...options});}
function multipart(path,bytes,name,fields={}){
  const body=new FormData();body.set('_csrf',csrf);body.set('file',new File([bytes],name,{type:name.endsWith('.csv')?'text/csv':'application/pdf'}));
  for(const [key,value] of Object.entries(fields)) body.set(key,String(value));
  return request(path,{method:'POST',body});
}
async function pdf(lines){const doc=await PDFDocument.create(),font=await doc.embedFont(StandardFonts.Helvetica),page=doc.addPage([595,842]);lines.forEach((line,i)=>page.drawText(line,{x:40,y:800-i*23,size:12,font}));return doc.save();}
const count=table=>sqlite.prepare('SELECT COUNT(*) AS n FROM '+table).get().n;
const receipt=id=>sqlite.prepare('SELECT * FROM accounting_receipts WHERE id=?').get(id);
async function redirected(response,pattern){const detail=await response.text();expect(response.status,detail.slice(-1200)).toBe(303);const match=response.headers.get('location')?.match(pattern);expect(match).toBeTruthy();return Number(match[1]);}
async function uploadReceipt(bytes,extra={}){return redirected(await multipart(base+'/bilag',bytes,'TEST-receipt.pdf',{kind:'purchase',...extra}),/\/bilag\/(\d+)/);}
async function previewCsv(csv=bankCsv){return redirected(await multipart(base+'/bank/import',csv,'TEST-bank.csv',{account:'TEST-Revolut-DKK'}),/\/import\/(\d+)/);}
async function confirmCsv(csv=bankCsv){const id=await previewCsv(csv);expect((await post(base+'/bank/import/'+id+'/bekraeft')).status).toBe(303);return id;}
function draftFields(id,extra={}){return{version:String(receipt(id).version),kind:'purchase',supplier:'TEST Webhosting',document_date:'2026-11-23',currency:'DKK',amount:'125,00',vat_amount:'25,00',deductible_vat_amount:'25,00',account_code:'7300',settlement_account_code:'5820',description:'Fiktivt testbilag',...extra};}

describe('internal bookkeeping routes with real shared database',()=>{
  it('protects every page, static asset and original with existing admin sessions',async()=>{
    const id=await uploadReceipt(await pdf(feeLines)),importId=await previewCsv();
    for(const path of [base,base+'/bilag/'+id,base+'/bilag/'+id+'/original',base+'/bank/import/'+importId+'/original',base+'/assets.js',base+'/assets.css',base+'/bank/mangelliste.csv']){
      expect((await request(path,{as:null})).status,path).toBe(303);
      expect((await request(path,{as:'b'})).status,path).toBe(403);
      const admin=await request(path);expect(admin.status,path).toBe(200);expect(admin.headers.get('cache-control')).toContain('no-store');
    }
    expect((await request(base+'/bilag/'+id,{as:'c'})).status).toBe(200);
    expect((await post(base+'/bank/1/fjern',{}, {as:'b'})).status).toBe(403);
  });
  it('keeps CSV original private, previews before confirmation, and confirms only once',async()=>{
    const id=await previewCsv();expect(count('accounting_bank_lines')).toBe(0);expect(count('accounting_journals')).toBe(0);
    const preview=await (await request(base+'/bank/import/'+id)).text();expect(preview).toContain('Netto');expect(preview).toContain('Apple');expect(preview).toContain('DKK');
    const original=await request(base+'/bank/import/'+id+'/original');expect(await original.text()).toBe(bankCsv);expect(original.headers.get('content-disposition')).toContain('attachment');
    expect((await post(base+'/bank/import/'+id+'/bekraeft')).status).toBe(303);expect((await post(base+'/bank/import/'+id+'/bekraeft')).status).toBe(303);
    expect(count('accounting_bank_lines')).toBe(3);expect(count('accounting_journals')).toBe(0);expect((await accountingReport(db,period)).expenses_minor).toBe(0);
  });
  it('removes and restores Netto; removes both Apple lines without changing movements or VAT',async()=>{
    await confirmCsv();const lines=sqlite.prepare('SELECT * FROM accounting_bank_lines ORDER BY id').all(),netto=lines[0],buy=lines[1],refund=lines[2];
    const totals=await bankTotals(db),report=await accountingReport(db,period);
    expect((await post(base+'/bank/'+netto.id+'/fjern',{reason:'Privat fejlkøb'})).status).toBe(303);
    expect(await (await request(base+'/bank/mangelliste.csv')).text()).not.toContain('Netto');
    expect(await (await request(base+'?tab=bank&vis=removed')).text()).toContain('Gendan');
    expect((await post(base+'/bank/'+netto.id+'/gendan')).status).toBe(303);expect(await (await request(base+'/bank/mangelliste.csv')).text()).toContain('Netto');
    expect((await post(base+'/bank/fjern-par',{line_id:buy.id,refund_id:refund.id})).status).toBe(303);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM accounting_bank_lines WHERE hidden=1').get().n).toBe(2);
    expect(await (await request(base+'/bank/mangelliste.csv')).text()).not.toContain('Apple');expect(count('accounting_bank_lines')).toBe(3);
    expect(await bankTotals(db)).toEqual(totals);expect(await accountingReport(db,period)).toEqual(report);
  });
  it('reads single PDF fee as 85 DKK with unknown VAT; rereads same receipt and preserves bytes',async()=>{
    const bytes=await pdf(feeLines),id=await uploadReceipt(bytes),before=receipt(id);
    expect(before).toMatchObject({supplier:'Revolut',date:'2026-11-23',gross_minor:8500,currency:'DKK',vat_minor:null,deductible_vat_minor:null,account_code:'7410'});
    expect((await post(base+'/bilag/'+id+'/aflaes',{version:before.version})).status).toBe(303);
    expect(receipt(id)).toMatchObject({id,file_id:before.file_id,version:before.version+1,gross_minor:8500,vat_minor:null});expect(count('accounting_receipts')).toBe(1);
    expect(new Uint8Array(await (await request(base+'/bilag/'+id+'/original')).arrayBuffer())).toEqual(bytes);
    const invalid=await post(base+'/bilag/'+id+'/bogfoer',draftFields(id,{supplier:'Revolut',amount:'85',vat_amount:'',deductible_vat_amount:'',account_code:'7410'}));
    expect(invalid.status).toBe(400);expect(count('accounting_journals')).toBe(0);
  });
  it('deduplicates identifiable PDF and CSV transactions across uploads',async()=>{
    await confirmCsv('Date,Description,Amount,Currency,Balance,Transaction ID,State\n2026-11-23,Basic plan fee,-85.00,DKK,915.00,TEST-FEE-001,COMPLETED');
    const id=await redirected(await multipart(base+'/bank/import',await pdf(feeLines),'TEST-same-transaction.pdf',{account:'TEST-Revolut-DKK'}),/\/import\/(\d+)/);
    expect(await (await request(base+'/bank/import/'+id)).text()).toContain('Allerede importeret');
    expect((await post(base+'/bank/import/'+id+'/bekraeft')).status).toBe(303);expect(count('accounting_bank_lines')).toBe(1);
  });
  it('posts linked invoice once, shows matching VAT/report, and appends traceable correction',async()=>{
    await confirmCsv('Date,Description,Amount,Currency,Transaction ID,State\n2026-11-23,TEST Webhosting,-125.00,DKK,TEST-HOSTING,COMPLETED');
    const bank=sqlite.prepare('SELECT id FROM accounting_bank_lines').get().id;
    const bytes=await pdf(['Supplier: TEST Webhosting','Invoice date: 23.11.2026','Invoice number: TEST-125','Webhosting','Total: 125,00 DKK','VAT: 25,00 DKK']);
    const id=await uploadReceipt(bytes),row=receipt(id);expect(row.deductible_vat_minor).toBeNull();
    expect((await post(base+'/bank/'+bank+'/tilknyt',{receipt_id:id})).status).toBe(303);
    const fields=draftFields(id);expect((await post(base+'/bilag/'+id+'/bogfoer',fields)).status).toBe(303);expect((await post(base+'/bilag/'+id+'/bogfoer',fields)).status).toBe(303);
    expect(count('accounting_journals')).toBe(1);expect(sqlite.prepare('SELECT SUM(debit_minor-credit_minor) AS total FROM accounting_journal_lines').get().total).toBe(0);
    expect(await accountingReport(db,period)).toMatchObject({purchase_vat_minor:2500,expenses_minor:10000,result_minor:-10000});
    expect(await (await request(base+'?tab=moms&from=2026-11-01&to=2026-11-30')).text()).toContain('Til gode');
    expect(await (await request(base+'?tab=rapporter&from=2026-11-01&to=2026-11-30')).text()).toContain('Webhosting');
    expect((await post(base+'/bilag/'+id+'/aflaes',{version:receipt(id).version})).status).toBe(409);
    const journal=sqlite.prepare('SELECT id FROM accounting_journals WHERE receipt_id=?').get(id).id,totals=await bankTotals(db);
    expect((await post(base+'/postering/'+journal+'/tilbagefoer',{date:'2026-11-24',reason:'Fiktiv rettelse af fradrag'})).status).toBe(303);
    const corrected=await redirected(await post(base+'/bilag/'+id+'/rettelseskladde'),/\/bilag\/(\d+)/);expect(corrected).not.toBe(id);
    expect((await post(base+'/bilag/'+corrected+'/bogfoer',draftFields(corrected,{deductible_vat_amount:'0'}))).status).toBe(303);
    expect(receipt(id).gross_minor).toBe(12500);expect(receipt(corrected).file_id).toBe(row.file_id);
    expect(await accountingReport(db,period)).toMatchObject({purchase_vat_minor:0,expenses_minor:12500});expect(await bankTotals(db)).toEqual(totals);
  });
  it('preserves the selected receipt type and shares drafts with another administrator',async()=>{
    const id=await uploadReceipt(await pdf(['Supplier: TEST Vendor','Credit note','Total: 125,00 DKK','VAT: 25,00 DKK']),{kind:'purchase_credit'});
    expect(receipt(id).kind).toBe('purchase_credit');expect((await request(base+'/bilag/'+id,{as:'c'})).status).toBe(200);
  });
  it('filters draft and posted receipt lists and preserves the selected status',async()=>{
    const draft=await uploadReceipt(await pdf(feeLines));
    const posted=await uploadReceipt(await pdf(['Supplier: TEST Webhosting','Invoice date: 23.11.2026','Total: 125,00 DKK','VAT: 25,00 DKK']));
    expect((await post(base+'/bilag/'+posted+'/bogfoer',draftFields(posted))).status).toBe(303);
    const draftPage=await (await request(base+'?tab=bilag&status=draft')).text();
    expect(draftPage).toContain(`<a class="acct-main-link" href="${base}/bilag/${draft}">`);
    expect(draftPage).not.toContain(`<a class="acct-main-link" href="${base}/bilag/${posted}">`);
    expect(draftPage).toContain('<option value="draft" selected>Kladder');
    const postedPage=await (await request(base+'?tab=bilag&status=posted')).text();
    expect(postedPage).not.toContain(`<a class="acct-main-link" href="${base}/bilag/${draft}">`);
    expect(postedPage).toContain(`<a class="acct-main-link" href="${base}/bilag/${posted}">`);
    expect(postedPage).toContain('<option value="posted" selected>Bogførte');
    const allPage=await (await request(base+'?tab=bilag&status=invalid')).text();
    expect(allPage).toContain(`<a class="acct-main-link" href="${base}/bilag/${draft}">`);
    expect(allPage).toContain(`<a class="acct-main-link" href="${base}/bilag/${posted}">`);
  });
  it('rejects missing/wrong CSRF and foreign Origin without importing data',async()=>{
    const id=await previewCsv();for(const options of [{body:new URLSearchParams({})},{body:new URLSearchParams({_csrf:'incorrect'})},{body:new URLSearchParams({_csrf:csrf}),headers:{Origin:'https://attacker.test'}}]){
      const response=await request(base+'/bank/import/'+id+'/bekraeft',{method:'POST',...options});expect(response.status).toBe(403);
    }
    expect(count('accounting_bank_lines')).toBe(0);expect(count('accounting_journals')).toBe(0);
  });
});
