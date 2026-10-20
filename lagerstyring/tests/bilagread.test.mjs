import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { pdfText } from '../src/lib/pdftext.ts';
import { datesIn, readText } from '../src/lib/bilagread.ts';

describe('Aflæsning af bilag', () => {
  it('fiktiv testfaktura: datoer læses ikke som beløb, varenavn står over tallene', async () => {
    const t = await pdfText(new Uint8Array(readFileSync(new URL('./fixtures/testfaktura-fiktiv.pdf', import.meta.url))));
    const r = readText(t.pages, { ownName: 'Mit firma' });
    expect(r.values).toMatchObject({
      supplier_name: 'Demo Byg & Montage (fiktiv)',
      doc_number: 'TEST-2026-001',
      doc_date: '2026-10-20',
      due_date: '2026-11-03',
      net: 296048,
      vat: 74012,
      total: 370060,
      line_prices: 'ekskl',
    });
    expect(r.notes).toEqual([]);
    expect(r.lines.map((l) => [l.name, l.qty, l.unit, l.unit_price, l.amount, l.uncertain])).toEqual([
      ['TEST-M001 Træskruer 4 x 40 mm, 200 stk.', 2000, 'pakker', 8900, 17800, false],
      ['TEST-M002 Reglar 45 x 95 mm, 2,4 m', 8000, 'stk.', 3920, 31360, false],
      ['TEST-M003 Gipsplade 13 x 900 x 2400 mm', 6000, 'stk.', 5400, 32400, false],
      ['TEST-M004 Akrylfuge hvid, 300 ml', 3000, 'patroner', 3996, 11988, false],
      ['TEST-L001 Montagearbejde', 4500, 'timer', 45000, 202500, false],
    ]);
  });

  it('engelsk faktura (Stripe-layout): leverandør, nummer, datoer, moms over sin tekst', () => {
    const lines = [
      'Invoice',
      'Invoice number ABC123-0013',
      'Date of issue  October 20, 2026',
      'Date due  November 3, 2026',
      'Example Software Limited  Bill to',
      '1 Example Street  Kunde Kundesen',
      'IE VAT IE1234567AB',
      '726.77kr due October 20, 2026',
      'Description  Qty  Unit price  Tax  Amount',
      'Pro Subscription (per seat)  1  631.20kr  25%  631.20kr',
      'Oct 20-Nov 20, 2026',
      'Unused time on Plus Subscription  1  25%  -49.78kr',
      'Subtotal  581.42kr',
      'Total excluding tax  581.42kr',
      '145.35kr',
      'VAT - Denmark -25% on 581.42kr)',
      '-€19.45-',
      'Total  726.77kr',
      'Amount due  726.77kr',
    ];
    const r = readText([lines], { ownName: 'Mit firma' });
    expect(r.values).toMatchObject({
      supplier_name: 'Example Software Limited',
      doc_number: 'ABC123-0013',
      doc_date: '2026-10-20',
      due_date: '2026-11-03',
      currency: 'DKK',
      net: 58142,
      vat: 14535,
      total: 72677,
    });
    expect(r.lines.map((l) => l.amount)).toEqual([63120, -4978]);
  });

  it('datoer på dansk og engelsk', () => {
    expect(datesIn('Fakturadato 20.10.2026')).toEqual(['2026-10-20']);
    expect(datesIn('20. oktober 2026')).toEqual(['2026-10-20']);
    expect(datesIn('Date of issue October 20, 2026')).toEqual(['2026-10-20']);
    expect(datesIn('after 3 Oct 2026')).toEqual(['2026-10-03']);
  });
});
