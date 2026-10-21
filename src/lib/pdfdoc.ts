// Fælles PDF-hjælper (A4, pdf-lib med standardskriften Helvetica) til aftaler og dokumenter i kundeportalen.
// Kopieret fra fuldmagternes PDF (poa-pdf.ts), så fortrolighedsaftaler og fuldmagter ser ens ud.
import { rgb, type PDFDocument, type PDFFont, type PDFPage } from 'pdf-lib';

/** Helvetica kan kun skrive Windows-1252; andre tegn erstattes, så PDF'en altid kan laves. */
const EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
export function winAnsi(s: string): string {
  return s
    .replace(/[‐-‒]/g, '-')
    .replace(/[  ]/g, ' ')
    .replace(/[^\n\x20-\x7e\xa0-\xff]/g, (ch) => (EXTRA.includes(ch) ? ch : '?'));
}

export const A4: [number, number] = [595.28, 841.89];
export const M = 50;
export const W = A4[0] - 2 * M;
export const INK = rgb(0.06, 0.06, 0.05);
export const MUTED = rgb(0.38, 0.37, 0.34);
export const LINE = rgb(0.85, 0.84, 0.8);
export const RED = rgb(0.72, 0.12, 0.08);
export const ACCENT = rgb(1, 0.353, 0.122);

export class Writer {
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

