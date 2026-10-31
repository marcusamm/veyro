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

/** Convert a DKK amount once, retaining precision until display rounding. */
export function convertDkk(amount: number, language: PriceLanguage): number {
  if (language === 'da') return amount;
  const eur = amount / DISPLAY_EXCHANGE_RATE.dkkPerEur;
  return language === 'sv' ? eur * DISPLAY_EXCHANGE_RATE.sekPerEur : eur;
}

/** Input is whole DKK, never øre. Foreign prices are always approximate and use two decimals. */
export function displayPrice(dkk: number, language: PriceLanguage): string {
  const amount = Number.isFinite(Number(dkk)) ? Number(dkk) : 0;
  if (language === 'da') return `${new Intl.NumberFormat('da-DK', { maximumFractionDigits: 2 }).format(amount)} kr.`;
  const number = new Intl.NumberFormat(language === 'sv' ? 'sv-SE' : 'en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(convertDkk(amount, language));
  return language === 'sv' ? `≈ ${number} SEK` : `≈ EUR ${number}`;
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
