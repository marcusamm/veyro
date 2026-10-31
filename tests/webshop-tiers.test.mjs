import { describe, expect, it } from 'vitest';
import { WEBSHOP_TIERS, webshopTier, webshopTierForCapacity, normalizeWebshopTierId } from '../src/site/webshop-tiers';

describe('Public webshop tiers', () => {
  it('pairs each DKK price with one total sellable-unit capacity and the same import capacity', () => {
    expect(WEBSHOP_TIERS.map(({ id, price_dkk, capacity, import_capacity }) =>
      [id, price_dkk, capacity, import_capacity],
    )).toEqual([
      ['60', 299, 60, 60],
      ['120', 399, 120, 120],
      ['200', 499, 200, 200],
    ]);
    for (const tier of WEBSHOP_TIERS) expect(webshopTier(tier.id)).toBe(tier);
  });

  it.each([
    [0, '60'],
    [15, '60'],
    [51, '60'],
    [60, '60'],
    [61, '120'],
    [80, '120'],
    [120, '120'],
    [121, '200'],
    [200, '200'],
  ])('chooses the smallest tier for %i total sellable units', (count, id) => {
    expect(webshopTierForCapacity(count)?.id).toBe(id);
  });

  it.each([
    201, 500, 2_000,
  ])('requires an individual quote for %i sellable units without extrapolating a price', (count) => {
    expect(webshopTierForCapacity(count)).toBeUndefined();
  });

  it('does not invent a price for malformed capacities or unrecognised tier IDs', () => {
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '15', null, undefined]) {
      expect(webshopTierForCapacity(value)).toBeUndefined();
    }
    for (const id of ['15', '30', '50', 'custom', '100', '060', '60 ', '299', 60, null, undefined, {}]) {
      expect(webshopTier(id)).toBeUndefined();
    }
  });

  it('normalises old link IDs separately from capacity selection and strict tier lookup', () => {
    for (const [legacy, canonical] of [['15', '60'], ['30', '120'], ['50', '200']]) {
      expect(normalizeWebshopTierId(legacy)).toBe(canonical);
      expect(normalizeWebshopTierId(canonical)).toBe(canonical);
      expect(webshopTier(legacy)).toBeUndefined();
      expect(webshopTier(normalizeWebshopTierId(legacy))).toBe(webshopTier(canonical));
    }
    // Old IDs are link aliases only. A count of 50 still fits the DKK 299 tier.
    expect(webshopTierForCapacity(50)?.price_dkk).toBe(299);
    expect(webshopTier(normalizeWebshopTierId('50'))?.price_dkk).toBe(499);
    for (const id of ['custom', '201', '0', '015', '60 ', 60, null, undefined, {}]) {
      expect(normalizeWebshopTierId(id)).toBeUndefined();
    }
  });
});
