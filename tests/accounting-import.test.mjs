import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  bankSemanticKey, extractAccountingText, normalizeBankMerchant, parseBankDate, parseBankMoney,
  parseRevolutCsv, parseRevolutPdfText, readAccountingReceipt,
} from '../src/lib/accounting-import.ts';

const opts = { account:'TEST-Revolut-DKK',currency:'DKK' };
const single = [
  'Revolut Business', 'Transaction confirmation', 'Status: Completed',
  'Completed date: 23.11.2026', 'Description: Basic plan fee', 'Money out: 85,00 DKK',
  'Currency: DKK', 'Transaction ID: TEST-FEE-001', 'Balance: 915,00 DKK',
];
const header = 'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance,ID';
const bankCsv = [header,
  'CARD_PAYMENT,Current,2026-11-23 08:00:00,2026-11-23 08:01:00,Netto,-200.00,0,DKK,COMPLETED,800.00,TEST-NETTO-001',
  'CARD_PAYMENT,Current,2026-11-23 09:00:00,2026-11-23 09:01:00,Apple,-125.00,0,DKK,COMPLETED,675.00,TEST-APPLE-001',
  'CARD_REFUND,Current,2026-11-24 09:00:00,2026-11-24 09:01:00,Refund from Apple,125.00,0,DKK,COMPLETED,800.00,TEST-APPLE-002',
].join('\n');

const createPdf = async (lines, count = 1) => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 0; n < count; n++) {
    const page = doc.addPage([595,842]);
    lines.forEach((line, i) => page.drawText(line,{x:40,y:800-i*24,size:12,font}));
  }
  return new Uint8Array(await doc.save());
};

describe('Veyro internal accounting: conservative Revolut import', () => {
  it('signed CSV keeps dates, direction, account, currency and merchant; importing is pure', () => {
    const r = parseRevolutCsv(bankCsv,opts);
    expect(r.errors).toEqual([]);
    expect(r.rows.map(row=>[row.date,row.merchant,row.amount_minor,row.currency,row.account_key])).toEqual([
      ['2026-11-23','netto',-20000,'DKK','test-revolut-dkk'],
      ['2026-11-23','apple',-12500,'DKK','test-revolut-dkk'],
      ['2026-11-24','apple',12500,'DKK','test-revolut-dkk'],
    ]);
    expect(r.rows[0].identity_keys).toHaveLength(2);
    expect(parseRevolutCsv(bankCsv,opts)).toEqual(r);
  });
  it('semicolon CSV keeps decimal comma, quoted separators, multiline descriptions and incoming/outgoing', () => {
    const r = parseRevolutCsv('\uFEFFDate;Description;Money out;Money in;Currency;State;Account;Transaction ID\r\n23/11/2026;"TEST supplier; shop\nCopenhagen";"1.234,56";;DKK;Completed;TEST-ACCOUNT;TEST-X\r\n24/11/2026;Refund;;125,00;DKK;Completed;TEST-ACCOUNT;TEST-Y');
    expect(r.errors).toEqual([]);
    expect(r.rows.map(row=>row.amount_minor)).toEqual([-123456,12500]);
    expect(r.rows[0].description).toContain('shop\nCopenhagen');
  });
  it('skips pending/reverted/declined but does not silently accept unknown state', () => {
    const r = parseRevolutCsv('Date,Description,Amount,Currency,State\n2026-11-23,TEST pending,-85,DKK,PENDING\n2026-11-23,TEST reverted,-85,DKK,REVERTED\n2026-11-23,TEST failed,-85,DKK,FAILED\n2026-11-23,TEST completed,-85,DKK,COMPLETED\n2026-11-23,TEST unknown,-85,DKK,MAYBE',opts);
    expect(r.skipped).toBe(3);expect(r.rows).toHaveLength(1);expect(r.errors).toHaveLength(1);
  });
  it('validates real calendar dates, minor units, zero values, and never rounds input', () => {
    expect(parseBankDate('31.02.2026')).toBe(null);
    expect(parseBankDate('23.11.2026 - 24.11.2026')).toBe(null);
    expect(parseBankDate('29 February 2028')).toBe('2028-02-29');
    expect(parseBankDate('23 Nov 2026')).toBe('2026-11-23');
    expect(parseBankDate('2026-11-23T23:59:59+01:00')).toBe('2026-11-23');
    expect(parseBankDate('2026-11-23 25:30:00')).toBe(null);
    expect(parseBankDate('11/12/26')).toBe(null);
    expect(parseBankDate('Invoice 2026-11-23')).toBe(null);
    expect(parseBankMoney('1.234,56 DKK')).toBe(123456);
    expect(parseBankMoney('1,234.56')).toBe(123456);
    expect(parseBankMoney('−125,00 kr.')).toBe(-12500);
    expect(parseBankMoney('(125.00)')).toBe(-12500);
    expect(parseBankMoney('(-125.00)')).toBe(null);
    expect(parseBankMoney('-125.00-')).toBe(null);
    expect(parseBankMoney('125')).toBe(12500);
    expect(parseBankMoney('1.234')).toBe(null);
    expect(parseBankMoney('12,3456')).toBe(null);
    const r = parseRevolutCsv('Date,Description,Amount,Currency\n2026-02-31,TEST bad date,-5,DKK\n2026-11-23,TEST fractional,-0.001,DKK\n2026-11-23,TEST zero,0,DKK',opts);
    expect(r.errors).toHaveLength(3);expect(r.rows).toHaveLength(0);
  });
  it('refuses absent account/currency and mismatching columns without inventing data', () => {
    expect(parseRevolutCsv('Date,Description,Amount\n2026-11-23,TEST fee,-85').errors.length).toBeGreaterThan(0);
    const extra = parseRevolutCsv('Date,Description,Amount,Currency\n2026-11-23,TEST,fee,-85,DKK',opts);
    expect(extra.errors[0]).toContain('kolonner');
    expect(parseRevolutCsv('Date,Description,Money out,Money in,Currency\n2026-11-23,TEST,85,85,DKK',opts).errors[0]).toContain('tvetydige');
  });
  it('refuses nonzero separate fees rather than guessing whether Amount includes them', () => {
    const r = parseRevolutCsv('Date,Description,Amount,Fee,Currency\n2026-11-23,TEST transfer,-100,1,DKK',opts);
    expect(r.rows).toEqual([]);expect(r.errors[0]).toContain('gebyr');
  });
  it('never merges two explicit source accounts via a shared UI fallback', () => {
    const r=parseRevolutCsv('Date,Description,Amount,Currency,Account,ID\n2026-11-23,Apple,-125,DKK,TEST-ACCOUNT-A,TEST-1\n2026-11-23,Apple,-125,DKK,TEST-ACCOUNT-B,TEST-1',opts);
    expect(r.errors).toEqual([]);expect(r.rows.map(row=>row.account_key)).toEqual(['test-account-a','test-account-b']);
    expect(r.rows[0].identity_keys.some(key=>r.rows[1].identity_keys.includes(key))).toBe(false);
    expect(r.warnings.some(w=>w.includes('Bankkontoen i filen'))).toBe(true);
  });
  it('PDF IBAN is authoritative and matches CSV IBAN despite an arbitrary fallback name', () => {
    const iban='LT00 0000 0000 0000 0000';
    const r=parseRevolutPdfText([[...single,'IBAN: '+iban]],opts);
    const c=parseRevolutCsv('Date,Description,Amount,Currency,IBAN,ID\n2026-11-23,Basic plan fee,-85,DKK,'+iban+',TEST-FEE-001',opts);
    expect(r.rows[0].account_key).toBe('lt000000000000000000');
    expect(r.rows[0].fingerprint).toBe(c.rows[0].fingerprint);
  });
  it('explicit currency in amount/header wins over fallback; conflicts remain errors', () => {
    const row=parseRevolutCsv('Date,Description,Amount (EUR)\n2026-11-23,TEST host,-85.00',opts).rows[0];
    expect(row.currency).toBe('EUR');
    expect(parseRevolutCsv('Date,Description,Amount,Currency\n2026-11-23,TEST host,-85.00 EUR,DKK',opts).errors[0]).toContain('valutaer');
  });
  it('refuses multiple PDF account identities instead of assigning all rows to the first account', () => {
    const r=parseRevolutPdfText([['Revolut account statement','Currency: DKK','IBAN: LT00 0000 0000 0000 0000','Date | Description | Amount','23.11.2026 | TEST A | -85.00','IBAN: LT00 0000 0000 0000 0001','23.11.2026 | TEST B | -85.00']],opts);
    expect(r.rows).toEqual([]);expect(r.errors[0]).toContain('flere konti');
  });
  it('does not apply fallback currency to ambiguous multicurrency PDF rows', () => {
    const r=parseRevolutPdfText([['Revolut account statement','DKK / EUR','Date | Description | Amount','23.11.2026 | TEST A | -85.00']],opts);
    expect(r.rows).toEqual([]);expect(r.errors[0]).toContain('valuta');
  });
  it('different external IDs remain separate even if the balance returns to the same number', () => {
    const r=parseRevolutCsv('Date,Description,Amount,Currency,Balance,ID\n2026-11-23,Apple,-125,DKK,875,TEST-A\n2026-11-23,Apple,-125,DKK,875,TEST-B',opts);
    expect(r.rows).toHaveLength(2);expect(r.errors).toEqual([]);expect(r.warnings.some(w=>w.includes('særskilte transaktions'))).toBe(true);
  });
  it('supports labelled completed transaction PDF Money out without invoice total', () => {
    const r = parseRevolutPdfText([single],opts);
    expect(r.errors).toEqual([]);expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({date:'2026-11-23',amount_minor:-8500,currency:'DKK',description:'Basic plan fee',external_id:'TEST-FEE-001',balance_minor:91500});
    expect(readAccountingReceipt([single])).toMatchObject({kind:'single_bank_transaction',supplier:'Revolut',date:'2026-11-23',total_minor:8500,currency:'DKK',account_code:'7410',vat_minor:null});
  });
  it('crossformat keys identify CSV and PDF independently by id and by balance', () => {
    const csv = parseRevolutCsv('Completed Date,Description,Amount,Currency,State,Balance,ID\n2026-11-23,Basic plan fee,-85.00,DKK,COMPLETED,915.00,TEST-FEE-001',opts).rows[0];
    const pdf = parseRevolutPdfText([single.filter(l=>!l.startsWith('Transaction ID'))],opts).rows[0];
    expect(csv.identity_keys).toContain(pdf.fingerprint);
    expect(bankSemanticKey(csv)).toBe(bankSemanticKey(pdf));
    const other = parseRevolutCsv('Date,Description,Amount,Currency,Balance,ID\n2026-11-23,Basic plan fee,-85.00,DKK,830.00,TEST-FEE-002',opts).rows[0];
    expect(other.identity_keys.some(key=>csv.identity_keys.includes(key))).toBe(false);
  });
  it('does not collapse two similar purchases lacking strong identity', () => {
    const r = parseRevolutCsv('Date,Description,Amount,Currency\n2026-11-23,TEST Apple,-125,DKK\n2026-11-23,TEST Apple,-125,DKK',opts);
    expect(r.rows).toHaveLength(2);
    expect(r.rows.every(row=>row.identity_strength==='ambiguous' && row.identity_keys.length===0)).toBe(true);
    expect(r.warnings.some(w=>w.includes('særskilte'))).toBe(true);
  });
  it('flags conflicting same transaction id and distinguishes other account/currency', () => {
    const r = parseRevolutCsv('Date,Description,Amount,Currency,ID\n2026-11-23,Apple,-125,DKK,TEST-1\n2026-11-23,Apple,-150,DKK,TEST-1',opts);
    expect(r.errors[0]).toContain('modstridende');
    const a=parseRevolutCsv(bankCsv,opts).rows[0];
    const b=parseRevolutCsv(bankCsv,{account:'TEST-OTHER'}).rows[0];
    expect(a.identity_keys.some(k=>b.identity_keys.includes(k))).toBe(false);
  });
  it('multi-transaction PDF stays individual bank rows and cannot produce one purchase', () => {
    const pages=[['Revolut Business','DKK account statement','Date | Description | Money out | Money in | Balance',
      '23.11.2026 | Basic plan fee | 85,00 | | 915,00',
      '23.11.2026 | Apple | 125,00 | | 790,00',
      '24.11.2026 | Refund from Apple | | 125,00 | 915,00',
    ]];
    const result=parseRevolutPdfText(pages,opts);
    expect(result.errors).toEqual([]);expect(result.rows.map(r=>r.amount_minor)).toEqual([-8500,-12500,12500]);
    expect(readAccountingReceipt(pages)).toMatchObject({kind:'multi_bank_statement',total_minor:null,vat_minor:null,account_code:null});
  });
  it('rejects ambiguous PDF columns, uncompleted individual transactions and multiple labelled blocks', () => {
    expect(parseRevolutPdfText([['Revolut DKK','Date  Description  Money out  Money in  Balance','23 Nov 2026  Apple  125.00  100.00']],opts).errors[0]).toContain('kolonner');
    expect(parseRevolutPdfText([single.map(l=>l.replace('Status: Completed','Status: Pending'))],opts).errors[0]).toContain('gennemført');
    expect(readAccountingReceipt([[...single,...single]])).toMatchObject({kind:'multi_bank_statement',total_minor:null});
  });
  it('validates every structured PDF row including month-first dates and malformed later rows', () => {
    const pages=[['Revolut DKK account statement','Description | Date | Amount','TEST A | November 23, 2026 | -85.00','TEST B | November 31, 2026 | -125.00']];
    const r=parseRevolutPdfText(pages,opts);
    expect(r.rows).toHaveLength(1);expect(r.rows[0].date).toBe('2026-11-23');expect(r.errors[0]).toContain('dato');
    expect(readAccountingReceipt(pages)).toMatchObject({kind:'multi_bank_statement',total_minor:null});
  });
});

describe('Veyro internal accounting receipt draft suggestions', () => {
  it('uses explicit invoice values and searchable account suggestions without VAT guessing', () => {
    const r=readAccountingReceipt([['Invoice','Supplier: TEST Hosting ApS','Invoice date: 23.11.2026','Webhosting','Total excluding VAT: 100.00 DKK','VAT 25% 25.00 DKK','Amount due: 125.00 DKK']]);
    expect(r).toMatchObject({supplier:'TEST Hosting ApS',date:'2026-11-23',total_minor:12500,currency:'DKK',account_code:'7300',vat_minor:2500});
  });
  it('leaves uncertain dates, amounts, currency and VAT open; a percentage is not an amount', () => {
    const r=readAccountingReceipt([['TEST software provider','23.11.2026','Software license','VAT 25%','Total 125.00']]);
    expect(r).toMatchObject({supplier:null,date:null,total_minor:null,currency:null,vat_minor:null,account_code:'7320'});
    expect(r.uncertain).toContain('total_minor');
  });
  it('supports explicit zero VAT amount without inferring zero from absence', () => {
    expect(readAccountingReceipt([['Invoice','Invoice date: 23.11.2026','Amount due: 85.00 DKK','VAT: 0.00 DKK']]).vat_minor).toBe(0);
    expect(readAccountingReceipt([['Invoice','Invoice date: 23.11.2026','Amount due: 85.00 DKK']]).vat_minor).toBe(null);
  });
  it('Revolut invoice is not misclassified just because it contains Basic plan fee', () => {
    const r=readAccountingReceipt([['Invoice','Supplier: Revolut','Invoice date: 23.11.2026','Basic plan fee','Amount due: 85.00 DKK']]);
    expect(r).toMatchObject({kind:'receipt',total_minor:8500,vat_minor:null});
  });
  it('an unsupported bank statement cannot become a single purchase from its summary total', () => {
    expect(readAccountingReceipt([['TEST Other Bank','Account statement','Invoice date: 23.11.2026','Amount due: 200.00 DKK','VAT: 40.00 DKK']])).toMatchObject({kind:'multi_bank_statement',total_minor:null,vat_minor:null});
  });
  it('supplier normalization pairs opposite Apple payments without matching unlike shops', () => {
    expect(normalizeBankMerchant('Refund from Apple')).toBe(normalizeBankMerchant('Card payment to APPLE'));
    expect(normalizeBankMerchant('Apple Store Aarhus')).not.toBe(normalizeBankMerchant('Apple Store Copenhagen'));
  });
  it('reads PDF text first without calling OCR and preserves original bytes', async () => {
    const bytes=await createPdf(single);
    const before=Buffer.from(bytes).toString('base64');let calls=0;
    const r=await extractAccountingText({RECEIPT_OCR:{fetch:async()=>{calls++;throw new Error('should not call');}}},{bytes,mime:'application/pdf'});
    expect(r.ok).toBe(true);expect(r.source).toBe('pdf-tekst');expect(calls).toBe(0);
    expect(Buffer.from(bytes).toString('base64')).toBe(before);
    expect(readAccountingReceipt(r.pages).total_minor).toBe(8500);
  });
  it('uses only existing private OCR binding for images and leaves manual draft on unavailable service', async () => {
    const bytes=new Uint8Array([137,80,78,71,13,10,26,10]);let request;
    const r=await extractAccountingText({RECEIPT_OCR:{fetch:async(req)=>{request=req;return Response.json({pages:[single.join('\n')],provider:'TEST private OCR'});}}},{bytes,mime:'image/png'});
    expect(request.url).toBe('https://receipt-ocr.internal/v1/extract');
    expect(Array.from(new Uint8Array(await request.arrayBuffer()))).toEqual(Array.from(bytes));
    expect(r).toMatchObject({ok:true,source:'ocr',provider:'TEST private OCR'});
    expect((await extractAccountingText({}, {bytes,mime:'image/png'})).ok).toBe(false);
  });
  it('does not silently truncate a PDF or skip an unreadable scanned page', async () => {
    const twentyOne=await createPdf(['TEST Document with sufficiently long readable text'],21);
    expect((await extractAccountingText({}, {bytes:twentyOne,mime:'application/pdf'})).warnings[0]).toContain('20 sider');
    const mixedDoc=await PDFDocument.create();const font=await mixedDoc.embedFont(StandardFonts.Helvetica);
    mixedDoc.addPage().drawText('TEST Readable text for the first page',{font});mixedDoc.addPage();
    const mixed=await extractAccountingText({}, {bytes:new Uint8Array(await mixedDoc.save()),mime:'application/pdf'});
    expect(mixed.ok).toBe(false);expect(mixed.warnings[0]).toContain('OCR');
  });
  it('rejects partial OCR output so a two-page statement cannot look like one receipt', async () => {
    const doc=await PDFDocument.create();doc.addPage();doc.addPage();
    const bytes=new Uint8Array(await doc.save());
    const partial={RECEIPT_OCR:{fetch:async()=>Response.json({pages:[single.join('\n')],provider:'TEST partial OCR'})}};
    expect(await extractAccountingText(partial,{bytes,mime:'application/pdf'})).toMatchObject({ok:false,source:'unread'});
    const blank={RECEIPT_OCR:{fetch:async()=>Response.json({pages:[single.join('\n'),''],provider:'TEST blank OCR'})}};
    expect(await extractAccountingText(blank,{bytes,mime:'application/pdf'})).toMatchObject({ok:false,source:'unread'});
    const complete={RECEIPT_OCR:{fetch:async()=>Response.json({pages:[single.join('\n'),single.join('\n')],provider:'TEST full OCR'})}};
    const result=await extractAccountingText(complete,{bytes,mime:'application/pdf'});
    expect(result.ok).toBe(true);expect(readAccountingReceipt(result.pages).kind).toBe('multi_bank_statement');
  });
});
