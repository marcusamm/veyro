import { describe, expect, it } from 'vitest';
import { convertDkk, convertPriceText, displayPrice, DISPLAY_EXCHANGE_RATE } from '../src/site/currency';
import { webshopTier } from '../src/site/webshop-tiers';

const spaces = (text) => text.replace(/[\u00a0\u202f]/g, ' ');

describe('Public price conversions from DKK', () => {
  it('uses the dated ECB rates with DKK as the sole source currency', () => {
    expect(DISPLAY_EXCHANGE_RATE.date).toBe('2026-10-30');
    expect(convertDkk(747.35, 'en')).toBeCloseTo(100, 8);
    expect(convertDkk(747.35, 'sv')).toBeCloseTo(1097.8, 8);
    expect(convertDkk(199, 'da')).toBe(199);
    expect(displayPrice(199, 'en')).toBe('≈ EUR 26.63');
    expect(spaces(displayPrice(199, 'sv'))).toBe('≈ 292,32 SEK');
    expect(displayPrice(299, 'en')).toBe('≈ EUR 40.01');
    expect(displayPrice(499, 'en')).toBe('≈ EUR 66.77');
    expect(spaces(displayPrice(1099, 'sv'))).toBe('≈ 1 614,35 SEK');
  });

  it('converts translated prices in prose without changing quantities, links or VAT', () => {
    const en = '<p>DKK 1,099/month, 3 users and DKK 99 per extra user. VAT 25%. <a href="/pages/priser#pakke-hjemmeside">Details</a></p>';
    expect(convertPriceText(en, 'en')).toBe('<p>≈ EUR 147.05/month, 3 users and ≈ EUR 13.25 per extra user. VAT 25%. <a href="/pages/priser#pakke-hjemmeside">Details</a></p>');
    const sv = '1 099 DKK/mån. · 3 användare · 99 DKK extra';
    expect(spaces(convertPriceText(sv, 'sv'))).toBe('≈ 1 614,35 SEK/mån. · 3 användare · ≈ 145,42 SEK extra');
  });

  it('is idempotent across recursive content and settings rendering', () => {
    for (const lang of ['en', 'sv']) {
      const once = convertPriceText('DKK 299/month and 99 DKK extra', lang);
      expect(convertPriceText(once, lang)).toBe(once);
      expect(convertPriceText('EUR 100 · 100 SEK · DKK reference currency', lang)).toBe('EUR 100 · 100 SEK · DKK reference currency');
    }
  });

  it('keeps Danish prices unchanged and converts a newly edited Danish CMS price safely', () => {
    expect(convertPriceText('199 kr./md. og 1.099,50 kr.', 'da')).toBe('199 kr./md. og 1.099,50 kr.');
    expect(displayPrice(199, 'da')).toBe('199 kr.');
    expect(convertPriceText('249 kr./md.', 'en')).toBe('≈ EUR 33.32/md.');
    expect(spaces(convertPriceText('1.099,50 kr.', 'sv'))).toBe(spaces(displayPrice(1099.5, 'sv')));
  });

  it('preserves cents and rounds only after converting the complete amount', () => {
    expect(convertPriceText('DKK 1,099.50', 'en')).toBe(displayPrice(1099.5, 'en'));
    expect(convertPriceText('1 099,50 DKK', 'sv')).toBe(displayPrice(1099.5, 'sv'));
    expect(displayPrice(299 + 2 * 99, 'en')).toBe('≈ EUR 66.50');
    expect(spaces(displayPrice(299 + 2 * 99, 'sv'))).toBe('≈ 730,05 SEK');
  });

  // Fixed reference values: convert the complete DKK total before rounding, rather
  // than adding independently rounded foreign-currency base and extra-user prices.
  it.each([
    ['15', 3, 299, '40.01', '439,21'],
    ['15', 4, 398, '53.25', '584,63'],
    ['15', 5, 497, '66.50', '730,05'],
    ['15', 6, 596, '79.75', '875,48'],
    ['30', 3, 399, '53.39', '586,10'],
    ['30', 4, 498, '66.64', '731,52'],
    ['30', 5, 597, '79.88', '876,95'],
    ['30', 6, 696, '93.13', '1 022,37'],
    ['50', 3, 499, '66.77', '732,99'],
    ['50', 4, 598, '80.02', '878,42'],
    ['50', 5, 697, '93.26', '1 023,84'],
    ['50', 6, 796, '106.51', '1 169,26'],
  ])('converts Webshop %s with %i users from the full DKK total', (id, users, dkk, eur, sek) => {
    const total = webshopTier(id).price_dkk + (users - 3) * 99;
    expect(total).toBe(dkk);
    expect(displayPrice(total, 'da')).toBe(`${dkk} kr.`);
    expect(displayPrice(total, 'en')).toBe(`≈ EUR ${eur}`);
    expect(spaces(displayPrice(total, 'sv'))).toBe(`≈ ${sek} SEK`);
    expect(convertPriceText(`DKK ${dkk}/month`, 'en')).toBe(`≈ EUR ${eur}/month`);
    expect(spaces(convertPriceText(`${dkk} DKK/mån.`, 'sv'))).toBe(`≈ ${sek} SEK/mån.`);
  });
});
