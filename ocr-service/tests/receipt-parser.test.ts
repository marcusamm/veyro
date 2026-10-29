import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readText } from '../../lagerstyring/src/lib/bilagread';

const captured = JSON.parse(readFileSync(process.env.OCR_SMOKE_REPORT || new URL('../engine/tests/fixtures/paddle-testdata.json', import.meta.url), 'utf8'));
const samples = captured.cases || [captured];

describe.each(samples)('genuine PaddleOCR output reaches Veyro receipt fields', (sample) => {
  it('preserves Danish columns, units, quantities and øre on captured TESTDATA', () => {
    expect(captured.fixture).toContain('TESTDATA');
    const result = readText(sample.pages.map((p: string) => p.split('\n')), { ownName: 'TESTDATA kunde' });
    expect(result.values).toMatchObject({ doc_date: '2026-10-29', net: 37000, vat: 9250, total: 46250, currency: 'DKK' });
    expect(result.lines.map((l) => [l.name, l.qty, l.unit, l.unit_price, l.amount])).toEqual([
      ['Skruer 5 x 80 mm', 2000, 'pk.', 12500, 25000],
      ['Fugemasse hvid', 3000, 'stk.', 4000, 12000],
    ]);
  });
});
