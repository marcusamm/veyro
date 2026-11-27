import { describe, expect, it } from 'vitest';
import { accountingPage } from '../src/views/accounting.ts';
import { ACCOUNTING_JS } from '../src/views/accounting-client.ts';

const render = async data => String(await accountingPage({ csrf: 'synthetic_csrf_token', tab: 'bilag', ...data }));
const accounts = [
  { code: '5820', name: 'Bank', kind: 'asset' },
  { code: '7300', name: 'Webhosting', kind: 'expense' },
  { code: '7320', name: 'Køb af software', kind: 'expense' },
  { code: '7410', name: 'Bankgebyrer', kind: 'expense' },
];
const fee = {
  id: 1, version: 1, status: 'draft', file_name: 'fiktivt-revolut-gebyr.pdf', kind: 'purchase',
  supplier: 'Revolut', date: '2026-11-23', currency: 'DKK', gross_minor: 8500,
  vat_minor: null, deductible_vat_minor: null, account_code: '7410',
};
const bank = { id: 11, date: '2026-11-23', description: 'Apple', merchant: 'Apple', amount_minor: -12500, currency: 'DKK', account_key: 'FIKTIV-DKK' };

describe('Accounting UI — explicit decisions and escaped private records', () => {
  it('keeps four sections in one navigation and upload directly available', async () => {
    const page = await render({});
    for (const label of ['Bilag', 'Bankafstemning', 'Moms', 'Rapporter', 'Upload bilag']) expect(page).toContain(label);
    expect(page).toContain('aria-label="Bogføring"');
    expect(page).toContain('href="/admin/bogfoering/bilag/ny"');
  });

  it('shows the 85 kr fee draft without inventing VAT or deductible VAT', async () => {
    const page = await render({ view: 'receipt', receipt: fee, accounts });
    expect(page).toContain('name="amount" inputmode="decimal" maxlength="18" required value="85,00"');
    expect(page).toContain('name="vat_amount" inputmode="decimal" maxlength="18" required value=""');
    expect(page).toContain('name="deductible_vat_amount" inputmode="decimal" maxlength="18" required value=""');
    expect(page).toContain('Aflæs igen');
    expect(page).toContain('Godkend og bogfør');
    expect(page).toContain('formnovalidate>Gem kladde');
  });

  it('provides number and name in the searchable account source and keeps explicit foreign conversion', async () => {
    const page = await render({ view: 'receipt', receipt: { ...fee, currency: 'EUR' }, accounts });
    expect(page).toContain('<option value="7300">7300 · Webhosting</option>');
    expect(page).toContain('7320 · Køb af software');
    expect(page).toContain('7410 · Bankgebyrer');
    expect(page).toContain('name="settlement_account_code"');
    expect(page).toContain('name="base_amount"');
    expect(page).toContain('der gættes ikke en valutakurs');
    expect(() => new Function(ACCOUNTING_JS)).not.toThrow();
    expect(ACCOUNTING_JS).not.toContain('localStorage');
  });

  it('blocks approval while the initial reading is pending and explains recovery', async () => {
    const page = await render({ view:'receipt', receipt:{...fee,reading_source:'pending'}, accounts });
    expect(page).toContain('formaction="/admin/bogfoering/bilag/1/bogfoer" disabled>Afventer aflæsning');
    expect(page).toContain('Genindlæs siden, eller vælg Aflæs igen');
    expect(page).toContain('formnovalidate>Gem kladde');
  });

  it('offers unfinished and matching receipts but excludes known bank mismatches', async () => {
    const receipts = [
      {...fee,id:1,currency:'',gross_minor:null},
      {...fee,id:2,gross_minor:12500},
      {...fee,id:3,gross_minor:12000},
      {...fee,id:4,gross_minor:12500,currency:'EUR'},
      {...fee,id:5,gross_minor:12500,kind:'purchase_credit'},
      {...fee,id:6,gross_minor:null,kind:'sale'},
      {...fee,id:7,gross_minor:12500,kind:'sale_credit'},
      {...fee,id:8,gross_minor:12500,source_kind:'multi_bank_statement'},
      {...fee,id:9,gross_minor:12500,bank_line_id:99},
      {...fee,id:10,gross_minor:12500,reversed:true},
    ];
    const page=await render({tab:'bank',bank_lines:[bank],receipts});
    for(const id of [1,2,7]) expect(page).toContain(`<option value="${id}">B${id} ·`);
    for(const id of [3,4,5,6,8,9,10]) expect(page).not.toContain(`<option value="${id}">B${id} ·`);
  });

  it('makes posted receipts immutable and exposes correction only with a traceable reversal', async () => {
    const page = await render({ view: 'receipt', receipt: { ...fee, status: 'posted', journal_id: 42 }, accounts });
    expect(page).not.toContain('>Aflæs igen<');
    expect(page).not.toContain('>Godkend og bogfør<');
    expect(page).toContain('action="/admin/bogfoering/postering/42/tilbagefoer"');
    const reversed = await render({ view: 'receipt', receipt: { ...fee, status: 'posted', journal_id: 42, reversed: true }, accounts });
    expect(reversed).toContain('action="/admin/bogfoering/bilag/1/rettelseskladde"');
    expect(reversed).not.toContain('action="/admin/bogfoering/postering/42/tilbagefoer"');
  });

  it('hides obsolete reading warnings after posting and formats changed audit fields for people', async () => {
    const page=await render({view:'receipt',receipt:{...fee,status:'posted',reading_note:'Usikre felter før godkendelse',journal_id:42},accounts,events:[
      {action:'draft_saved',actor:'test@example.test',created_at:1,detail:JSON.stringify({before:{supplier:'TEST før',gross_minor:8500,currency:'DKK',vat_minor:null,account_code:'7410'},after:{supplier:'TEST efter',gross_minor:12500,currency:'DKK',vat_minor:2500,account_code:'7300'},technical_unknown:'DO NOT DISPLAY'})},
      {action:'posted',actor:'test@example.test',created_at:2,detail:JSON.stringify({operation:'technical-operation-key',bank_line_id:11,base_gross_minor:12500,base_vat_minor:2500,deductible_vat_minor:2500})},
    ]});
    expect(page).not.toContain('Usikre felter før godkendelse');
    expect(page).toContain('Leverandør / kunde: TEST før → TEST efter');
    expect(page).toContain('Beløb inkl. moms: 85,00 kr. → 125,00 kr.');
    expect(page).toContain('Angivet moms: Ikke udfyldt → 25,00 kr.');
    expect(page).toContain('Konto: 7410 → 7300');
    expect(page).toContain('Banklinje #11');
    expect(page).toContain('Bogført beløb: 125,00 kr.');
    expect(page).not.toContain('technical-operation-key');expect(page).not.toContain('DO NOT DISPLAY');
    expect(page).not.toContain('gross_minor');
  });

  it('escapes audit values and reasons and omits unknown structured keys',async()=>{
    const attack='<img src=x onerror=alert(1)>';
    const page=await render({view:'receipt',receipt:fee,events:[{action:'draft_saved',actor:'test@example.test',created_at:1,detail:JSON.stringify({before:{supplier:'Before'},after:{supplier:attack},reason:attack,unknown:{attack}})},{action:'unknown_event',actor:'test@example.test',created_at:2,detail:JSON.stringify({unknown:'PRIVATE TECHNICAL DUMP'})}]});
    expect(page).not.toContain(attack);expect(page).toContain('Leverandør / kunde: Before → &lt;img');expect(page).toContain('Begrundelse: &lt;img');
    expect(page).not.toContain('PRIVATE TECHNICAL DUMP');expect(page).toContain('Hændelse registreret');
  });

  it('shows both sides of a refund and restore controls while preserving the bank-history distinction', async () => {
    const page = await render({ tab: 'bank', bank_lines: [bank], refund_pairs: [{ purchase: bank, refund: { ...bank, id: 12, date: '2026-11-24', amount_minor: 12500 }, ambiguous: true }] });
    expect(page).toContain('−125,00 kr.');
    expect(page).toContain('+125,00 kr.');
    expect(page).toContain('name="line_id" value="11"');
    expect(page).toContain('name="refund_id" value="12"');
    expect(page).toContain('Fjern begge linjer');
    expect(page).toContain('Flere match er mulige');
    const removed = await render({ tab: 'bank', bank_mode: 'removed', bank_lines: [{ ...bank, hidden: true }] });
    expect(removed).toContain('action="/admin/bogfoering/bank/11/gendan"');
    expect(removed).not.toContain('>Fjern fra liste<');
  });

  it('requires an explicit ambiguity resolution and prevents conflicting import confirmation', async () => {
    const preview = { id: 'preview-one', file_name: 'fiktiv.csv', rows: [{ ...bank, source_row: 2, duplicate_status: 'review', candidate_ids: [11] }] };
    const page = await render({ tab: 'bank', import_preview: preview });
    expect(page).toContain('name="resolution_2" form="bank-confirm" required');
    expect(page).toContain('<option value="">Vælg efter kontrol</option>');
    expect(page).toContain('<option value="11">Allerede importeret som banklinje #11</option>');
    expect(page).toContain('<option value="new">Ny, selvstændig transaktion</option>');
    const blocked = await render({ tab: 'bank', import_preview: { ...preview, rows: [{ ...bank, duplicate_status: 'conflict' }] } });
    expect(blocked).toContain('type="submit" disabled>Bekræft import');
    const confirmed = await render({ tab: 'bank', import_preview: { ...preview, status: 'confirmed' } });
    expect(confirmed).not.toContain('name="resolution_2"');
    expect(confirmed).not.toContain('>Bekræft import<');
  });

  it('escapes supplier text, filenames and bank descriptions instead of running document content', async () => {
    const attack = '<img src=x onerror=alert(1)>';
    const page = await render({ view: 'receipt', receipt: { ...fee, supplier: attack, file_name: attack, note: '</textarea><script>alert(1)</script>' }, accounts });
    expect(page).not.toContain(attack);
    expect(page).not.toContain('<script>alert(1)</script>');
    expect(page).toContain('&lt;img');
    const bankPage = await render({ tab: 'bank', bank_lines: [{ ...bank, description: attack }] });
    expect(bankPage).not.toContain(attack);
  });

  it('labels negative net VAT as til gode and retains the chosen period when opening reports', async () => {
    const report = { sales_vat_minor: 1000, purchase_vat_minor: 2500, net_vat_minor: -1500, income_minor: 4000, expenses_minor: 10000, result_minor: -6000, accounts: [], entries: [] };
    const page = await render({ tab: 'moms', period: { from: '2026-11-01', to: '2026-11-30' }, report });
    expect(page).toContain('Til gode');
    expect(page).toContain('15,00 kr.');
    expect(page).toContain('tab=rapporter&from=2026-11-01&to=2026-11-30');
    expect(page).toContain('Kladder og bankimport indgår ikke');
  });
});
