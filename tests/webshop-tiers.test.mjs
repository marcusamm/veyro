import { describe, expect, it } from 'vitest';
import { WEBSHOP_TIERS, webshopTier, webshopTierForCapacity } from '../src/site/webshop-tiers';

describe('Public webshop tiers', () => {
  it('keeps the three DKK prices paired with their product, variant and import limits', () => {
    expect(WEBSHOP_TIERS.map(({ id, price_dkk, products, variants, import_products }) =>
      [id, price_dkk, products, variants, import_products],
    )).toEqual([
      ['15', 299, 15, 60, 15],
      ['30', 399, 30, 120, 30],
      ['50', 499, 50, 200, 50],
    ]);
    for (const tier of WEBSHOP_TIERS) expect(webshopTier(tier.id)).toBe(tier);
  });

  it.each([
    [0, 0, '15'],
    [15, 60, '15'],
    [16, 60, '30'],
    [15, 61, '30'],
    [12, 80, '30'],
    [30, 120, '30'],
    [31, 120, '50'],
    [30, 121, '50'],
    [50, 200, '50'],
  ])('fits both whole-store limits for %i products and %i variants', (products, variants, id) => {
    expect(webshopTierForCapacity(products, variants)?.id).toBe(id);
  });

  it.each([
    [51, 60], [15, 201], [51, 201], [500, 2_000],
  ])('requires an individual quote beyond the standard limits (%i / %i)', (products, variants) => {
    expect(webshopTierForCapacity(products, variants)).toBeUndefined();
  });

  it('does not invent a price for malformed capacities or unrecognised tier IDs', () => {
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '15', null, undefined]) {
      expect(webshopTierForCapacity(value, 60)).toBeUndefined();
      expect(webshopTierForCapacity(15, value)).toBeUndefined();
    }
    for (const id of ['custom', '100', '015', '15 ', '299', 15, null, undefined, {}]) {
      expect(webshopTier(id)).toBeUndefined();
    }
  });
});
