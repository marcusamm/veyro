/** Marketing/enquiry tiers only. Never used to change a customer's subscription or payment. */
export const WEBSHOP_TIERS = [
  { id: '15', products: 15, variants: 60, price_dkk: 299, import_products: 15 },
  { id: '30', products: 30, variants: 120, price_dkk: 399, import_products: 30 },
  { id: '50', products: 50, variants: 200, price_dkk: 499, import_products: 50 },
] as const;

export type WebshopTier = (typeof WEBSHOP_TIERS)[number];

export function webshopTier(id: unknown): WebshopTier | undefined {
  return WEBSHOP_TIERS.find(tier => tier.id === id);
}

/** Both whole-shop limits must fit. undefined means an individual quote, never an extrapolated price. */
export function webshopTierForCapacity(products: number, variants: number): WebshopTier | undefined {
  if (![products, variants].every(n => Number.isSafeInteger(n) && n >= 0)) return undefined;
  return WEBSHOP_TIERS.find(tier => products <= tier.products && variants <= tier.variants);
}
