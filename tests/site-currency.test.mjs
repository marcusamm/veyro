import { describe, expect, it } from 'vitest';
import { convertDkk, convertPriceText, displayPrice, displayConvertedPrice, displayPlanTotal, DISPLAY_EXCHANGE_RATE } from '../src/site/currency';
import { webshopTier } from '../src/site/webshop-tiers';

const spaces = (text) => text.replace(/[\u00a0\u202f]/g, ' ');

describe('Public localized price points', () => {
  it.each([
    [99, '15', '149'],
    [199, '29', '299'],
    [299, '39', '449'],
    [399, '55', '599'],
    [499, '69', '749'],
    [599, '79', '899'],
    [1099, '149', '1 599'],
  ])('advertises deliberate EUR/SEK prices for DKK %i', (dkk, eur, sek) => {
    expect(displayPrice(dkk, 'en')).toBe(`EUR ${eur}`);
    expect(spaces(displayPrice(dkk, 'sv'))).toBe(`${sek} SEK`);
    expect(displayPrice(dkk, 'da')).toBe(`${dkk === 1099 ? '1.099' : dkk} kr.`);
  });

  it('updates translated prose without changing quantities, links or VAT', () => {
    const en = '<p>DKK 1,099/month, 3 users and DKK 99 per extra user. VAT 25%. <a href="/pages/priser#pakke-hjemmeside">Details</a></p>';
    expect(convertPriceText(en, 'en')).toBe('<p>EUR 149/month, 3 users and EUR 15 per extra user. VAT 25%. <a href="/pages/priser#pakke-hjemmeside">Details</a></p>');
    expect(spaces(convertPriceText('1 099 DKK/mån. · 3 användare · 99 DKK extra', 'sv'))).toBe('1 599 SEK/mån. · 3 användare · 149 SEK extra');
  });

  it('is idempotent across recursive content and settings rendering', () => {
    for (const lang of ['en', 'sv']) {
      const once = convertPriceText('DKK 299/month and 99 DKK extra', lang);
      expect(convertPriceText(once, lang)).toBe(once);
      expect(convertPriceText('EUR 100 · 100 SEK · DKK reference currency', lang)).toBe('EUR 100 · 100 SEK · DKK reference currency');
    }
  });

  it('keeps Danish prices unchanged and handles unconfigured CMS prices as FX estimates', () => {
    expect(convertPriceText('199 kr./md. og 1.099,50 kr.', 'da')).toBe('199 kr./md. og 1.099,50 kr.');
    expect(convertPriceText('249 kr./md.', 'en')).toBe('≈ EUR 33.32/md.');
    expect(spaces(convertPriceText('1.099,50 kr.', 'sv'))).toBe(spaces(displayConvertedPrice(1099.5, 'sv')));
  });

  it.each([
    ['60', 3, 299, '39', '449'],
    ['60', 4, 398, '54', '598'],
    ['60', 5, 497, '69', '747'],
    ['60', 6, 596, '84', '896'],
    ['120', 3, 399, '55', '599'],
    ['120', 4, 498, '70', '748'],
    ['120', 5, 597, '85', '897'],
    ['120', 6, 696, '100', '1 046'],
    ['200', 3, 499, '69', '749'],
    ['200', 4, 598, '84', '898'],
    ['200', 5, 697, '99', '1 047'],
    ['200', 6, 796, '114', '1 196'],
  ])('adds advertised prices for Webshop %s with %i users', (id, users, dkk, eur, sek) => {
    const base = webshopTier(id).price_dkk;
    expect(displayPlanTotal(base, users - 3, 99, 'da')).toBe(`${dkk} kr.`);
    expect(displayPlanTotal(base, users - 3, 99, 'en')).toBe(`EUR ${eur}`);
    expect(spaces(displayPlanTotal(base, users - 3, 99, 'sv'))).toBe(`${sek} SEK`);
  });

  it('does not infer package composition from a combined DKK amount', () => {
    expect(displayPlanTotal(299, 2, 99, 'en')).toBe('EUR 69');
    expect(displayPrice(497, 'en')).toBe('≈ EUR 66.50');
    expect(displayPlanTotal(249, 1, 99, 'en')).toBe(displayConvertedPrice(348, 'en'));
    expect(displayPlanTotal(299, 0, 0, 'sv')).toBe('449 SEK');
  });
});

describe('Informational product/cart currency conversion', () => {
  it('keeps dated FX estimates separate from marketing price points', () => {
    expect(DISPLAY_EXCHANGE_RATE.date).toBe('2026-10-30');
    expect(convertDkk(747.35, 'en')).toBeCloseTo(100, 8);
    expect(convertDkk(747.35, 'sv')).toBeCloseTo(1097.8, 8);
    expect(convertDkk(199, 'da')).toBe(199);
    expect(displayConvertedPrice(199, 'en')).toBe('≈ EUR 26.63');
    expect(spaces(displayConvertedPrice(199, 'sv'))).toBe('≈ 292,32 SEK');
    expect(displayConvertedPrice(299, 'en')).toBe('≈ EUR 40.01');
  });

  it('retains cents and converts full cart amounts without plan rounding', () => {
    expect(convertPriceText('DKK 1,099.50', 'en')).toBe(displayConvertedPrice(1099.5, 'en'));
    expect(convertPriceText('1 099,50 DKK', 'sv')).toBe(displayConvertedPrice(1099.5, 'sv'));
    expect(displayConvertedPrice(497, 'en')).toBe('≈ EUR 66.50');
    expect(spaces(displayConvertedPrice(497, 'sv'))).toBe('≈ 730,05 SEK');
    expect(displayConvertedPrice(199.5, 'da')).toBe('199,5 kr.');
  });
});
