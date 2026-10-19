// PDF til prisoverslag, fakturaer og kreditnotaer (A4, pdf-lib med standardskriften Helvetica).

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { InvoiceItemRow, InvoiceRow, JobQuoteRow } from '../env';
import { formatDay, formatKr, formatQty, lineAmount } from './format';
import { TYPE_LABEL, invoiceTotals, parseJson } from './invoicing';
import { quoteData, type CompanyInfo, type CustomerInfo } from './quotes';

interface Row {
  text: string;
  sub?: string;
  qty: string;
  unit: string;
  price: string;
  amount: string;
}

export interface DocSpec {
  title: string;
  /** Rød markering øverst, fx "KLADDE – ikke udstedt" */
  stamp?: string;
  company: CompanyInfo;
  customer: CustomerInfo;
  meta: [string, string][];
  intro: string[];
  sections: { title: string; rows: Row[] }[];
  totals: [string, string, boolean?][];
  notes: string[];
  footer: string[];
}

/** Helvetica kan kun skrive Windows-1252; andre tegn erstattes, så PDF'en altid kan laves. */
const EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
export function winAnsi(s: string): string {
  return s
    .replace(/[‐-‒]/g, '-')
    .replace(/ | | /g, ' ')
    .replace(/[^\n\x20-\x7e\xa0-\xff]/g, (ch) => (EXTRA.includes(ch) ? ch : '?'));
}

const A4: [number, number] = [595.28, 841.89];
const M = 50;
const INK = rgb(0.06, 0.06, 0.05);
const MUTED = rgb(0.38, 0.37, 0.34);
const LINE = rgb(0.85, 0.84, 0.8);
const RED = rgb(0.75, 0.1, 0.1);

class Writer {
  page!: PDFPage;
  y = 0;
  pageNo = 0;
  constructor(
    readonly doc: PDFDocument,
    readonly font: PDFFont,
    readonly bold: PDFFont,
    readonly footer: string[],
  ) {
    this.newPage();
  }

  newPage(): void {
    this.page = this.doc.addPage(A4);
    this.pageNo++;
    this.y = A4[1] - M;
    let fy = 30 + (this.footer.length - 1) * 10;
    for (const f of this.footer) {
      this.page.drawText(winAnsi(f), { x: M, y: fy, size: 7.5, font: this.font, color: MUTED });
      fy -= 10;
    }
  }

  need(h: number): void {
    if (this.y - h < 70) this.newPage();
  }

  text(s: string, x: number, size = 9.5, opts: { bold?: boolean; color?: ReturnType<typeof rgb>; right?: boolean } = {}): void {
    const f = opts.bold ? this.bold : this.font;
    const t = winAnsi(s);
    const w = f.widthOfTextAtSize(t, size);
    this.page.drawText(t, { x: opts.right ? x - w : x, y: this.y, size, font: f, color: opts.color ?? INK });
  }

  wrap(s: string, width: number, size = 9.5, bold = false): string[] {
    const f = bold ? this.bold : this.font;
    const out: string[] = [];
    for (const para of winAnsi(s).split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/)) {
        const next = line ? `${line} ${word}` : word;
        if (f.widthOfTextAtSize(next, size) > width && line) {
          out.push(line);
          line = word;
        } else line = next;
      }
      out.push(line);
    }
    return out;
  }

  para(s: string, opts: { size?: number; color?: ReturnType<typeof rgb>; bold?: boolean; width?: number } = {}): void {
    const size = opts.size ?? 9;
    for (const l of this.wrap(s, opts.width ?? A4[0] - 2 * M, size, opts.bold)) {
      this.need(size + 4);
      this.text(l, M, size, { color: opts.color, bold: opts.bold });
      this.y -= size + 3.5;
    }
  }

  rule(): void {
    this.page.drawLine({ start: { x: M, y: this.y }, end: { x: A4[0] - M, y: this.y }, thickness: 0.6, color: LINE });
  }
}

// Kolonner: beskrivelse, antal, enhed, pris pr. enhed, beløb (højrestillet ved x)
const COL = { text: M, qty: 360, unit: 366, price: 470, amount: A4[0] - M };

function tableHead(w: Writer): void {
  w.need(20);
  w.text('Beskrivelse', COL.text, 8, { bold: true, color: MUTED });
  w.text('Antal', COL.qty, 8, { bold: true, color: MUTED, right: true });
  w.text('Enhed', COL.unit, 8, { bold: true, color: MUTED });
  w.text('Pris pr. enhed', COL.price, 8, { bold: true, color: MUTED, right: true });
  w.text('Beløb', COL.amount, 8, { bold: true, color: MUTED, right: true });
  w.y -= 6;
  w.rule();
  w.y -= 12;
}

export async function renderDoc(spec: DocSpec): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(winAnsi(spec.title));
  doc.setAuthor(winAnsi(spec.company.name));
  doc.setProducer('Veyro');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const w = new Writer(doc, font, bold, spec.footer);

  // Virksomheden (venstre) og dokumentet (højre)
  const top = w.y;
  w.text(spec.company.name, M, 15, { bold: true });
  w.y -= 15;
  const companyLines = [
    ...spec.company.address.split('\n'),
    spec.company.cvr && `CVR ${spec.company.cvr}`,
    [spec.company.phone, spec.company.email].filter(Boolean).join(' · '),
  ].filter(Boolean) as string[];
  for (const l of companyLines) {
    w.text(l, M, 9, { color: MUTED });
    w.y -= 12;
  }
  const leftBottom = w.y;
  w.y = top;
  w.text(spec.title.toUpperCase(), A4[0] - M, 18, { bold: true, right: true });
  w.y -= 20;
  for (const [k, v] of spec.meta) {
    w.text(`${k}: `, A4[0] - M - 110, 9, { color: MUTED, right: true });
    w.text(v, A4[0] - M, 9, { right: true, bold: true });
    w.y -= 12;
  }
  w.y = Math.min(w.y, leftBottom) - 8;
  if (spec.stamp) {
    w.text(spec.stamp, M, 11, { bold: true, color: RED });
    w.y -= 18;
  }

  // Slutkunden
  const c = spec.customer;
  w.text('Til', M, 8, { bold: true, color: MUTED });
  w.y -= 12;
  for (const l of [c.name, c.contact && `Att. ${c.contact}`, ...c.address.split('\n'), c.cvr && `CVR ${c.cvr}`, c.email].filter(Boolean) as string[]) {
    w.text(l, M, 9.5, { bold: l === c.name });
    w.y -= 12;
  }
  w.y -= 6;
  for (const l of spec.intro) w.para(l, { size: 9.5 });
  w.y -= 8;

  // Linjer
  tableHead(w);
  for (const sec of spec.sections) {
    if (!sec.rows.length) continue;
    w.need(30);
    w.text(sec.title, COL.text, 9.5, { bold: true });
    w.y -= 13;
    for (const r of sec.rows) {
      const lines = w.wrap(r.text, COL.qty - COL.text - 40, 9);
      const subs = r.sub ? w.wrap(r.sub, COL.qty - COL.text - 40, 7.5) : [];
      const h = lines.length * 11 + subs.length * 9.5 + 3;
      if (w.y - h < 70) {
        w.newPage();
        tableHead(w);
      }
      w.text(r.qty, COL.qty, 9, { right: true });
      w.text(r.unit, COL.unit, 9);
      w.text(r.price, COL.price, 9, { right: true });
      w.text(r.amount, COL.amount, 9, { right: true, color: r.amount === 'Pris mangler' ? RED : INK, bold: r.amount === 'Pris mangler' });
      for (const l of lines) {
        w.text(l, COL.text, 9);
        w.y -= 11;
      }
      for (const l of subs) {
        w.text(l, COL.text, 7.5, { color: MUTED });
        w.y -= 9.5;
      }
      w.y -= 3;
    }
    w.y -= 4;
  }
  w.rule();
  w.y -= 16;

  // Totaler
  for (const [label, value, strong] of spec.totals) {
    w.need(16);
    w.text(label, COL.price, strong ? 10.5 : 9.5, { right: true, bold: !!strong });
    w.text(value, COL.amount, strong ? 10.5 : 9.5, { right: true, bold: !!strong });
    w.y -= strong ? 16 : 13;
  }
  w.y -= 10;
  for (const n of spec.notes) {
    w.para(n, { size: 8.5, color: n.startsWith('!') ? RED : MUTED, bold: n.startsWith('!') });
    w.y -= 4;
  }
  // Sidetal
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const t = `Side ${i + 1} af ${pages.length}`;
    p.drawText(t, { x: A4[0] - M - font.widthOfTextAtSize(t, 7.5), y: 30, size: 7.5, font, color: MUTED });
  });
  return doc.save();
}

const kr = (o: number | null) => (o === null ? 'Pris mangler' : formatKr(o, { decimals: true }));

function companyFooter(co: CompanyInfo, demo: boolean): string[] {
  return [
    [co.name, co.address.replace(/\n/g, ', '), co.cvr && `CVR ${co.cvr}`].filter(Boolean).join(' · '),
    demo ? 'DEMODATA: fiktiv virksomhed, fiktivt job og fiktive priser. Ikke et rigtigt dokument.' : '',
  ].filter(Boolean);
}

export async function quotePdf(q: JobQuoteRow, demo: boolean): Promise<Uint8Array> {
  const d = quoteData(q);
  const notes: string[] = [d.assumptions];
  if (q.incomplete) notes.unshift(`! Ufuldstændigt overslag: ${d.missing.length} ${d.missing.length === 1 ? 'linje mangler' : 'linjer mangler'} en pris og er ikke regnet med i beløbet.`);
  if (d.vat_registered === 'nej') notes.push('Virksomheden er ikke momsregistreret, så der er ikke lagt moms på.');
  if (d.terms) notes.push(d.terms);
  if (q.note) notes.push(q.note);
  return renderDoc({
    title: 'Prisoverslag',
    company: d.company,
    customer: d.customer,
    meta: [
      ['Job', d.job.number],
      ['Version', String(q.version)],
      ['Dato', formatDay(new Date(q.created_at * 1000).toISOString().slice(0, 10))],
      ...(q.valid_until ? ([['Gælder til', formatDay(q.valid_until)]] as [string, string][]) : []),
    ],
    intro: [
      `Prisoverslag på ${d.job.name}`,
      ...(d.customer.site_address ? [`Arbejdsadresse: ${d.customer.site_address}`] : []),
      ...(d.job.start_date || d.job.end_date ? [`Forventet periode: ${formatDay(d.job.start_date)} til ${formatDay(d.job.end_date)}`] : []),
      ...(d.job.description ? [d.job.description] : []),
    ],
    sections: [
      {
        title: 'Materialer',
        rows: d.materials.map((m) => ({ text: m.name, sub: m.missing ? m.missing : m.basis, qty: formatQty(m.qty), unit: m.unit, price: m.sale_unit === null ? '' : kr(m.sale_unit), amount: kr(m.amount) })),
      },
      { title: 'Arbejdsløn', rows: d.labour.map((l) => ({ text: l.description, qty: formatQty(l.qty), unit: l.unit, price: l.rate === null ? '' : kr(l.rate), amount: kr(l.amount) })) },
      { title: 'Andre omkostninger', rows: d.other.map((l) => ({ text: l.description, qty: formatQty(l.qty), unit: l.unit, price: l.rate === null ? '' : kr(l.rate), amount: kr(l.amount) })) },
    ],
    totals: [
      ['Materialer', kr(q.materials)],
      ['Arbejdsløn', kr(q.labour)],
      ...(q.other ? ([['Andre omkostninger', kr(q.other)]] as [string, string][]) : []),
      ['I alt ekskl. moms', kr(q.subtotal), true],
      [`Moms ${d.vat_rate / 100} %`, kr(q.vat)],
      ['I alt inkl. moms', kr(q.total), true],
    ],
    notes,
    footer: companyFooter(d.company, demo),
  });
}

export async function invoicePdf(inv: InvoiceRow, items: InvoiceItemRow[], job: { number: string; name: string; site_address: string }, live: { company: CompanyInfo; customer: CustomerInfo }, demo: boolean, creditNumber: number | null): Promise<Uint8Array> {
  const issued = inv.status === 'udstedt';
  const company = issued ? parseJson<CompanyInfo>(inv.company) : live.company;
  const customer = issued ? parseJson<CustomerInfo>(inv.customer) : live.customer;
  const credit = inv.kind === 'kreditnota';
  const t = issued ? { subtotal: inv.subtotal, vat: inv.vat, total: inv.total } : invoiceTotals(items, inv.vat_rate);
  const live_ = items.filter((l) => l.include);
  const sec = (type: InvoiceItemRow['type']) => ({
    title: TYPE_LABEL[type],
    rows: live_
      .filter((l) => l.type === type)
      .map((l) => ({
        text: l.description,
        sub: l.covered ? 'Indeholdt i den faste pris' : undefined,
        qty: formatQty(l.qty),
        unit: l.unit,
        price: l.covered || l.unit_price === null ? '' : kr(l.unit_price),
        amount: l.covered ? 'Indeholdt' : kr(l.unit_price === null ? null : lineAmount(l.unit_price, l.qty)),
      })),
  });
  const notes: string[] = [];
  if (credit) notes.push(`Kreditnotaen krediterer faktura nr. ${creditNumber ?? ''}. Beløbet modregnes eller tilbagebetales.`);
  else if (company.bank_reg || company.bank_account) {
    notes.push(`Betaling: ${formatKr(t.total, { decimals: true })} betales senest ${formatDay(inv.due_date || '')} til reg.nr. ${company.bank_reg} konto ${company.bank_account}. Angiv fakturanummer ${inv.number ?? ''} ved betaling.`);
  }
  if (inv.vat_rate === 0) notes.push('Virksomheden er ikke momsregistreret, så der er ikke lagt moms på.');
  if (inv.note) notes.push(inv.note);
  return renderDoc({
    title: credit ? 'Kreditnota' : 'Faktura',
    stamp: issued ? undefined : 'KLADDE - ikke udstedt og ikke gyldig som faktura',
    company,
    customer,
    meta: [
      [credit ? 'Kreditnotanr.' : 'Fakturanr.', inv.number === null ? 'Tildeles ved udstedelse' : String(inv.number)],
      [credit ? 'Dato' : 'Fakturadato', issued ? formatDay(inv.issue_date) : 'Ved udstedelse'],
      ['Leveringsdato', formatDay(inv.delivery_date)],
      ...(!credit ? ([['Betalingsfrist', issued ? formatDay(inv.due_date) : `${inv.payment_days} dage`]] as [string, string][]) : []),
      ['Job', job.number],
    ],
    intro: [`${job.name}${job.site_address ? `, ${job.site_address}` : ''}`],
    sections: [sec('fastpris'), sec('materiale'), sec('tid'), sec('omkostning')],
    totals: [
      ['I alt ekskl. moms', kr(t.subtotal), true],
      [`Moms ${inv.vat_rate / 100} %`, kr(t.vat)],
      [credit ? 'Krediteres i alt inkl. moms' : 'I alt inkl. moms', kr(t.total), true],
    ],
    notes,
    footer: companyFooter(company, demo),
  });
}
