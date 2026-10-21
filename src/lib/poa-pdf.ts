// PDF for fuldmagter (A4, pdf-lib med standardskriften Helvetica).
// Dokumentet laves kun ud fra den gemte, godkendte version (snapshot) og gemmes én gang; det ændrer sig aldrig bagefter.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { formatKr } from './format';
import { formatDay, STATUS_LABEL, type PoaRow, type Snapshot } from './poa';

/** Helvetica kan kun skrive Windows-1252; andre tegn erstattes, så PDF'en altid kan laves. */
const EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
function winAnsi(s: string): string {
  return s
    .replace(/[‐-‒]/g, '-')
    .replace(/[  ]/g, ' ')
    .replace(/[^\n\x20-\x7e\xa0-\xff]/g, (ch) => (EXTRA.includes(ch) ? ch : '?'));
}

const A4: [number, number] = [595.28, 841.89];
const M = 50;
const W = A4[0] - 2 * M;
const INK = rgb(0.06, 0.06, 0.05);
const MUTED = rgb(0.38, 0.37, 0.34);
const LINE = rgb(0.85, 0.84, 0.8);
const RED = rgb(0.72, 0.12, 0.08);
const ACCENT = rgb(1, 0.353, 0.122);

class Writer {
  page!: PDFPage;
  y = 0;
  constructor(
    readonly doc: PDFDocument,
    readonly font: PDFFont,
    readonly bold: PDFFont,
    readonly footer: string,
  ) {
    this.newPage();
  }
  newPage(): void {
    this.page = this.doc.addPage(A4);
    this.y = A4[1] - M;
    this.page.drawText(winAnsi(this.footer), { x: M, y: 28, size: 7, font: this.font, color: MUTED });
  }
  need(h: number): void {
    if (this.y - h < 60) this.newPage();
  }
  text(s: string, x: number, size: number, opts: { bold?: boolean; color?: ReturnType<typeof rgb> } = {}): void {
    this.page.drawText(winAnsi(s), { x, y: this.y, size, font: opts.bold ? this.bold : this.font, color: opts.color ?? INK });
  }
  wrap(s: string, width: number, size: number, bold = false): string[] {
    const f = bold ? this.bold : this.font;
    const out: string[] = [];
    for (const para of winAnsi(s).split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/)) {
        // Meget lange ord (fx hash) deles
        let w = word;
        while (f.widthOfTextAtSize(w, size) > width) {
          let cut = w.length - 1;
          while (cut > 1 && f.widthOfTextAtSize(w.slice(0, cut), size) > width) cut--;
          if (line) {
            out.push(line);
            line = '';
          }
          out.push(w.slice(0, cut));
          w = w.slice(cut);
        }
        const next = line ? `${line} ${w}` : w;
        if (f.widthOfTextAtSize(next, size) > width && line) {
          out.push(line);
          line = w;
        } else line = next;
      }
      out.push(line);
    }
    return out;
  }
  para(s: string, opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; x?: number; width?: number } = {}): void {
    const size = opts.size ?? 9.5;
    const x = opts.x ?? M;
    for (const l of this.wrap(s, opts.width ?? A4[0] - M - x, size, opts.bold)) {
      this.need(size + 4);
      this.text(l, x, size, opts);
      this.y -= size + 3.6;
    }
  }
  heading(s: string): void {
    this.need(40);
    this.y -= 8;
    this.text(s, M, 11.5, { bold: true });
    this.y -= 6;
    this.page.drawLine({ start: { x: M, y: this.y }, end: { x: A4[0] - M, y: this.y }, thickness: 0.6, color: LINE });
    this.y -= 14;
  }
  kv(k: string, v: string): void {
    const lines = this.wrap(v || '–', W - 150, 9.5);
    this.need(lines.length * 13 + 2);
    this.text(k, M, 9, { color: MUTED });
    for (const l of lines) {
      this.text(l, M + 150, 9.5);
      this.y -= 13;
    }
    this.y -= 1;
  }
  bullet(s: string, mark = '•'): void {
    const lines = this.wrap(s, W - 18, 9.5);
    this.need(lines.length * 13);
    this.text(mark, M, 9.5);
    for (const l of lines) {
      this.text(l, M + 18, 9.5);
      this.y -= 13;
    }
    this.y -= 2;
  }
  stamp(s: string): void {
    this.para(s, { size: 10, bold: true, color: RED });
    this.y -= 4;
  }
}

const dateTime = new Intl.DateTimeFormat('da-DK', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Copenhagen',
});
export function fmtTime(sec: number | null | undefined): string {
  return sec ? `${dateTime.format(new Date(sec * 1000))} (dansk tid)` : '–';
}

export type DocKind = 'approved' | 'activated';

/** Selve fuldmagten. `kind = 'activated'` medtager Veyros accept. */
export async function renderPoaPdf(snap: Snapshot, row: PoaRow, kind: DocKind, hash: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const title = `Fuldmagt ${snap.number}${snap.version > 1 ? ` version ${snap.version}` : ''}`;
  doc.setTitle(winAnsi(title));
  doc.setAuthor('Veyro');
  doc.setProducer('Veyro kundeportal');
  doc.setCreator('Veyro kundeportal');
  const fixed = new Date((kind === 'activated' ? row.activated_at ?? row.approved_at! : row.approved_at!) * 1000);
  doc.setCreationDate(fixed);
  doc.setModificationDate(fixed);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const w = new Writer(doc, font, bold, `${title} · Godkendt version · SHA-256 ${hash}`);

  w.text('Veyro', M, 16, { bold: true });
  w.page.drawCircle({ x: M + bold.widthOfTextAtSize('Veyro', 16) + 3, y: w.y + 1.5, size: 1.8, color: ACCENT });
  w.y -= 30;
  w.text('FULDMAGT', M, 20, { bold: true });
  w.y -= 18;
  w.text(`${snap.number}${snap.version > 1 ? ` · version ${snap.version}` : ''} · Tekst: ${snap.text_version}`, M, 9.5, { color: MUTED });
  w.y -= 18;
  if (snap.test) w.stamp(`${snap.test.toUpperCase()}: TESTDOKUMENT – IKKE GYLDIGT`);
  if (snap.text_draft) w.stamp('UDKAST: Fuldmagtsteksten er endnu ikke endeligt gennemgået og godkendt af Veyro.');

  w.heading('Fuldmagtsgiver (kunden)');
  w.kv('Virksomhed', snap.customer.company_name);
  w.kv('CVR-nummer', snap.customer.cvr);
  w.kv('Adresse', `${snap.customer.address}, ${snap.customer.postal_city}`);
  w.kv('Kontaktperson', snap.customer.contact_name);
  w.kv('E-mail til kvittering', snap.customer.receipt_email);

  w.heading('Fuldmægtig (Veyro)');
  w.kv('Juridisk navn', snap.veyro.legal_name);
  w.kv('CVR-nummer', snap.veyro.cvr);
  w.kv('Adresse', snap.veyro.address);
  w.kv('Kontaktperson', snap.veyro.contact_name);
  w.kv('Kontaktmail', snap.veyro.contact_email);

  w.heading('Fuldmagtens omfang');
  w.kv('Projekt / system', snap.scope.project);
  w.kv('Formål og opgaver', snap.scope.purpose);
  w.kv('Leverandører, systemer og konti', snap.scope.parties.length ? snap.scope.parties.join('\n') : 'Ingen navngivne');
  w.kv('Udløbsdato', snap.scope.expires_on ? `${formatDay(snap.scope.expires_on)} (gyldig til og med denne dag)` : 'Ingen – gælder indtil den tilbagekaldes');

  w.heading('Beføjelser');
  w.para('Kun afkrydsede beføjelser er givet. Beføjelser, der ikke er afkrydset, er ikke givet.', { size: 9, color: MUTED });
  w.y -= 4;
  for (const p of snap.powers) {
    const head = `${p.granted ? '[X] GIVET' : '[  ] IKKE GIVET'} – ${p.label}`;
    w.need(30);
    w.para(head, { bold: true, size: 9.5, color: p.granted ? INK : MUTED });
    w.para(p.key === 'other' && snap.other_text ? snap.other_text : p.description, { size: 9, x: M + 18, color: p.granted ? INK : MUTED });
    w.y -= 4;
  }

  if (snap.orders) {
    const o = snap.orders;
    w.heading('Betingelser for bestillinger');
    w.kv('Maks. pr. bestilling', `${formatKr(o.max_per_order_oere)} inkl. moms`);
    w.kv('Maks. pr. kalendermåned', `${formatKr(o.max_per_month_oere)} inkl. moms`);
    w.kv('Godkendte leverandører', o.suppliers.join('\n'));
    w.kv('Varer eller ydelser', o.types.join('\n'));
    w.kv('Periode', `${formatDay(o.start)} til og med ${formatDay(o.end)}`);
    w.para(o.exclusions, { size: 9.5, bold: true });
  }

  w.heading('Begrænsninger og vilkår');
  for (const t of snap.terms) w.bullet(t);

  w.heading('Kundens bekræftelser');
  for (const c of snap.confirmations) w.bullet(c, '[X]');

  w.heading('Godkendelse');
  w.kv('Godkendt af', `${row.approver_name ?? snap.approver.name}, ${row.approver_title ?? snap.approver.title}`);
  w.kv('Indlogget konto', row.approver_email ?? snap.approver.account_email);
  w.kv('Tidspunkt', fmtTime(row.approved_at));
  w.kv('Metode', row.approval_method ?? '');
  w.kv('Tekstversion', snap.text_version);
  w.kv('Indholdets SHA-256', hash);
  if (snap.requires_veyro_acceptance) {
    if (kind === 'activated' && row.veyro_accepted_at) {
      w.kv('Veyros accept', `Accepteret ${fmtTime(row.veyro_accepted_at)}`);
      w.kv('Aktiv fra', fmtTime(row.activated_at));
    } else {
      w.kv('Veyros accept', 'Afventer. Fuldmagten er ikke aktiv, før Veyro har accepteret den.');
    }
  } else {
    w.kv('Aktiv fra', fmtTime(row.activated_at ?? row.approved_at));
  }

  return doc.save({ useObjectStreams: false });
}

/**
 * Downloadet dokument: en statusside med den aktuelle status foran det oprindelige, uændrede dokument.
 * Det oprindelige dokument kan også hentes alene.
 */
export async function withStatusPage(original: Uint8Array, row: PoaRow, sha: string, extra: string[] = []): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const name = `${row.number}${row.version > 1 ? ` v${row.version}` : ''}`;
  doc.setTitle(winAnsi(`Fuldmagt ${name} – aktuel status`));
  doc.setProducer('Veyro kundeportal');
  const w = new Writer(doc, font, bold, `Statusside for fuldmagt ${name}. Den oprindelige fuldmagt følger på de næste sider uændret.`);
  w.text('Veyro', M, 16, { bold: true });
  w.y -= 30;
  w.text('AKTUEL STATUS', M, 20, { bold: true });
  w.y -= 26;
  const ended = row.status === 'revoked' || row.status === 'expired';
  w.text(STATUS_LABEL[row.status].toUpperCase(), M, 16, { bold: true, color: ended ? RED : INK });
  w.y -= 24;
  w.kv('Fuldmagt', name);
  w.kv('Status pr.', fmtTime(Math.floor(Date.now() / 1000)));
  if (row.revoked_at) w.kv('Tilbagekaldt', fmtTime(row.revoked_at));
  if (row.expired_at) w.kv('Udløbet', fmtTime(row.expired_at));
  if (row.activated_at) w.kv('Aktiv fra', fmtTime(row.activated_at));
  if (row.status === 'pending') w.kv('Veyros accept', 'Afventer');
  w.kv('Udløbsdato', row.expires_on ? formatDay(row.expires_on) : 'Ingen');
  for (const e of extra) w.para(e, { size: 9.5 });
  w.y -= 8;
  if (ended) {
    w.para('Fuldmagten gælder ikke længere. Veyro kan ikke udføre nye handlinger under den. Den oprindelige fuldmagt nedenfor er bevaret som historisk dokument.', {
      bold: true,
    });
  }
  w.y -= 6;
  w.para(`Det oprindelige dokument følger uændret. SHA-256 af det oprindelige dokument: ${sha}`, { size: 8.5, color: MUTED });
  const src = await PDFDocument.load(original);
  const pages = await doc.copyPages(src, src.getPageIndices());
  for (const p of pages) doc.addPage(p);
  return doc.save({ useObjectStreams: false });
}
