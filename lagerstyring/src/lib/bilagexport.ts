// Digital visning af et bilag som PDF og eksporten til bogholderen (ZIP med filer og CSV).
// Eksporten sendes ikke nogen steder hen, og intet markeres som bogført.

import type { Env, InvoiceRow } from '../env';
import {
  ACTION_LABEL,
  DOC_TYPE_LABEL,
  PAYMENT_LABEL,
  TARGET_LABEL,
  allocations,
  bilagLines,
  bilagNo,
  exportState,
  uncertainOf,
  type BilagLineRow,
  type BilagRow,
} from './bilag';
import { fileBytes, getFile } from './files';
import { formatDay, formatKr, formatQty } from './format';
import { getJob } from './materials';
import { invoiceItems, getInvoice } from './invoicing';
import { METHOD_LABEL, PAY_STATE_LABEL, DOC_STATE_LABEL, invoicesWithStatus, type PaymentRow } from './payments';
import { invoicePdf, renderDoc } from './pdf';
import { companyInfo, customerInfo } from './quotes';
import type { Settings } from './settings';
import { csv, csvKr, zip, type ZipEntry } from './zip';

const kr = (o: number | null) => (o === null ? '–' : formatKr(o, { decimals: true }));

export async function bilagViewPdf(b: BilagRow, lines: BilagLineRow[], s: Settings, demo: boolean): Promise<Uint8Array> {
  const unc = new Set(uncertainOf(b));
  const mark = (f: string, v: string) => (v ? `${v}${unc.has(f) ? ' (usikker)' : ''}` : 'Mangler');
  return renderDoc({
    title: `${DOC_TYPE_LABEL[b.doc_type]}`,
    stamp: 'Digital visning af originalbilag. Originalen har forrang.',
    company: { name: b.supplier_name || 'Leverandør mangler', address: '', cvr: b.supplier_cvr, email: '', phone: '', bank_reg: '', bank_account: '' },
    customer: { name: s.company_name, contact: '', address: s.company_address, email: '', phone: '', cvr: s.company_cvr, site_address: '' },
    meta: [
      ['Bilags-ID', `${bilagNo(b.id)} v${b.version}`],
      ['Nummer', mark('doc_number', b.doc_number)],
      ['Dato', mark('doc_date', b.doc_date ? formatDay(b.doc_date) : '')],
      ...(b.due_date ? ([['Betalingsfrist', formatDay(b.due_date)]] as [string, string][]) : []),
      ['Valuta', b.currency],
    ],
    intro: [],
    sections: [
      {
        title: `Varelinjer (beløb ${b.line_prices === 'inkl' ? 'inkl.' : 'ekskl.'} moms)`,
        rows: lines.map((l) => ({
          text: `${l.name}${l.uncertain ? ' (usikker)' : ''}`,
          sub: [l.discount ? `Rabat ${kr(l.discount)}` : '', l.vat_rate !== null ? `Moms ${l.vat_rate / 100} %` : ''].filter(Boolean).join(' · ') || undefined,
          qty: l.qty === null ? '' : formatQty(l.qty),
          unit: l.unit,
          price: l.unit_price === null ? '' : kr(l.unit_price),
          amount: l.amount === null ? '–' : kr(l.amount),
        })),
      },
    ],
    totals: [
      ['Ekskl. moms', mark('net', b.net === null ? '' : kr(b.net))],
      ['Moms', mark('vat', b.vat === null ? '' : kr(b.vat))],
      ...(b.rounding ? ([['Afrunding', kr(b.rounding)]] as [string, string][]) : []),
      [`Total ${b.currency}`, mark('total', b.total === null ? '' : kr(b.total)), true],
    ],
    notes: [
      b.payment_info ? `Betalingsoplysninger: ${b.payment_info}` : '',
      b.ocr_provider
        ? `OCR-forslag fra ${b.ocr_provider}. Værdier markeret (usikker) er ikke bekræftet mod originalen.`
        : b.reading_source === 'pdf-tekst'
        ? "Aflæst automatisk fra originalens PDF-tekst og kontrolleret af brugeren. Værdier markeret (usikker) er ikke bekræftet."
        : b.reading_source === 'simuleret'
          ? 'DEMODATA: aflæsningen er simuleret.'
          : 'Registreret manuelt ud fra originalen.',
      `Original fil: ${b.file_name}. Interne oplysninger (betaling, fordeling, godkendelse) står ikke i denne visning.`,
    ].filter(Boolean),
    footer: [`${s.company_name} · ${bilagNo(b.id)}`, demo ? 'DEMODATA: fiktivt bilag til demonstration.' : ''].filter(Boolean),
  });
}

export interface ExportInput {
  from: string;
  to: string;
  jobId: number | null;
  views: boolean;
  all: boolean;
}

const fileSafe = (s: string) => s.replace(/[^A-Za-z0-9æøåÆØÅ._-]+/g, '_').slice(0, 60);
const ext = (mime: string) => (mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : mime === 'image/heic' ? 'heic' : 'jpg');

/** Bilag, der kan eksporteres med de valgte kriterier. */
export async function exportableBilag(db: D1Database, inp: ExportInput): Promise<BilagRow[]> {
  const where = ["b.status IN ('godkendt', 'arkiveret')", 'b.approved_version = b.version'];
  const args: (string | number)[] = [];
  if (inp.from) {
    where.push("COALESCE(NULLIF(b.doc_date, ''), date(b.created_at, 'unixepoch')) >= ?");
    args.push(inp.from);
  }
  if (inp.to) {
    where.push("COALESCE(NULLIF(b.doc_date, ''), date(b.created_at, 'unixepoch')) <= ?");
    args.push(inp.to);
  }
  if (inp.jobId) {
    where.push('EXISTS (SELECT 1 FROM bilag_allocations a WHERE a.bilag_id = b.id AND a.job_id = ?)');
    args.push(inp.jobId);
  }
  const { results } = await db.prepare(`SELECT b.* FROM bilag b WHERE ${where.join(' AND ')} ORDER BY b.doc_date, b.id`).bind(...args).all<BilagRow>();
  return inp.all ? results : results.filter((b) => exportState(b) !== 'eksporteret');
}

export async function buildExport(env: Env, s: Settings, inp: ExportInput, exportId: number, demo: boolean): Promise<{ bytes: Uint8Array; bilag: BilagRow[]; invoices: (InvoiceRow & { st: { outstanding: number } })[] }> {
  const db = env.DB;
  const bilag = await exportableBilag(db, inp);
  const entries: ZipEntry[] = [];
  const bRows: (string | number | null)[][] = [
    ['Bilags-ID', 'Version', 'Type', 'Leverandør', 'CVR', 'Bilagsnummer', 'Dato', 'Betalingsfrist', 'Valuta', 'Ekskl. moms', 'Moms', 'Afrunding', 'Total', 'Betaling', 'Udlæg af', 'Refunderet', 'Job', 'Godkendt af', 'Godkendt', 'Original fil', 'Digital visning'],
  ];
  const aRows: (string | number | null)[][] = [['Bilags-ID', 'Version', 'Til', 'Job', 'Beløb', 'Handling', 'Note']];
  for (const b of bilag) {
    const [lines, allocs, f] = await Promise.all([bilagLines(db, b.id), allocations(db, b.id), getFile(db, b.file_id)]);
    const no = bilagNo(b.id);
    const base = `bilag/${no}_${fileSafe(b.supplier_name || 'bilag')}`;
    const orig = f ? `${base}_original.${ext(f.mime)}` : '';
    if (f) {
      const bytes = await fileBytes(db, f);
      if (bytes) entries.push({ name: orig, data: bytes });
    }
    const view = inp.views ? `${base}_digital-visning.pdf` : '';
    if (view) entries.push({ name: view, data: await bilagViewPdf(b, lines, s, demo) });
    const sign = b.doc_type === 'kreditnota' ? -1 : 1;
    bRows.push([
      no,
      b.version,
      DOC_TYPE_LABEL[b.doc_type],
      b.supplier_name,
      b.supplier_cvr,
      b.doc_number,
      b.doc_date,
      b.due_date,
      b.currency,
      csvKr(b.net === null ? null : sign * b.net),
      csvKr(b.vat === null ? null : sign * b.vat),
      csvKr(b.rounding ? sign * b.rounding : 0),
      csvKr(b.total === null ? null : sign * b.total),
      PAYMENT_LABEL[b.payment],
      b.paid_by,
      b.reimbursed_at ? new Date(b.reimbursed_at * 1000).toISOString().slice(0, 10) : '',
      [...new Set(allocs.map((a) => a.job_number).filter(Boolean))].join(', '),
      b.approved_by,
      b.approved_at ? new Date(b.approved_at * 1000).toISOString().slice(0, 10) : '',
      orig,
      view,
    ]);
    for (const a of allocs) aRows.push([no, b.version, TARGET_LABEL[a.target], a.job_number ? `${a.job_number} ${a.job_name}` : '', csvKr(sign * a.amount), ACTION_LABEL[a.action], a.note]);
  }

  // Udstedte fakturaer og kreditnotaer, der ikke er eksporteret (eller alle, hvis valgt)
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (inp.from) {
    where.push('AND i.issue_date >= ?');
    args.push(inp.from);
  }
  if (inp.to) {
    where.push('AND i.issue_date <= ?');
    args.push(inp.to);
  }
  if (inp.jobId) {
    where.push('AND i.job_id = ?');
    args.push(inp.jobId);
  }
  if (!inp.all) where.push('AND i.exported_at IS NULL');
  const invs = await invoicesWithStatus(db, where.join(' '), args);
  const iRows: (string | number | null)[][] = [['Nummer', 'Type', 'Krediterer', 'Job', 'Kunde', 'Fakturadato', 'Forfaldsdato', 'Ekskl. moms', 'Moms', 'Total', 'Krediteret', 'Betalt', 'Rest', 'Dokumentstatus', 'Betalingsstatus', 'PDF']];
  const pRows: (string | number | null)[][] = [['Faktura', 'Dato', 'Beløb', 'Valuta', 'Metode', 'Reference', 'Bemærkning', 'Registreret af']];
  for (const i of invs) {
    const credited = i.credit_of ? await getInvoice(db, i.credit_of) : null;
    const j = await getJob(db, i.job_id);
    const name = `fakturaer/${i.kind === 'kreditnota' ? 'Kreditnota' : 'Faktura'}-${i.number}.pdf`;
    if (j) {
      const items = await invoiceItems(db, i.id);
      entries.push({ name, data: await invoicePdf(i, items, j, { company: companyInfo(s), customer: customerInfo(j) }, demo, credited?.number ?? null) });
    }
    const sign = i.kind === 'kreditnota' ? -1 : 1;
    iRows.push([
      i.number,
      i.kind === 'kreditnota' ? 'Kreditnota' : 'Faktura',
      credited?.number ?? '',
      `${i.job_number} ${i.job_name}`,
      i.customer_name,
      i.issue_date,
      i.due_date,
      csvKr(sign * i.subtotal),
      csvKr(sign * i.vat),
      csvKr(sign * i.total),
      i.kind === 'faktura' ? csvKr(i.st.credited) : '',
      i.kind === 'faktura' ? csvKr(i.st.paid) : '',
      i.kind === 'faktura' ? csvKr(i.st.outstanding) : '',
      DOC_STATE_LABEL[i.st.doc],
      i.kind === 'faktura' ? PAY_STATE_LABEL[i.st.pay] : '',
      name,
    ]);
    const { results: pays } = await db.prepare('SELECT * FROM invoice_payments WHERE invoice_id = ? AND deleted_at IS NULL ORDER BY paid_on').bind(i.id).all<PaymentRow>();
    for (const p of pays) pRows.push([i.number, p.paid_on, csvKr(p.amount), p.currency, METHOD_LABEL[p.method], p.reference, p.note, p.created_by]);
  }

  entries.push(
    { name: 'bilag.csv', data: csv(bRows) },
    { name: 'fordeling.csv', data: csv(aRows) },
    { name: 'fakturaer.csv', data: csv(iRows) },
    { name: 'betalinger.csv', data: csv(pRows) },
    {
      name: 'LAES_MIG.txt',
      data: new TextEncoder().encode(
        [
          `Eksport #${exportId} fra ${s.company_name}${s.company_cvr ? ` (CVR ${s.company_cvr})` : ''}`,
          `Periode: ${inp.from || 'start'} til ${inp.to || 'i dag'}${inp.jobId ? `, kun job-id ${inp.jobId}` : ''}`,
          `Bilag: ${bilag.length}. Fakturaer og kreditnotaer: ${invs.length}.`,
          '',
          'Indhold: originalbilag (uændrede), digital visning af hvert bilag (PDF), udstedte fakturaer og kreditnotaer (PDF) og CSV-oversigter (UTF-8, semikolon, komma som decimaltegn).',
          'Kreditnotaer står med negative beløb. Betalinger er registreret manuelt i systemet og er ikke afstemt med banken.',
          'Intet er bogført. Bilagene er ikke overført til et regnskabsprogram af systemet.',
          demo ? 'DEMODATA: alle virksomheder, bilag og beløb er fiktive.' : '',
        ]
          .filter((x) => x !== '')
          .join('\r\n') + '\r\n',
      ),
    },
  );
  return { bytes: zip(entries), bilag, invoices: invs };
}
