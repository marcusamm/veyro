import { describe, expect, it } from 'vitest';
import { detectDelimiter, exportCsv, parseCsv, parseImport, planImport } from '../src/lib/csv.ts';
import { parseKr } from '../src/lib/format.ts';

describe('CSV-læsning', () => {
  it('genkender semikolon, komma og tab', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('a,b,c')).toBe(',');
    expect(detectDelimiter('a\tb\tc')).toBe('\t');
    expect(detectDelimiter('"a;b",c,d')).toBe(',');
  });

  it('håndterer citationstegn, "" og linjeskift i felter samt BOM', () => {
    const rows = parseCsv('﻿navn;tekst\r\n"Kaffe; mørk";"Linje 1\nLinje 2 med ""citat"""\r\n\r\n');
    expect(rows).toEqual([
      ['navn', 'tekst'],
      ['Kaffe; mørk', 'Linje 1\nLinje 2 med "citat"'],
    ]);
  });
});

describe('Beløb', () => {
  it('læser danske og engelske beløb', () => {
    expect(parseKr('1.299,50')).toBe(129950);
    expect(parseKr('1299,5')).toBe(129950);
    expect(parseKr('1299.50')).toBe(129950);
    expect(parseKr('1.299')).toBe(129900);
    expect(parseKr('49 kr.')).toBe(4900);
    expect(parseKr('0')).toBe(0);
    expect(parseKr('-5')).toBeNull();
    expect(parseKr('abc')).toBeNull();
  });
});

describe('Import af vareliste', () => {
  it('genkender danske kolonnenavne og validerer rækker', () => {
    const csv = [
      'Varenr.;Varenavn;Varegruppe;Salgspris;Beholdning;Enhed;Aktiv;Ukendt',
      'K-1;Kaffe;Drikke;45,00;10;pose;ja;x',
      'K-2;Te;Drikke;29;;;nej;',
      ';Mangler nummer;;10;1;;;',
      'K-3;Dårlig pris;;gratis;1;;;',
      'K-1;Dublet;;10;1;;;',
      'K-4;Negativt lager;;10;-2;;;',
    ].join('\n');
    const p = parseImport(csv);
    expect(p.columns).toEqual(['sku', 'name', 'category', 'price', 'stock', 'unit', 'active']);
    expect(p.unknownColumns).toEqual(['Ukendt']);
    expect(p.rows.map((r) => r.sku)).toEqual(['K-1', 'K-2']);
    expect(p.rows[0]).toMatchObject({ name: 'Kaffe', category: 'Drikke', price: 4500, stock: 10, unit: 'pose', active: true });
    expect(p.rows[1]).toMatchObject({ price: 2900, active: false });
    expect(p.rows[1].stock).toBeUndefined();
    expect(p.errors.map((e) => e.line)).toEqual([4, 5, 6, 7]);
  });

  it('kræver en varenummer-kolonne', () => {
    const p = parseImport('Navn;Pris\nKaffe;10');
    expect(p.errors[0].message).toMatch(/varenummer/i);
  });

  it('planlægger opret/opdater/uændret og kræver navn og pris til nye varer', () => {
    const existing = new Map([
      ['k-1', { id: 1, sku: 'K-1', name: 'Kaffe', category: 'Drikke', description: '', unit: 'stk.', price: 4500, image_url: '', track_stock: 1, stock: 10, low_stock_threshold: null, active: 1, sort_order: 0 }],
      ['k-2', { id: 2, sku: 'K-2', name: 'Te', category: '', description: '', unit: 'stk.', price: 2900, image_url: '', track_stock: 1, stock: 3, low_stock_threshold: null, active: 1, sort_order: 0 }],
    ]);
    const p = parseImport('SKU;Pris;Lager;Navn\nk-1;45;10;Kaffe\nK-2;30;;Te\nK-9;;5;Ny uden pris\nK-10;12;;Ny');
    const { planned, errors } = planImport(p, existing);
    expect(planned.map((r) => [r.sku, r.action])).toEqual([
      ['k-1', 'uændret'],
      ['K-2', 'opdater'],
      ['K-10', 'opret'],
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/mangler pris/);
  });

  it('eksport kan importeres igen og beskytter mod Excel-formler', () => {
    const products = [{ sku: 'A-1', name: '=HYPERLINK("x")', category: 'Kat; 1', description: 'To\nlinjer', unit: 'stk.', price: 12950, image_url: '', track_stock: 1, stock: 4, low_stock_threshold: 2, active: 1, sort_order: -1 }];
    const csv = exportCsv(products);
    expect(csv).toContain(`'=HYPERLINK`);
    const p = parseImport(csv);
    expect(p.errors).toEqual([]);
    expect(p.rows[0]).toMatchObject({ sku: 'A-1', category: 'Kat; 1', description: 'To\nlinjer', price: 12950, stock: 4, low_stock_threshold: 2, active: true, track_stock: true, sort_order: -1 });
  });
});
