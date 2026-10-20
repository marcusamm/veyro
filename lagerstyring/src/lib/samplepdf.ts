// Fiktive leverandørbilag som PDF til demoen og testene. De ligner rigtige fakturaer og
// kvitteringer med tekst, så den indbyggede PDF-læser kan aflæse dem. Alle er mærket som demodata.

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { formatKr, formatQty } from './format';
import { winAnsi } from './pdf';

export interface SampleLine {
  sku?: string;
  name: string;
  qty: number; // tusindedele
  unit: string;
  price: number; // øre pr. enhed ekskl. moms
  discount?: number; // øre
}

export interface SampleDoc {
  kind: 'faktura' | 'kvittering' | 'kreditnota';
  supplier: string;
  address: string;
  cvr: string;
  number: string;
  date: string; // YYYY-MM-DD
  due?: string;
  buyer: string;
  lines: SampleLine[];
  vatRate?: number; // 2500
  payment?: string;
  extraPages?: number;
}

const dk = (day: string) => `${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(0, 4)}`;
const kr = (o: number) => formatKr(o, { decimals: true }).replace(/\s*kr\.?$/, '');

export function sampleTotals(d: SampleDoc): { net: number; vat: number; total: number } {
  const net = d.lines.reduce((a, l) => a + Math.round((l.qty * l.price) / 1000) - (l.discount ?? 0), 0);
  const vat = Math.round((net * (d.vatRate ?? 2500)) / 10000);
  return { net, vat, total: net + vat };
}

export async function samplePdf(d: SampleDoc): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(winAnsi(`${d.supplier} ${d.number}`));
  doc.setProducer('Veyro demo');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([595.28, 841.89]);
  const ink = rgb(0.1, 0.1, 0.1);
  const grey = rgb(0.4, 0.4, 0.4);
  let y = 790;
  const t = (s: string, x: number, size = 9.5, o: { b?: boolean; right?: boolean; c?: ReturnType<typeof rgb> } = {}) => {
    const f = o.b ? bold : font;
    const w = f.widthOfTextAtSize(winAnsi(s), size);
    page.drawText(winAnsi(s), { x: o.right ? x - w : x, y, size, font: f, color: o.c ?? ink });
  };
  const title = d.kind === 'kreditnota' ? 'KREDITNOTA' : d.kind === 'faktura' ? 'FAKTURA' : 'KVITTERING';
  t(d.supplier, 50, 15, { b: true });
  t(title, 545, 16, { b: true, right: true });
  y -= 18;
  t(d.address, 50, 9, { c: grey });
  t(`${d.kind === 'kreditnota' ? 'Kreditnotanr.' : d.kind === 'faktura' ? 'Fakturanr.' : 'Kvitteringsnr.'}: ${d.number}`, 545, 9.5, { right: true });
  y -= 13;
  t(`CVR-nr. ${d.cvr.replace(/(\d{2})(?=\d)/g, '$1 ')}`, 50, 9, { c: grey });
  t(`${d.kind === 'kvittering' ? 'Dato' : d.kind === 'kreditnota' ? 'Kreditnotadato' : 'Fakturadato'}: ${dk(d.date)}`, 545, 9.5, { right: true });
  y -= 13;
  if (d.due) {
    t(`Forfaldsdato: ${dk(d.due)}`, 545, 9.5, { right: true });
    y -= 13;
  }
  y -= 14;
  t(`Kunde: ${d.buyer}`, 50, 9.5);
  y -= 30;
  // Kolonner
  const C = { sku: 50, name: 110, qty: 330, unit: 348, price: 430, disc: 485, amount: 545 };
  const head = () => {
    t('Varenr.', C.sku, 8.5, { b: true });
    t('Beskrivelse', C.name, 8.5, { b: true });
    t('Antal', C.qty, 8.5, { b: true, right: true });
    t('Enhed', C.unit, 8.5, { b: true });
    t('Á-pris', C.price, 8.5, { b: true, right: true });
    t('Rabat', C.disc, 8.5, { b: true, right: true });
    t('Beløb', C.amount, 8.5, { b: true, right: true });
    y -= 6;
    page.drawLine({ start: { x: 50, y }, end: { x: 545, y }, thickness: 0.5, color: grey });
    y -= 13;
  };
  head();
  for (const l of d.lines) {
    const amount = Math.round((l.qty * l.price) / 1000) - (l.discount ?? 0);
    t(l.sku ?? '-', C.sku, 9);
    t(l.name, C.name, 9);
    t(formatQty(l.qty), C.qty, 9, { right: true });
    t(l.unit, C.unit, 9);
    t(kr(l.price), C.price, 9, { right: true });
    t(l.discount ? kr(l.discount) : '0,00', C.disc, 9, { right: true });
    t(kr(amount), C.amount, 9, { right: true });
    y -= 14;
  }
  y -= 6;
  page.drawLine({ start: { x: 300, y }, end: { x: 545, y }, thickness: 0.5, color: grey });
  y -= 16;
  const tot = sampleTotals(d);
  const rate = (d.vatRate ?? 2500) / 100;
  t('Subtotal ekskl. moms', 300, 9.5);
  t(kr(tot.net), C.amount, 9.5, { right: true });
  y -= 14;
  t(`Moms ${rate} %`, 300, 9.5);
  t(kr(tot.vat), C.amount, 9.5, { right: true });
  y -= 16;
  t(d.kind === 'kreditnota' ? 'Krediteres i alt DKK' : d.kind === 'kvittering' ? 'Betalt i alt DKK' : 'At betale DKK', 300, 11, { b: true });
  t(kr(tot.total), C.amount, 11, { b: true, right: true });
  y -= 40;
  if (d.payment) {
    t(d.payment, 50, 9);
    y -= 14;
  }
  y = 40;
  t('DEMODATA: fiktiv leverandør og fiktivt bilag til demonstration.', 50, 7.5, { c: grey });
  for (let i = 0; i < (d.extraPages ?? 0); i++) {
    const p = doc.addPage([595.28, 841.89]);
    p.drawText(winAnsi(`Leveringsbetingelser (side ${i + 2}). Fiktiv tekst til demonstration.`), { x: 50, y: 790, size: 9, font, color: grey });
  }
  return doc.save();
}
