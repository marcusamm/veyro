import { describe, expect, it } from 'vitest';
import { convertDkk, convertPriceText, displayPrice, DISPLAY_EXCHANGE_RATE } from '../src/site/currency';

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
});
