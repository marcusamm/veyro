/** Marketing/enquiry tiers only. Never used to change a customer's subscription or payment. */
export const WEBSHOP_TIERS = [
  { id: '60', capacity: 60, price_dkk: 299, import_capacity: 60 },
  { id: '120', capacity: 120, price_dkk: 399, import_capacity: 120 },
  { id: '200', capacity: 200, price_dkk: 499, import_capacity: 200 },
] as const;

export type WebshopTier = (typeof WEBSHOP_TIERS)[number];

export function webshopTier(id: unknown): WebshopTier | undefined {
  return WEBSHOP_TIERS.find(tier => tier.id === id);
}

/** Preserve links from the previous selector; these IDs are never product-count limits. */
export function normalizeWebshopTierId(id: unknown): WebshopTier['id'] | undefined {
  return webshopTier(id)?.id ?? (id === '15' ? '60' : id === '30' ? '120' : id === '50' ? '200' : undefined);
}

/**
 * Total concrete sellable items/variants across the shop. A parent with four
 * sellable variants counts as four, not five. Categories, parent groups and
 * stock quantities are not added. Setup assistance does not limit capacity.
 * undefined means an individual quote, never an extrapolated price.
 */
export function webshopTierForCapacity(sellableCount: number): WebshopTier | undefined {
  if (!Number.isSafeInteger(sellableCount) || sellableCount < 0) return undefined;
  return WEBSHOP_TIERS.find(tier => sellableCount <= tier.capacity);
}
