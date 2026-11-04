/** Public price estimates only. Stored prices, quotes and payment integrations remain in DKK. */
export type PriceLanguage = 'da' | 'en' | 'sv';

// ECB reference rates, 30 October 2026: DKK and SEK per EUR.
// Rates are pinned deliberately; a language change never triggers a live FX request.
export const DISPLAY_EXCHANGE_RATE = {
  date: '2026-10-30',
  dkkPerEur: 7.4735,
  sekPerEur: 10.9780,
  source: 'https://www.bancaditalia.it/compiti/operazioni-cambi/cambio/cambi_rif_20261030/?com.dotmarketing.htmlpage.language=1',
} as const;

// Deliberate public price points, not exchange rates. Keyed by canonical DKK
// package/add-on prices; stored quotes, products and subscriptions remain in DKK.
export const PUBLIC_PRICE_POINTS: Readonly<Record<number, { en: number; sv: number }>> = {
  99: { en: 15, sv: 149 },
  199: { en: 29, sv: 299 },
  299: { en: 39, sv: 449 },
  399: { en: 55, sv: 599 },
  499: { en: 69, sv: 749 },
  599: { en: 79, sv: 899 },
  1099: { en: 149, sv: 1599 },
};

function finiteAmount(value: number): number {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function formatPrice(amount: number, language: PriceLanguage): string {
  const number = new Intl.NumberFormat(language === 'sv' ? 'sv-SE' : language === 'da' ? 'da-DK' : 'en-GB', {
    maximumFractionDigits: 2,
  }).format(amount);
  return language === 'da' ? `${number} kr.` : language === 'sv' ? `${number} SEK` : `EUR ${number}`;
}

/** Convert a DKK amount once, retaining precision until display rounding. */
export function convertDkk(amount: number, language: PriceLanguage): number {
  if (language === 'da') return amount;
  const eur = amount / DISPLAY_EXCHANGE_RATE.dkkPerEur;
  return language === 'sv' ? eur * DISPLAY_EXCHANGE_RATE.sekPerEur : eur;
}

/** Informational conversion for product/cart amounts. Input is DKK, never øre. */
export function displayConvertedPrice(dkk: number, language: PriceLanguage): string {
  const amount = finiteAmount(dkk);
  if (language === 'da') return formatPrice(amount, language);
  const number = new Intl.NumberFormat(language === 'sv' ? 'sv-SE' : 'en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(convertDkk(amount, language));
  return language === 'sv' ? `≈ ${number} SEK` : `≈ EUR ${number}`;
}

/** Advertised package/add-on prices. Unknown CMS prices retain explicit FX estimates. */
export function displayPrice(dkk: number, language: PriceLanguage): string {
  const amount = finiteAmount(dkk);
  if (language === 'da') return formatPrice(amount, language);
  const price = PUBLIC_PRICE_POINTS[amount]?.[language];
  return price === undefined ? displayConvertedPrice(amount, language) : formatPrice(price, language);
}

/** Sum the chosen price points; converting a combined DKK total would disagree with them. */
export function displayPlanTotal(baseDkk: number, extraCount: number, extraDkk: number, language: PriceLanguage): string {
  const base = finiteAmount(baseDkk);
  const extra = finiteAmount(extraDkk);
  const count = Math.max(0, Math.floor(finiteAmount(extraCount)));
  if (language === 'da') return formatPrice(base + count * extra, language);
  const basePrice = PUBLIC_PRICE_POINTS[base]?.[language];
  const extraPrice = PUBLIC_PRICE_POINTS[extra]?.[language];
  // Only explicitly configured prices are advertised as fixed guide price points.
  if (basePrice === undefined || (count > 0 && extraPrice === undefined)) {
    return displayConvertedPrice(base + count * extra, language);
  }
  return formatPrice(basePrice + count * (extraPrice ?? 0), language);
}

/**
 * Catalogs retain explicit DKK source amounts; only their display text is converted.
 * English catalogs use "DKK 1,099.50" and Swedish catalogs "1 099,50 DKK".
 * The Danish fallback covers a newly edited CMS price not yet present in a catalog.
 * Already converted EUR/SEK text cannot match these patterns, so repeated rendering is safe.
 */
export function convertPriceText(text: string, language: PriceLanguage): string {
  if (language === 'da') return text;
  return text
    .replace(/\bDKK[ \u00a0\u202f]+(-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)(?![\d,.])/g,
      (_, amount: string) => displayPrice(Number(amount.replace(/,/g, '')), language))
    .replace(/(?<![\d,.])(-?(?:\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d+)(?:,\d{1,2})?)[ \u00a0\u202f]+DKK\b/g,
      (_, amount: string) => displayPrice(Number(amount.replace(/[ \u00a0\u202f]/g, '').replace(',', '.')), language))
    .replace(/(?<![\d,.])(-?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?)[ \u00a0\u202f]+kr\.(?![a-z])/g,
      (_, amount: string) => displayPrice(Number(amount.replace(/\./g, '').replace(',', '.')), language));
}
