/** Veyros interne regnskab. Eksisterende adminsession og global CSRF; intet kunderegnskab. */
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';
import { isAdmin } from '../lib/session';
import { render } from '../render';
import { errorPage } from '../views/pages';
import { accountingPage, ACCOUNTING_CSS, type AccountingPageData, type AccountingTab } from '../views/accounting';
import { ACCOUNTING_JS } from '../views/accounting-client';
import {
  AccountingError, accountingDate, accountingEvents, accountingReport, approveReceipt, applyReceiptReading,
  bankTotals, confirmImport, createCorrectionDraft, createImportPreview, createReceipt, getBankLine,
  getImport, getReceipt, isRefundPair, linkReceipt, listBankLines, listReceipts, reversePosting,
  saveReceiptDraft, searchAccounts, setBankLinesHidden,
  type ReceiptFields, type ReceiptKind, type ReceiptReading, type ReceiptRow, type ImportResolution,
} from '../lib/accounting';
import { fileBytes, getFile, storeAccountingOriginal } from '../lib/accounting-files';
import { extractAccountingText, parseBankMoney, parseRevolutCsv, parseRevolutPdfText, readAccountingReceipt } from '../lib/accounting-import';
import { sha256Bytes } from '../../lagerstyring/src/lib/files';
import { toCsv } from '../lib/csv';

const r = new Hono<AppEnv>();
const BASE = '/admin/bogfoering';
const who = (c: Context<AppEnv>) => c.get('session')!.email.toLowerCase();
const id = (value: string | undefined) => {
  const n = Number(value);
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < 1) throw new AccountingError('Ugyldigt nummer.', 404);
  return n;
};
const guard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = c.get('session');
  if (!session) return c.redirect('/admin/login', 303);
  if (!isAdmin(c.env, session.email)) return render(c, 'Ingen adgang', errorPage('Ingen adgang', 'Bogføring er kun til Veyros administratorer.', { href: '/konto', label: 'Til kundepanelet' }), { status: 403 });
  c.header('Cache-Control', 'private, no-store');
  await next();
};
r.use('/bogfoering', guard);
r.use('/bogfoering/*', guard);
// Do not turn database failures into success redirects or expose SQL/file contents.
r.onError(async (error, c) => {
  if (!(error instanceof AccountingError)) console.error('Accounting request failed:', error.name);
  return render(c, 'Bogføring', errorPage('Handlingen blev ikke gennemført', error instanceof AccountingError ? error.message : 'Der opstod en fejl. Genindlæs siden og kontrollér status, før du prøver igen.', { href: BASE, label: 'Til bogføring' }), { admin: true, isCustomer: false, nav: 'admin-bogfoering', status: error instanceof AccountingError ? error.status : 500 });
});

function period(c: Context<AppEnv>) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const from = c.req.query('from') || `${today.slice(0, 4)}-01-01`, to = c.req.query('to') || today;
  if (!accountingDate(from) || !accountingDate(to) || from > to) throw new AccountingError('Vælg en gyldig periode fra og til.');
  return { from, to };
}
function receiptView(row: ReceiptRow) { return { ...row, reversed: row.reversal_id !== null }; }
async function page(c: Context<AppEnv>, data: Partial<AccountingPageData> & { tab: AccountingTab }) {
  const accounts = await searchAccounts(c.env.DB);
  return render(c, 'Bogføring', accountingPage({ csrf: c.get('csrf'), accounts, period: period(c), max_file_mb: 15, ...data }), { admin: true, isCustomer: false, nav: 'admin-bogfoering' });
}
const go = (c: Context<AppEnv>, path: string, message?: string) => c.redirect(path + (message ? `${path.includes('?') ? '&' : '?'}besked=${encodeURIComponent(message)}` : ''), 303);
type Body = Record<string, string | File | (string | File)[]>;
const text = (body: Body, name: string) => typeof body[name] === 'string' ? body[name] as string : '';
const version = (body: Body) => {
  const n = Number(text(body, 'version'));
  if (!Number.isSafeInteger(n) || n < 1) throw new AccountingError('Kladdens version mangler. Genindlæs siden.', 409);
  return n;
};
function fields(body: Body): ReceiptFields {
  const amount = (name: string) => {
    const value = text(body, name).trim();
    if (!value) return null;
    const n = parseBankMoney(value);
    if (n === null || n < 0) throw new AccountingError('Angiv beløb som positive tal med højst to decimaler.');
    return n;
  };
  const account = (name: string) => {
    const value = text(body, name).trim();
    if (!value) return null;
    if (!/^\d+(?:\s+·\s+[^\r\n]+)?$/.test(value)) throw new AccountingError('Vælg et kontonummer fra søgeresultaterne.');
    return value.split(/\s/)[0]!;
  };
  return { kind: text(body, 'kind') as ReceiptKind, supplier: text(body, 'supplier'), date: text(body, 'document_date'), currency: text(body, 'currency'),
    gross_minor: amount('amount'), vat_minor: amount('vat_amount'), deductible_vat_minor: amount('deductible_vat_amount'),
    base_gross_minor: amount('base_amount'), base_vat_minor: amount('base_vat_amount'), base_deductible_vat_minor: amount('base_deductible_vat_amount'),
    account_code: account('account_code'), settlement_account_code: account('settlement_account_code') || '5820', note: text(body, 'description') };
}
async function original(c: Context<AppEnv>, fileId: number, name: string) {
  const file = await getFile(c.env.DB, fileId);
  if (!file) throw new AccountingError('Originalfilen findes ikke.', 404);
  const bytes = await fileBytes(c.env.DB, file);
  if (!bytes || await sha256Bytes(bytes) !== file.sha256) throw new AccountingError('Originalfilens integritet kunne ikke bekræftes. Hent ikke en ufuldstændig kopi.', 409);
  c.header('Content-Type', file.mime);
  c.header('Content-Disposition', `attachment; filename="original.${file.mime === 'application/pdf' ? 'pdf' : file.mime === 'text/csv' ? 'csv' : file.mime === 'image/png' ? 'png' : 'jpg'}"; filename*=UTF-8''${encodeURIComponent(name).replace(/'/g, '%27')}`);
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Cache-Control', 'private, no-store');
  return c.body(bytes.slice().buffer);
}
async function upload(c: Context<AppEnv>, body: Body, bank = false) {
  const file = body.file;
  if (!(file instanceof File)) throw new AccountingError('Vælg en originalfil.');
  try { return await storeAccountingOriginal(c.env.DB, who(c), file, bank); }
  catch (error) { if (error instanceof Error && !/D1|SQLITE|database/i.test(error.message)) throw new AccountingError(error.message); throw error; }
}
async function reading(c: Context<AppEnv>, bytes: Uint8Array, mime: string): Promise<ReceiptReading> {
  const extracted = await extractAccountingText(c.env, { bytes, mime });
  if (!extracted.ok) return { reading_source: 'unread', reading_note: extracted.warnings.join(' '), uncertain: ['supplier', 'date', 'amount', 'currency', 'vat'] };
  const suggested = readAccountingReceipt(extracted.pages, { ownName: 'Veyro', ownCvr: '46857569' });
  return { supplier: suggested.supplier ?? '', date: suggested.date ?? '', currency: suggested.currency ?? '', gross_minor: suggested.total_minor,
    vat_minor: suggested.vat_minor, deductible_vat_minor: null, account_code: suggested.account_code,
    source_kind: suggested.kind, reading_source: extracted.source, reading_note: [...extracted.warnings, ...suggested.warnings].join(' '),
    uncertain: suggested.uncertain, note: suggested.description };
}

r.get('/bogfoering/assets.css', c => { c.header('Content-Type', 'text/css; charset=utf-8'); return c.body(ACCOUNTING_CSS); });
r.get('/bogfoering/assets.js', c => { c.header('Content-Type', 'application/javascript; charset=utf-8'); return c.body(ACCOUNTING_JS); });
r.get('/bogfoering', async c => {
  const raw = c.req.query('tab') || 'bilag';
  const tab: AccountingTab = ['bilag', 'bank', 'moms', 'rapporter'].includes(raw) ? raw as AccountingTab : 'bilag';
  const notice = c.req.query('besked')?.slice(0, 300);
  if (tab === 'bilag') {
    const rawStatus = c.req.query('status');
    const status = rawStatus === 'draft' || rawStatus === 'posted' ? rawStatus : undefined;
    return page(c, { tab, notice, receipt_filter: status, receipts: (await listReceipts(c.env.DB, { status })).map(receiptView) });
  }
  if (tab === 'bank') {
    const mode = c.req.query('vis') === 'removed' ? 'removed' : c.req.query('vis') === 'all' ? 'all' : 'missing';
    const [all, totals, receipts] = await Promise.all([listBankLines(c.env.DB), bankTotals(c.env.DB), listReceipts(c.env.DB)]);
    const visible = all.filter(line => !line.hidden);
    const pairs = visible.filter(line => line.amount_minor < 0).flatMap(purchase => {
      const matches = visible.filter(refund => isRefundPair(purchase, refund));
      return matches.map(refund => ({ purchase, refund, ambiguous: matches.length > 1 || visible.filter(other => isRefundPair(other, refund)).length > 1 }));
    });
    return page(c, { tab, notice, bank_mode: mode, receipts: receipts.map(receiptView),
      bank_lines: mode === 'all' ? all : all.filter(line => mode === 'removed' ? !!line.hidden : !line.hidden && line.amount_minor < 0 && !line.receipt_id),
      bank_totals: totals.map(t => ({ account_key: t.account_key, currency: t.currency, amount_minor: t.movement_minor, line_count: t.count })), refund_pairs: pairs });
  }
  const report = await accountingReport(c.env.DB, period(c));
  return page(c, { tab, notice, report: { ...report, accounts: report.accounts.map(a => ({ ...a, amount_minor: a.kind === 'income' ? -a.balance_minor : a.balance_minor })), entries: report.entries.map(e => ({ ...e, actor: e.created_by })) } });
});
r.get('/bogfoering/bilag/ny', async c => {
  const bank = c.req.query('bank') ? await getBankLine(c.env.DB, id(c.req.query('bank'))) : null;
  if (c.req.query('bank') && (!bank || bank.hidden || bank.receipt_id)) throw new AccountingError('Banklinjen er ikke ledig. Genindlæs bankoversigten.', 409);
  return page(c, { tab: 'bilag', view: 'upload', upload_bank_line_id: bank?.id, linked_bank_line: bank });
});
r.post('/bogfoering/bilag', async c => {
  const body = await c.req.parseBody() as Body;
  const kind = (text(body, 'kind') || 'purchase') as ReceiptKind;
  if (!['purchase', 'sale', 'purchase_credit', 'sale_credit'].includes(kind)) throw new AccountingError('Vælg en gyldig bilagstype.');
  const bankId = text(body, 'bank_line_id') ? id(text(body, 'bank_line_id')) : null;
  const saved = await upload(c, body);
  const previous = await c.env.DB.prepare('SELECT id FROM accounting_receipts WHERE file_id=? AND correction_of IS NULL').bind(saved.file.id).first<{ id: number }>();
  // Persist the accessible draft before potentially slow OCR. A disconnected upload can be resumed
  // with Aflæs igen; its original and receipt id are never lost or replaced.
  let row = await createReceipt(c.env.DB, who(c), { file_id: saved.file.id, file_name: saved.name,
    reading: { kind, reading_source: 'pending', reading_note: 'Originalen er gemt. Aflæsning er i gang. Brug Aflæs igen, hvis den blev afbrudt.' } });
  if (!previous || row.reading_source === 'pending') row = await applyReceiptReading(c.env.DB, who(c), row.id, row.version, await reading(c, saved.bytes, saved.file.mime));
  if (bankId) await linkReceipt(c.env.DB, who(c), row.id, bankId);
  return go(c, `${BASE}/bilag/${row.id}`, previous ? 'Originalen findes allerede. Det eksisterende bilag er åbnet.' : 'Originalen er gemt privat. Kontrollér forslagene før godkendelse.');
});
r.get('/bogfoering/bilag/:id', async c => {
  const row = await getReceipt(c.env.DB, id(c.req.param('id')));
  if (!row) throw new AccountingError('Bilaget findes ikke.', 404);
  const events = await accountingEvents(c.env.DB, 'receipt', row.id);
  return page(c, { tab: 'bilag', view: 'receipt', notice: c.req.query('besked')?.slice(0, 300), receipt: receiptView(row),
    linked_bank_line: row.bank_line_id ? await getBankLine(c.env.DB, row.bank_line_id) : null,
    events: events.map(event => ({ ...event, detail: event.detail })) });
});
r.get('/bogfoering/bilag/:id/original', async c => {
  const row = await getReceipt(c.env.DB, id(c.req.param('id')));
  if (!row) throw new AccountingError('Bilaget findes ikke.', 404);
  return original(c, row.file_id, row.file_name);
});
r.post('/bogfoering/bilag/:id/gem', async c => {
  const body = await c.req.parseBody() as Body, receiptId = id(c.req.param('id'));
  await saveReceiptDraft(c.env.DB, who(c), receiptId, version(body), fields(body));
  return go(c, `${BASE}/bilag/${receiptId}`, 'Kladden er gemt. Der er ikke bogført noget.');
});
r.post('/bogfoering/bilag/:id/aflaes', async c => {
  const body = await c.req.parseBody() as Body, receiptId = id(c.req.param('id')), row = await getReceipt(c.env.DB, receiptId);
  if (!row) throw new AccountingError('Bilaget findes ikke.', 404);
  if (row.status !== 'draft' || row.version !== version(body)) throw new AccountingError('Kun en uændret, ubogført kladde kan aflæses igen. Genindlæs siden.', 409);
  const file = await getFile(c.env.DB, row.file_id), bytes = file ? await fileBytes(c.env.DB, file) : null;
  if (!file || !bytes || await sha256Bytes(bytes) !== file.sha256) throw new AccountingError('Originalfilen kunne ikke kontrolleres.', 409);
  await applyReceiptReading(c.env.DB, who(c), receiptId, row.version, await reading(c, bytes, file.mime));
  return go(c, `${BASE}/bilag/${receiptId}`, 'Samme original er aflæst igen. Kontrollér forslagene.');
});
r.post('/bogfoering/bilag/:id/bogfoer', async c => {
  const body = await c.req.parseBody() as Body, receiptId = id(c.req.param('id'));
  let row = await getReceipt(c.env.DB, receiptId);
  if (!row) throw new AccountingError('Bilaget findes ikke.', 404);
  if (row.status === 'draft') {
    try { row = await saveReceiptDraft(c.env.DB, who(c), receiptId, version(body), fields(body)); }
    catch (error) { const current = await getReceipt(c.env.DB, receiptId); if (!current?.journal_id) throw error; row = current; }
  }
  await approveReceipt(c.env.DB, who(c), receiptId, row.version);
  return go(c, `${BASE}/bilag/${receiptId}`, 'Bilaget er bogført én gang og indgår nu i rapporterne.');
});
r.post('/bogfoering/bilag/:id/rettelseskladde', async c => {
  const row = await createCorrectionDraft(c.env.DB, who(c), id(c.req.param('id')));
  return go(c, `${BASE}/bilag/${row.id}`, 'Rettelseskladden er klar. Original og tilbageførsel er bevaret.');
});
r.post('/bogfoering/postering/:id/tilbagefoer', async c => {
  const body = await c.req.parseBody() as Body, journal = id(c.req.param('id'));
  await reversePosting(c.env.DB, who(c), journal, text(body, 'date'), text(body, 'reason'));
  const row = await c.env.DB.prepare('SELECT receipt_id FROM accounting_journals WHERE id=?').bind(journal).first<{ receipt_id: number }>();
  return go(c, `${BASE}/bilag/${row!.receipt_id}`, 'Posteringen er tilbageført med en sporbar modpostering.');
});
r.post('/bogfoering/bank/import', async c => {
  const body = await c.req.parseBody() as Body, account = text(body, 'account').trim(), currency = text(body, 'currency').trim().toUpperCase();
  if (!account || account.length > 120 || (currency && !/^[A-Z]{3}$/.test(currency))) throw new AccountingError('Angiv bankkonto og eventuelt en gyldig valutakode.');
  const saved = await upload(c, body, true);
  let preview;
  if (saved.file.mime === 'text/csv') preview = parseRevolutCsv(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(saved.bytes), { account, currency });
  else {
    const extracted = await extractAccountingText(c.env, { bytes: saved.bytes, mime: saved.file.mime });
    if (!extracted.ok) throw new AccountingError(extracted.warnings.join(' ') || 'Udtoget kunne ikke aflæses. Prøv en CSV fra Revolut.');
    preview = parseRevolutPdfText(extracted.pages, { account, currency });
    preview.warnings.push(...extracted.warnings);
  }
  if (preview.errors.length) throw new AccountingError(preview.errors.join(' ').slice(0, 1500));
  const entry = await createImportPreview(c.env.DB, who(c), { file_id: saved.file.id, file_name: saved.name, format: preview.format === 'revolut-csv' ? 'csv' : 'pdf', rows: preview.rows, warnings: preview.warnings });
  return go(c, `${BASE}/bank/import/${entry.id}`);
});
r.get('/bogfoering/bank/import/:id', async c => {
  const entry = await getImport(c.env.DB, id(c.req.param('id')));
  if (!entry) throw new AccountingError('Importen findes ikke.', 404);
  return page(c, { tab: 'bank', view: 'import', notice: entry.status === 'confirmed' ? 'Denne bankfil er allerede importeret.' : undefined,
    import_preview: { ...entry, can_confirm: entry.status === 'preview' && !entry.rows.some(row => row.duplicate_status === 'conflict') } });
});
r.get('/bogfoering/bank/import/:id/original', async c => {
  const entry = await getImport(c.env.DB, id(c.req.param('id')));
  if (!entry) throw new AccountingError('Importen findes ikke.', 404);
  return original(c, entry.file_id, entry.file_name);
});
r.post('/bogfoering/bank/import/:id/bekraeft', async c => {
  const body = await c.req.parseBody() as Body, resolutions: Record<string, ImportResolution> = {};
  for (const key of Object.keys(body)) if (/^resolution_\d+$/.test(key)) {
    const value = text(body, key); if (value) resolutions[key.slice(11)] = value === 'new' ? 'new' : id(value);
  }
  const result = await confirmImport(c.env.DB, who(c), id(c.req.param('id')), resolutions);
  return go(c, `${BASE}?tab=bank`, `${result.imported} nye banklinjer. ${result.duplicates} genkendte linjer. Ingen udgifter eller moms er bogført.`);
});
r.get('/bogfoering/bank/mangelliste.csv', async c => {
  const rows = await listBankLines(c.env.DB, { missing: true });
  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', 'attachment; filename="manglende-bilag.csv"');
  return c.body(toCsv([['Banklinje', 'Dato', 'Beskrivelse', 'Beloeb', 'Valuta', 'Konto'], ...rows.map(row => [row.id, row.date, row.description, row.amount_minor / 100, row.currency, row.account_key])]));
});
r.post('/bogfoering/bank/fjern-par', async c => {
  const body = await c.req.parseBody() as Body;
  await setBankLinesHidden(c.env.DB, who(c), [id(text(body, 'line_id')), id(text(body, 'refund_id'))], true, 'Køb og fuld refundering');
  return go(c, `${BASE}?tab=bank`, 'Begge linjer er fjernet fra mangellisten. Bankhistorik og regnskab er uændret.');
});
r.post('/bogfoering/bank/:id/fjern', async c => {
  const body = await c.req.parseBody() as Body;
  await setBankLinesHidden(c.env.DB, who(c), [id(c.req.param('id'))], true, text(body, 'reason') || 'Privat køb / ikke bilagspligtig');
  return go(c, `${BASE}?tab=bank`, 'Linjen er fjernet fra mangellisten og kan gendannes.');
});
r.post('/bogfoering/bank/:id/gendan', async c => {
  await setBankLinesHidden(c.env.DB, who(c), [id(c.req.param('id'))], false);
  return go(c, `${BASE}?tab=bank&vis=removed`, 'Linjen er gendannet.');
});
r.post('/bogfoering/bank/:id/tilknyt', async c => {
  const body = await c.req.parseBody() as Body;
  await linkReceipt(c.env.DB, who(c), id(text(body, 'receipt_id')), id(c.req.param('id')));
  return go(c, `${BASE}?tab=bank`, 'Bilaget er tilknyttet. En kladde skal stadig godkendes, før noget bogføres.');
});

export default r;
