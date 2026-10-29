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

  it('fiktiv kassebon uden kolonneoverskrift: varenavn og udtrykkelig antal x pris på hver sin linje', () => {
    const r = readText([[
      'TESTDATA Byggehandel A/S',
      'CVR: 12 34 56 78',
      'KASSE 04  BILAG: 0000123',
      '29/10/2026 16:42:09',
      'EKSP: 019 / TERMINAL: 02',
      'TEST Skruer 5,0x70 200STK',
      '2 x 89,95 179,90',
      'TEST Lægte 38X57 4,2M',
      '7 × 44,50   311,50',
      'Netto 393,12',
      'Heraf moms 25% 98,28',
      'I alt DKK 491,40',
    ]]);
    expect(r.values).toMatchObject({ supplier_cvr: '12345678', doc_number: '0000123', doc_date: '2026-10-29', net: 39312, vat: 9828, total: 49140, line_prices: 'inkl' });
    expect(r.lines).toEqual([
      { name: 'TEST Skruer 5,0x70 200STK', qty: 2000, unit: '', unit_price: 8995, amount: 17990, discount: 0, vat_rate: 2500, uncertain: true },
      { name: 'TEST Lægte 38X57 4,2M', qty: 7000, unit: '', unit_price: 4450, amount: 31150, discount: 0, vat_rate: 2500, uncertain: true },
    ]);
  });

  it('kassebon: decimalantal, retur og trykte beløb bevares til kontrol uden gættede enheder eller moms', () => {
    const r = readText([[
      'TESTDATA Fiktiv handel',
      'TEST Løst materiale 2,5KG',
      '1,5 x 20,00 kr. 30,00 kr.',
      'TEST Returvare 200STK',
      '-2 x 10,00 -20,00',
      'TEST Vare med fejl i regnestykket',
      '2 x 15,00 29,00',
      'I alt 39,00',
    ]]);
    expect(r.lines.map((l) => [l.qty, l.unit, l.unit_price, l.amount, l.vat_rate, l.uncertain])).toEqual([
      [1500, '', 2000, 3000, null, true],
      [-2000, '', 1000, -2000, null, true],
      [2000, '', 1500, 2900, null, true],
    ]);
    expect(r.values.vat).toBeUndefined();
    expect(r.notes).toContain('Momsen blev ikke fundet. Angiv den (også 0 kr.), før bilaget godkendes.');
  });

  it('kassebon: ingen varelinjer udledes af metadata, pakningsstørrelser eller ufuldstændige beløb', () => {
    const r = readText([[
      'TESTDATA Fiktiv handel',
      'CVR: 12 34 56 78',
      '2 x 10,00 20,00',
      'KASSE 02 BILAG: 0000456',
      '1 x 40,00 40,00',
      '29/10/2026 16:42:09',
      '1 x 50,00 50,00',
      'TEST Skruer 4,0x60 200STK',
      '89,95 179,90',
      'TEST Manglende slutbeløb',
      '2 x 89,95',
      'Rabat',
      '1 x 10,00 10,00',
    ]]);
    expect(r.values.doc_number).toBe('0000456');
    expect(r.lines).toEqual([]);
  });

  it('kassebon: stopper ved totalen og laver ikke betalings- eller rabatlinjer til varer', () => {
    const r = readText([[
      'TESTDATA Fiktiv handel',
      'TEST Vare',
      '1 x 100,00 100,00',
      'Rabat',
      '1 x 10,00 10,00',
      'I alt 90,00',
      'TEST Betalingsreference',
      '1 x 90,00 90,00',
    ]]);
    expect(r.lines.map((l) => [l.name, l.amount, l.discount])).toEqual([['TEST Vare', 10000, 0]]);
    expect(r.uncertain).toContain('line_prices');
  });

  it('kasse-id, ekspedient og terminal bruges ikke som bilagsnummer uden udtrykkelig bilagslabel', () => {
    expect(readText([['TESTDATA', 'KASSE 04', 'EKSP: 019 / TERMINAL: 02']]).values.doc_number).toBeUndefined();
  });

  it('fiktiv kassebon med heraf-moms: subtotal kopieres ikke til netto, og intet nettobeløb beregnes', () => {
    const r = readText([[
      'TESTDATA Fiktiv handel',
      'KASSE 01 BILAG: TEST-BON-001',
      'TEST Vare',
      '2 x 100,00 200,00',
      'RETUR TEST Anden vare',
      '-1 x 20,00 -20,00',
      'SUBTOTAL 180,00',
      'MOMSPLIGTIGT 176,00',
      'MOMS 25% (HERAF) 35,20',
      '0% MOMS PANT 0,00',
      'TOTAL DKK 184,00',
    ]]);
    expect(r.values).toMatchObject({ vat: 3520, total: 18400, line_prices: 'inkl' });
    expect(r.values.net).toBeUndefined();
    expect(r.notes.some((n) => n.includes('beregnet som total minus moms'))).toBe(false);
    expect(r.lines.map((l) => [l.name, l.qty, l.amount, l.uncertain])).toEqual([
      ['TEST Vare', 2000, 20000, true],
      ['RETUR TEST Anden vare', -1000, -2000, true],
    ]);
    expect(r.uncertain).toContain('line_prices');
  });

  it('inklusive kassebon bevarer et udtrykkeligt trykt nettobeløb og kræver ikke at det beregnes', () => {
    const r = readText([[
      'TESTDATA Kvittering',
      'TEST Vare',
      '1 x 125,00 125,00',
      'Subtotal 125,00',
      'Ekskl. moms 100,00',
      'Heraf moms 25% 25,00',
      'I alt 125,00',
    ]]);
    expect(r.values).toMatchObject({ net: 10000, vat: 2500, total: 12500, line_prices: 'inkl' });
    expect(r.uncertain).not.toContain('line_prices');
    expect(r.lines.every((l) => l.uncertain)).toBe(true);
  });

  it('faktura bevarer eksisterende subtotal- og nettoberegning, også med heraf-moms', () => {
    const explicitSubtotal = readText([['TESTDATA Faktura', 'Subtotal 100,00', 'Heraf moms 25,00', 'I alt 125,00']]);
    expect(explicitSubtotal.values).toMatchObject({ net: 10000, vat: 2500, total: 12500 });
    const derived = readText([['TESTDATA Faktura', 'Heraf moms 25,00', 'I alt 125,00']]);
    expect(derived.values.net).toBe(10000);
    expect(derived.uncertain).toContain('net');
  });

  it('returtekst accepteres kun for en navngiven vare med udtrykkeligt negativt antal', () => {
    const r = readText([[
      'TESTDATA Kvittering',
      'RETUR TEST Vare med positivt antal',
      '1 x 20,00 20,00',
      'RETUR kontant',
      '-1 x 20,00 -20,00',
      'RETUR',
      '-1 x 20,00 -20,00',
      'RETUR TEST Rigtig vare',
      '-1 x 20,00 -20,00',
      'TOTAL -20,00',
    ]]);
    expect(r.lines.map((l) => [l.name, l.qty, l.amount])).toEqual([['RETUR TEST Rigtig vare', -1000, -2000]]);
  });

  it('datoer på dansk og engelsk', () => {
    expect(datesIn('Fakturadato 20.10.2026')).toEqual(['2026-10-20']);
    expect(datesIn('20. oktober 2026')).toEqual(['2026-10-20']);
    expect(datesIn('Date of issue October 20, 2026')).toEqual(['2026-10-20']);
    expect(datesIn('after 3 Oct 2026')).toEqual(['2026-10-03']);
  });
});
