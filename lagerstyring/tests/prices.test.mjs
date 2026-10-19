// Prisberegning og match uden database: pakker, moms, tilbud, match-rækkefølge og prisfiler.
import { describe, expect, it } from 'vitest';
import { buyPlan, convertVat, ean13, findMatch, lineEstimate, normGtin, parseFeed, summarize } from '../src/lib/prices.ts';

const K = 1000;
const offer = (o = {}) => ({
  sales_unit: 'pk.',
  pack_qty: 10 * K,
  content_unit: 'stk.',
  min_qty: 1 * K,
  divisible: 0,
  price: 10000,
  vat: 'inkl',
  offer_price: null,
  offer_text: '',
  offer_min_qty: null,
  offer_until: '',
  ...o,
});

describe('købsmængde', () => {
  it('12 stk. i pakker á 10 til 100 kr. giver 2 pakker, 20 stk. og 200 kr.', () => {
    const p = buyPlan(12 * K, 'stk.', offer());
    expect(p).toMatchObject({ ok: true, buy: 2 * K, covered: 20 * K, amount: 20000 });
  });
  it('respekterer mindstekøb og delbare metervarer', () => {
    expect(buyPlan(2 * K, 'stk.', offer({ pack_qty: 1 * K, min_qty: 5 * K, sales_unit: 'stk.' }))).toMatchObject({ buy: 5 * K, covered: 5 * K });
    const m = buyPlan(12500, 'm', offer({ sales_unit: 'm', content_unit: 'm', pack_qty: 1 * K, divisible: 1, price: 1850 }));
    expect(m).toMatchObject({ ok: true, buy: 12500, amount: 23125 });
  });
  it('afviser enheder, der ikke kan omregnes', () => {
    expect(buyPlan(3 * K, 'm²', offer()).ok).toBe(false);
  });
  it('bruger kun tilbud, når betingelserne er opfyldt', () => {
    const o = offer({ offer_price: 8000, offer_min_qty: 3 * K, offer_text: 'Ved køb af 3 pakker' });
    expect(buyPlan(12 * K, 'stk.', o)).toMatchObject({ offer: 'opfyldes_ikke', amount: 20000 });
    expect(buyPlan(25 * K, 'stk.', o)).toMatchObject({ offer: 'gaelder', amount: 24000 });
    expect(buyPlan(25 * K, 'stk.', offer({ offer_price: 8000, offer_until: '2020-01-01' }), '2026-10-19')).toMatchObject({ offer: 'udloebet', amount: 30000 });
  });
  it('omregner moms', () => {
    expect(convertVat(12500, 'inkl', 'ekskl')).toBe(10000);
    expect(convertVat(10000, 'ekskl', 'inkl')).toBe(12500);
  });
});

describe('match', () => {
  const ean = ean13('200000000001');
  const want = { ean, mpn: 'GN13-25', brand: 'Gyproc', variant: '', name: 'Gipsplade 13 mm 900×2500', unit: 'stk.' };
  const c = (o) => ({ ean: '', mpn: '', brand: '', variant: '', content_unit: 'stk.', ...o });
  it('EAN giver præcist match', () => {
    expect(normGtin(ean)).toBe('0' + ean);
    expect(normGtin('2000000000019')).toBeNull();
    expect(findMatch(want, [c({ name: 'Noget andet', ean: '0' + ean })])).toMatchObject({ match: 'praecis', basis: 'ean' });
  });
  it('producentnr. kræver samme mærke og variant', () => {
    expect(findMatch({ ...want, ean: '' }, [c({ name: 'X', mpn: 'gn13 25', brand: 'gyproc' })])).toMatchObject({ match: 'praecis', basis: 'mpn' });
    expect(findMatch({ ...want, ean: '' }, [c({ name: 'X', mpn: 'GN13-25', brand: 'Knauf' })])).toBeNull();
    expect(findMatch({ ...want, ean: '' }, [c({ name: 'X', mpn: 'GN13-25', brand: 'Gyproc', variant: 'Grøn' })])).toBeNull();
  });
  it('navnematch er altid et alternativ og kræver samme mål', () => {
    const w = { ...want, ean: '', mpn: '' };
    expect(findMatch(w, [c({ name: 'Gipsplade standard 13 mm 900 x 2500' })])).toMatchObject({ match: 'alternativ', basis: 'navn' });
    expect(findMatch(w, [c({ name: 'Gipsplade 13 mm 900×2400' })])).toBeNull();
    expect(findMatch(w, [c({ name: 'Gipsplade 13 mm 900×2500', content_unit: 'm²' })])).toBeNull();
  });
  it('sammenligner aldrig forhandlernes egne varenumre', () => {
    expect(findMatch({ ...want, ean: '', mpn: '', name: 'Fugemasse' }, [c({ name: 'Maling', retailer_sku: 'GIP-13' })])).toBeNull();
  });
});

describe('estimat pr. linje og liste', () => {
  const opts = { basis: 'ekskl', maxAgeDays: 7, now: 2_000_000_000, today: '2026-10-19' };
  const est = (o) => ({ ...offer(), id: 1, retailer_id: 1, retailer_name: 'A', retailer_access: 'demo', match: 'praecis', approved_at: null, status: 'aktuel', checked_at: opts.now, ...o });
  const line = { qty: 12 * K, ordered: 0, cancelled: 0, unit: 'stk.' };
  it('fremhæver laveste sammenlignelige pris og vælger den', () => {
    const r = lineEstimate(line, [est({ id: 1 }), est({ id: 2, retailer_id: 2, price: 9000 })], opts);
    expect(r.chosen.est.id).toBe(2);
    expect(r.offers.filter((x) => x.lowest).map((x) => x.est.id)).toEqual([2]);
    expect(r.chosen.amount).toBe(14400); // 2 × 90 kr. inkl. moms = 144 kr. ekskl.
  });
  it('alternativer tæller først med efter godkendelse', () => {
    const alt = est({ id: 3, retailer_id: 3, match: 'alternativ', price: 5000 });
    expect(lineEstimate(line, [alt], opts).chosen).toBeNull();
    expect(lineEstimate(line, [{ ...alt, approved_at: 1 }], opts).chosen.est.id).toBe(3);
  });
  it('gamle priser markeres, og linjer uden pris tælles', () => {
    const old = lineEstimate(line, [est({ checked_at: opts.now - 10 * 86400 })], opts);
    expect(old.chosen.stale).toBe(true);
    const none = lineEstimate(line, [], opts);
    const s = summarize([{ name: 'A', est: old }, { name: 'B', est: none }], 'ekskl');
    expect(s).toMatchObject({ priced: 1, total: 16000, stale: 1 });
    expect(s.missing).toEqual([{ name: 'B', reason: 'Ingen offentlig pris fundet.' }]);
  });
});

describe('prisfil', () => {
  it('læser en prisfil og springer priser bag login over', () => {
    const csv = [
      'varenr;ean;navn;link;salgsenhed;indhold;indholdsenhed;pris;moms;kraever_login',
      `1001;${ean13('200000000002')};Vinkelbeslag 90 mm (10 stk.);https://www.eksempel.dk/p/1001;pk.;10;stk.;100,00;inkl;nej`,
      '1002;;Erhvervspris;https://www.eksempel.dk/p/1002;stk.;;;50;ekskl;ja',
      '1003;;Forkert link;https://andet.dk/p;stk.;;;50;ekskl;',
      '1004;1234567890123;Ugyldig EAN;https://www.eksempel.dk/p/1004;stk.;;;50;ekskl;',
    ].join('\n');
    const r = parseFeed(csv, 'https://www.eksempel.dk');
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ retailer_sku: '1001', pack_qty: 10 * K, content_unit: 'stk.', price: 10000, vat: 'inkl' });
    expect(r.skipped).toBe(1);
    expect(r.errors).toHaveLength(2);
  });
});
