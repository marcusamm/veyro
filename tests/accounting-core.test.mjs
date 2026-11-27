// Synthetic data only. Real SQLite constraints and transaction rollback; no network/services.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach,afterEach,describe,it,expect } from 'vitest';
import { accountingDate,accountingEvents,accountingReport,approveReceipt,bankTotals,confirmImport,createCorrectionDraft,createImportPreview,createReceipt,getBankLine,getImport,getReceipt,isRefundPair,linkReceipt,listBankLines,listReceipts,refundCandidates,reversePosting,saveReceiptDraft,applyReceiptReading,searchAccounts,setBankLinesHidden,unlinkReceipt } from '../src/lib/accounting.ts';
import { parseRevolutCsv } from '../src/lib/accounting-import.ts';

const actor='bookkeeper@example.test',period={from:'2026-11-01',to:'2026-11-30'};
let sqlite,db,beforeBatch;
function adapter(database){
  const stmt=(sql,values=[])=>({sql,values,bind:(...args)=>stmt(sql,args),first:async()=>database.prepare(sql).get(...values)??null,all:async()=>({success:true,results:database.prepare(sql).all(...values)}),run:async()=>{const r=database.prepare(sql).run(...values);return{success:true,meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}});
  return {prepare:sql=>stmt(sql),batch:async stmts=>{
    if(beforeBatch){const fn=beforeBatch;beforeBatch=null;fn();}
    database.exec('BEGIN');
    try{const result=stmts.map(s=>({success:true,results:database.prepare(s.sql).all(...s.values)}));database.exec('COMMIT');return result;}
    catch(e){database.exec('ROLLBACK');throw e;}
  }};
}
beforeEach(()=>{sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');sqlite.exec(readFileSync(new URL('../migrations/0028_accounting.sql',import.meta.url),'utf8'));db=adapter(sqlite);beforeBatch=null;});
afterEach(()=>sqlite.close());
function original(name='original.pdf'){
  const r=sqlite.prepare('INSERT INTO files(sha256,mime,size,chunks,created_by,created_at) VALUES(?,?,4,1,?,1)').run(name+crypto.randomUUID(),'application/pdf',actor);
  sqlite.prepare('INSERT INTO file_chunks(file_id,idx,data) VALUES(?,0,?)').run(Number(r.lastInsertRowid),Buffer.from('%PDF'));
  return Number(r.lastInsertRowid);
}
function row(overrides={}){return {date:'2026-11-23',description:'Apple',merchant:'apple',amount_minor:-12500,currency:'DKK',account_key:'revolut-dkk',external_id:null,balance_minor:null,fingerprint:'ambiguous:fixture',identity_keys:[],identity_strength:'ambiguous',source_row:1,...overrides};}
async function bank(rows,filename='bank.csv',format='csv'){
  const preview=await createImportPreview(db,actor,{file_id:original(filename),file_name:filename,format,rows});
  await confirmImport(db,actor,preview.id);return preview;
}
async function receipt(overrides={}){return createReceipt(db,actor,{file_id:original(),file_name:'receipt.pdf',reading:{supplier:'Synthetic supplier',date:'2026-11-23',currency:'DKK',gross_minor:12500,vat_minor:2500,deductible_vat_minor:2500,account_code:'7320',...overrides}});}
const count=table=>sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

describe('shared internal bookkeeping',()=>{
  it('creates only additive internal tables and required searchable chart accounts',async()=>{
    expect((await searchAccounts(db,'7300')).map(x=>[x.code,x.name])).toEqual([['7300','Webhosting']]);
    expect((await searchAccounts(db,'webhosting')).map(x=>x.code)).toEqual(['7300']);
    expect((await searchAccounts(db,'7320'))[0].name).toBe('Køb af software');
    expect((await searchAccounts(db,'7410'))[0].name).toBe('Bankgebyrer');
    expect(accountingDate('2026-99-99')).toBe(false);expect(accountingDate('2026-02-31')).toBe(false);expect(accountingDate('2026-11-23')).toBe(true);
  });
  it('stores preview without bank postings, then confirms idempotently',async()=>{
    const file=original(),input={file_id:file,file_name:'statement.csv',format:'csv',rows:[row()]};
    const preview=await createImportPreview(db,actor,input);
    expect(count('accounting_bank_lines')).toBe(0);expect(count('accounting_journals')).toBe(0);
    expect((await createImportPreview(db,actor,input)).id).toBe(preview.id);
    expect(await confirmImport(db,actor,preview.id)).toEqual({imported:1,duplicates:0,already_confirmed:false});
    expect((await confirmImport(db,actor,preview.id)).already_confirmed).toBe(true);
    expect(count('accounting_bank_lines')).toBe(1);expect((await accountingReport(db,period)).expenses_minor).toBe(0);
  });
  it('Netto can be removed/restored without deleting bank history or changing totals/VAT',async()=>{
    await bank([row({description:'Netto',merchant:'netto',amount_minor:-8200})]);
    const [line]=await listBankLines(db,{missing:true}),balance=await bankTotals(db),report=await accountingReport(db,period);
    await setBankLinesHidden(db,actor,[line.id],true,'Privat fejlkøb');
    expect(await listBankLines(db,{missing:true})).toEqual([]);expect((await listBankLines(db,{hidden:true}))[0].id).toBe(line.id);
    expect(await bankTotals(db)).toEqual(balance);expect(await accountingReport(db,period)).toEqual(report);
    await setBankLinesHidden(db,actor,[line.id],false);
    expect((await listBankLines(db,{missing:true}))[0].id).toBe(line.id);expect(count('accounting_bank_lines')).toBe(1);
    expect((await accountingEvents(db,'bank_line',line.id)).map(x=>x.action)).toEqual(['restored','hidden']);
  });
  it('Apple −125/+125 pair hides together; refund candidates are exact and never guessed',async()=>{
    await bank([row(),row({source_row:2,amount_minor:12500}),row({source_row:3,amount_minor:12500,account_key:'other'}),row({source_row:4,amount_minor:12500,currency:'EUR'}),row({source_row:5,amount_minor:12499})]);
    const all=await listBankLines(db),buy=all.find(x=>x.amount_minor<0),refund=all.find(x=>x.source_row===2);
    expect((await refundCandidates(db,buy.id)).map(x=>x.id)).toEqual([refund.id]);
    const before=await bankTotals(db);
    await setBankLinesHidden(db,actor,[buy.id,refund.id],true,'Fuldt refunderet');
    expect((await listBankLines(db,{hidden:true}))).toHaveLength(2);expect(await bankTotals(db)).toEqual(before);expect((await accountingReport(db,period)).net_vat_minor).toBe(0);
    await expect(setBankLinesHidden(db,actor,[buy.id,all.find(x=>x.source_row===3).id],true)).rejects.toThrow('samme forhandler');
    await setBankLinesHidden(db,actor,[buy.id,refund.id],false);expect((await listBankLines(db,{hidden:true}))).toHaveLength(0);
  });
  it('presents multiple exact refund candidates for explicit choice',async()=>{
    await bank([row(),row({source_row:2,amount_minor:12500}),row({source_row:3,amount_minor:12500})]);
    const buy=(await listBankLines(db)).find(x=>x.amount_minor<0);
    expect(await refundCandidates(db,buy.id)).toHaveLength(2);expect((await listBankLines(db,{hidden:true}))).toHaveLength(0);
  });
  it('deduplicates identifiable CSV and PDF transactions without changing totals',async()=>{
    const parsed=parseRevolutCsv('Date,Description,Amount,Currency,Balance,Transaction ID,State\n2026-11-23,Apple,-125.00,DKK,875.00,tx-123,COMPLETED',{account:'Revolut DKK'});
    expect(parsed.errors).toEqual([]);await bank(parsed.rows);
    const pdfrow={...parsed.rows[0],external_id:null,identity_keys:parsed.rows[0].identity_keys.filter(k=>k.startsWith('balance:')),identity_strength:'balance',source_row:1};
    const preview=await createImportPreview(db,actor,{file_id:original(),file_name:'same.pdf',format:'pdf',rows:[pdfrow]});
    expect(preview.rows[0].duplicate_status).toBe('duplicate');expect((await confirmImport(db,actor,preview.id)).duplicates).toBe(1);
    expect(count('accounting_bank_lines')).toBe(1);expect((await bankTotals(db))[0].movement_minor).toBe(-12500);
  });
  it('identifiable CSV adds its ID to prior PDF balance identity for future imports',async()=>{
    const parsed=parseRevolutCsv('Date,Description,Amount,Currency,Balance,Transaction ID,State\n2026-11-23,Apple,-125.00,DKK,875.00,tx-123,COMPLETED',{account:'Revolut'}).rows[0];
    await bank([{...parsed,external_id:null,identity_keys:parsed.identity_keys.filter(k=>k.startsWith('balance:')),identity_strength:'balance'}],'first.pdf','pdf');
    const preview=await createImportPreview(db,actor,{file_id:original(),file_name:'second.csv',format:'csv',rows:[parsed]});
    await confirmImport(db,actor,preview.id);
    expect(count('accounting_bank_lines')).toBe(1);expect(count('accounting_bank_keys')).toBe(2);
  });
  it('distinct transaction IDs sharing merchant/date/amount/balance remain distinct',async()=>{
    const parsed=parseRevolutCsv('Date,Description,Amount,Currency,Balance,Transaction ID,State\n2026-11-23,Apple,-125.00,DKK,875.00,tx-123,COMPLETED\n2026-11-23,Apple,-125.00,DKK,875.00,tx-456,COMPLETED',{account:'Revolut'});
    await bank(parsed.rows);expect(count('accounting_bank_lines')).toBe(2);
    const ambiguous={...parsed.rows[0],external_id:null,identity_keys:parsed.rows[0].identity_keys.filter(k=>k.startsWith('balance:')),identity_strength:'balance'};
    const preview=await createImportPreview(db,actor,{file_id:original(),file_name:'ambiguous.pdf',format:'pdf',rows:[ambiguous]});
    expect(preview.rows[0].duplicate_status).toBe('review');expect(preview.rows[0].candidate_ids).toHaveLength(2);
    await expect(confirmImport(db,actor,preview.id)).rejects.toThrow('Afklar mulig dublet');
    await confirmImport(db,actor,preview.id,{'2':preview.rows[0].candidate_ids[0],'1':preview.rows[0].candidate_ids[0]});expect(count('accounting_bank_lines')).toBe(2);
  });
  it('rejects an incoming ID and balance that point to separate stored transactions',async()=>{
    const parsed=parseRevolutCsv('Date,Description,Amount,Currency,Balance,Transaction ID,State\n2026-11-23,Apple,-125.00,DKK,875.00,tx-a,COMPLETED\n2026-11-23,Apple,-125.00,DKK,750.00,,COMPLETED',{account:'Revolut'}).rows;
    await bank(parsed);expect(count('accounting_bank_lines')).toBe(2);
    const mixed={...parsed[0],balance_minor:parsed[1].balance_minor,identity_keys:[...parsed[0].identity_keys.filter(k=>k.startsWith('id:')),...parsed[1].identity_keys.filter(k=>k.startsWith('balance:'))]};
    const preview=await createImportPreview(db,actor,{file_id:original(),file_name:'conflicting.csv',format:'csv',rows:[mixed]});
    expect(preview.rows[0].duplicate_status).toBe('conflict');const before=await bankTotals(db),keys=count('accounting_bank_keys');
    await expect(confirmImport(db,actor,preview.id)).rejects.toThrow('peger på forskellige');
    expect(count('accounting_bank_keys')).toBe(keys);expect(await bankTotals(db)).toEqual(before);
  });
  it('ambiguous repeated purchases are retained and cross-file matches require an explicit choice',async()=>{
    await bank([row(),row({source_row:2})]);expect(count('accounting_bank_lines')).toBe(2);
    const preview=await createImportPreview(db,actor,{file_id:original(),file_name:'partial.pdf',format:'pdf',rows:[row()]});
    expect(preview.rows[0].duplicate_status).toBe('review');await expect(confirmImport(db,actor,preview.id)).rejects.toThrow('Afklar');
    await confirmImport(db,actor,preview.id,{'1':'new'});expect(count('accounting_bank_lines')).toBe(3);
  });
  it('guards imports against another browser changing identity matches between preview and commit',async()=>{
    const preview=await createImportPreview(db,actor,{file_id:original(),file_name:'one.csv',format:'csv',rows:[row()]});
    beforeBatch=()=>{sqlite.prepare("INSERT INTO accounting_imports(file_id,file_name,format,rows_json,digest,status,created_by,created_at) VALUES(?,'other','csv','[]','race','confirmed',?,1)").run(original(),actor);};
    await expect(confirmImport(db,actor,preview.id)).rejects.toThrow('Data er ændret');
    expect(count('accounting_bank_lines')).toBe(0);expect((await getImport(db,preview.id)).status).toBe('preview');
  });
  it('original bytes and posted rows cannot be overwritten or deleted',async()=>{
    const r=await receipt();await approveReceipt(db,actor,r.id,r.version);
    expect(()=>sqlite.prepare('UPDATE files SET size=3 WHERE id=?').run(r.file_id)).toThrow('immutable');
    expect(()=>sqlite.prepare('UPDATE file_chunks SET data=? WHERE file_id=?').run(Buffer.from('fake'),r.file_id)).toThrow('immutable');
    expect(()=>sqlite.prepare('DELETE FROM file_chunks WHERE file_id=?').run(r.file_id)).toThrow('immutable');
    expect(()=>sqlite.prepare('UPDATE accounting_receipts SET gross_minor=500 WHERE id=?').run(r.id)).toThrow('immutable');
    expect(()=>sqlite.exec('UPDATE accounting_journals SET description=\'changed\'')).toThrow('immutable');
    expect(()=>sqlite.exec('DELETE FROM accounting_journal_lines')).toThrow('immutable');
    expect(sqlite.prepare('SELECT data FROM file_chunks WHERE file_id=?').get(r.file_id).data).toEqual(new Uint8Array(Buffer.from('%PDF')));
  });
  it('receipt plus bank line posts once, balanced, with original+bank references and matching report/VAT',async()=>{
    await bank([row()]);const [line]=await listBankLines(db);const r=await receipt();await linkReceipt(db,actor,r.id,line.id);
    expect((await accountingReport(db,period)).expenses_minor).toBe(0);
    const journal=await approveReceipt(db,actor,r.id,r.version);expect(await approveReceipt(db,actor,r.id,r.version)).toBe(journal);
    expect(count('accounting_journals')).toBe(1);expect(count('accounting_journal_lines')).toBe(3);
    expect(sqlite.prepare('SELECT SUM(debit_minor-credit_minor) AS balance FROM accounting_journal_lines').get().balance).toBe(0);
    const report=await accountingReport(db,period);expect(report).toMatchObject({expenses_minor:10000,income_minor:0,purchase_vat_minor:2500,sales_vat_minor:0,net_vat_minor:-2500,result_minor:-10000});
    expect(report.entries[0]).toMatchObject({receipt_id:r.id,bank_line_id:line.id});expect((await getReceipt(db,r.id)).file_id).toBe(r.file_id);
    await setBankLinesHidden(db,actor,[line.id],true);expect(await accountingReport(db,period)).toEqual(report);
    await expect(saveReceiptDraft(db,actor,r.id,r.version,{gross_minor:1000})).rejects.toThrow('Bogførte bilag');
  });
  it('reuploading the same file returns the original receipt, even after posting',async()=>{
    const r=await receipt();await approveReceipt(db,actor,r.id,r.version);
    const duplicate=await createReceipt(db,actor,{file_id:r.file_id,file_name:'renamed.pdf',reading:{gross_minor:90000}});
    expect(duplicate.id).toBe(r.id);expect(duplicate.gross_minor).toBe(12500);expect(count('accounting_receipts')).toBe(1);
  });
  it('requires explicit VAT review, respects partial deductibility, never guesses VAT from bank fees',async()=>{
    const r=await receipt({supplier:'Revolut',gross_minor:8500,vat_minor:null,deductible_vat_minor:null,account_code:'7410',source_kind:'single_bank_transaction'});
    await expect(approveReceipt(db,actor,r.id,r.version)).rejects.toThrow('angivet moms');
    const ready=await saveReceiptDraft(db,actor,r.id,r.version,{vat_minor:0,deductible_vat_minor:0});await approveReceipt(db,actor,r.id,ready.version);
    expect(await accountingReport(db,period)).toMatchObject({expenses_minor:8500,purchase_vat_minor:0});
    const partial=await receipt({gross_minor:12500,vat_minor:2500,deductible_vat_minor:1000});await approveReceipt(db,actor,partial.id,partial.version);
    expect(await accountingReport(db,period)).toMatchObject({expenses_minor:20000,purchase_vat_minor:1000});
  });
  it('blocks posting while first OCR classification is pending',async()=>{
    const r=await receipt({reading_source:'pending'});
    await expect(approveReceipt(db,actor,r.id,r.version)).rejects.toThrow('endnu ikke afsluttet');expect(count('accounting_journals')).toBe(0);
    const ready=await applyReceiptReading(db,actor,r.id,r.version,{reading_source:'pdf-tekst'});await approveReceipt(db,actor,r.id,ready.version);expect(count('accounting_journals')).toBe(1);
  });
  it('never converts a multi-row statement to one expense even after entering amounts',async()=>{
    const r=await receipt({source_kind:'multi_bank_statement'});
    await expect(approveReceipt(db,actor,r.id,r.version)).rejects.toThrow('flere poster');
    const reread=await applyReceiptReading(db,actor,r.id,r.version,{source_kind:'receipt',gross_minor:12300});
    expect(reread.source_kind).toBe('multi_bank_statement');await expect(approveReceipt(db,actor,r.id,reread.version)).rejects.toThrow('flere poster');
    expect(count('accounting_journals')).toBe(0);
  });
  it('rereading updates the same unposted receipt and preserves original bytes; stale changes roll back',async()=>{
    const r=await receipt({vat_minor:null,deductible_vat_minor:null});
    const next=await applyReceiptReading(db,actor,r.id,r.version,{supplier:'New reading',reading_source:'ocr',uncertain:['vat_minor']});
    expect(next.id).toBe(r.id);expect(next.file_id).toBe(r.file_id);expect(next.version).toBe(r.version+1);expect(count('accounting_receipts')).toBe(1);
    await expect(saveReceiptDraft(db,actor,r.id,r.version,{supplier:'Stale overwrite'})).rejects.toThrow('Data er ændret');expect((await getReceipt(db,r.id)).supplier).toBe('New reading');
  });
  it('posting fails atomically when another colleague changes the draft or bank link',async()=>{
    const r=await receipt();beforeBatch=()=>sqlite.prepare('UPDATE accounting_receipts SET version=version+1 WHERE id=?').run(r.id);
    await expect(approveReceipt(db,actor,r.id,r.version)).rejects.toThrow('Data er ændret');expect(count('accounting_journals')).toBe(0);expect(count('accounting_journal_lines')).toBe(0);
  });
  it('rejects mismatched currency/amount or reuse of bank lines and allows correcting a draft link',async()=>{
    await bank([row(),row({source_row:2,amount_minor:-11000}),row({source_row:3,currency:'EUR'})]);const lines=await listBankLines(db),r=await receipt();
    await expect(linkReceipt(db,actor,r.id,lines.find(l=>l.source_row===2).id)).rejects.toThrow('beløb');
    await expect(linkReceipt(db,actor,r.id,lines.find(l=>l.source_row===3).id)).rejects.toThrow('valuta');
    await linkReceipt(db,actor,r.id,lines.find(l=>l.source_row===1).id);const other=await receipt();
    await expect(linkReceipt(db,actor,other.id,lines.find(l=>l.source_row===1).id)).rejects.toThrow('allerede');
    await unlinkReceipt(db,actor,r.id,r.version);expect((await getReceipt(db,r.id)).bank_line_id).toBeNull();
  });
  it('sale and credit notes produce signed VAT and income from the same journal period',async()=>{
    const sale=await receipt({kind:'sale',account_code:'1000',gross_minor:100000,vat_minor:20000,deductible_vat_minor:0});await approveReceipt(db,actor,sale.id,sale.version);
    const credit=await receipt({kind:'sale_credit',account_code:'1000',gross_minor:12500,vat_minor:2500,deductible_vat_minor:0});await approveReceipt(db,actor,credit.id,credit.version);
    expect(await accountingReport(db,period)).toMatchObject({income_minor:70000,sales_vat_minor:17500,net_vat_minor:17500,result_minor:70000});
    expect(await accountingReport(db,{from:'2026-12-01',to:'2026-12-31'})).toMatchObject({income_minor:0,sales_vat_minor:0});
  });
  it('foreign-currency originals require explicit DKK bookkeeping values and retain original money',async()=>{
    const r=await receipt({currency:'EUR',gross_minor:10000,vat_minor:0,deductible_vat_minor:0});
    await expect(approveReceipt(db,actor,r.id,r.version)).rejects.toThrow('DKK-beløb');
    const ready=await saveReceiptDraft(db,actor,r.id,r.version,{base_gross_minor:74600,base_vat_minor:0,base_deductible_vat_minor:0});await approveReceipt(db,actor,r.id,ready.version);
    expect((await getReceipt(db,r.id))).toMatchObject({currency:'EUR',gross_minor:10000});expect((await accountingReport(db,period)).expenses_minor).toBe(74600);
  });
  it('corrections append reversal and replacement without editing history or duplicating bank totals',async()=>{
    await bank([row()]);const [line]=await listBankLines(db),r=await receipt();await linkReceipt(db,actor,r.id,line.id);
    const original=await approveReceipt(db,actor,r.id,r.version),balance=await bankTotals(db);
    const rev=await reversePosting(db,actor,original,'2026-11-24','Forkert fradrag');expect(await reversePosting(db,actor,original,'2026-11-24','Gentaget klik')).toBe(rev);
    expect((await accountingReport(db,period)).result_minor).toBe(0);expect((await accountingReport(db,period)).purchase_vat_minor).toBe(0);
    const correction=await createCorrectionDraft(db,actor,r.id);expect((await createCorrectionDraft(db,actor,r.id)).id).toBe(correction.id);expect(correction.bank_line_id).toBe(line.id);
    const ready=await saveReceiptDraft(db,actor,correction.id,correction.version,{deductible_vat_minor:0});const correctedJournal=await approveReceipt(db,actor,ready.id,ready.version);
    expect(await accountingReport(db,period)).toMatchObject({expenses_minor:12500,purchase_vat_minor:0,result_minor:-12500});expect(await bankTotals(db)).toEqual(balance);
    await reversePosting(db,actor,correctedJournal,'2026-11-25','Anden rettelse');const again=await createCorrectionDraft(db,actor,correction.id);expect(again.correction_of).toBe(correction.id);expect(again.bank_line_id).toBe(line.id);
    expect((await getReceipt(db,r.id))).toMatchObject({status:'posted',deductible_vat_minor:2500});
  });
  it('database refuses direct unbalanced or initially-posted journals',async()=>{
    const r=await receipt();
    expect(()=>sqlite.prepare("INSERT INTO accounting_journals(operation_key,receipt_id,date,description,status,created_by,created_at) VALUES('bad',?,'2026-11-23','invalid','posted',?,1)").run(r.id,actor)).toThrow('pending');
    sqlite.prepare("INSERT INTO accounting_journals(operation_key,receipt_id,date,description,created_by,created_at) VALUES('pending',?,'2026-11-23','invalid',?,1)").run(r.id,actor);
    expect(()=>sqlite.exec("UPDATE accounting_journals SET status='posted'")).toThrow('must balance');
    expect(()=>sqlite.prepare("UPDATE accounting_receipts SET status='posted' WHERE id=?").run(r.id)).toThrow('balanced posted');
  });
  it('prevents a reversed original from claiming a different bank transaction',async()=>{
    const r=await receipt(),j=await approveReceipt(db,actor,r.id,r.version);await reversePosting(db,actor,j,'2026-11-24','Rettelse');
    await bank([row()]);const [line]=await listBankLines(db);await expect(linkReceipt(db,actor,r.id,line.id)).rejects.toThrow('tilbageført');
  });
  it('returns all missing lines after the former 2,000-row cutoff',async()=>{
    const p=await bank([row()]);
    const insert=sqlite.prepare('INSERT INTO accounting_bank_lines(import_id,source_row,date,description,merchant,amount_minor,currency,account_key,semantic_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,1)');
    sqlite.exec('BEGIN');for(let i=2;i<=2001;i++)insert.run(p.id,i,'2026-11-23','Synthetic line '+i,'merchant '+i,-100,'DKK','revolut-dkk','synthetic-'+i);sqlite.exec('COMMIT');
    expect(await listBankLines(db,{missing:true})).toHaveLength(2001);expect((await bankTotals(db))[0].count).toBe(2001);
  });
  it('imports a full supported 250-line statement atomically',async()=>{
    const lines=Array.from({length:250},(_,i)=>row({source_row:i+1,description:'Vendor '+i,merchant:'vendor '+i,external_id:'tx-'+i,identity_keys:['id:'+JSON.stringify(['revolut-dkk','DKK','tx-'+i]),'balance:'+JSON.stringify(['revolut-dkk','DKK','2026-11-23',-12500,i,'vendor '+i])],identity_strength:'external_id',balance_minor:i}));
    await bank(lines);expect(count('accounting_bank_lines')).toBe(250);expect(count('accounting_bank_keys')).toBe(500);expect(count('accounting_journals')).toBe(0);
  });
});
