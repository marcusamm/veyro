// Varer med lagerstatus og åbne indkøb (til lageroversigten og varetabellen).

import { PRODUCT_SQL, type ProductWithSupplier } from './materials';
import { stockPlan, suggestQty, type StockPlan } from './stock';

export type ProductOverview = ProductWithSupplier & {
  /** Bestilt hos leverandør og ikke modtaget (alle formål) */
  on_order: number;
  next_date: string | null;
  /** Lageropfyldning på lister, ikke modtaget (kladde, klar og bestilt) */
  refill_pending: number;
  /** Heraf bestilt */
  refill_ordered: number;
  plan: StockPlan;
  suggest: number;
};

const OVERVIEW_SQL = `SELECT p.*, s.name AS supplier_name, s.lead_time_days AS supplier_lead_time,
  COALESCE((SELECT SUM(l.ordered - l.received) FROM purchase_lines l WHERE l.product_id = p.id AND l.cancelled = 0 AND l.ordered > l.received), 0) AS on_order,
  (SELECT MIN(NULLIF(l.expected_date, '')) FROM purchase_lines l WHERE l.product_id = p.id AND l.cancelled = 0 AND l.ordered > l.received) AS next_date,
  COALESCE((SELECT SUM(MAX(l.qty, l.ordered) - l.received) FROM purchase_lines l WHERE l.product_id = p.id AND l.cancelled = 0 AND l.job_id IS NULL), 0) AS refill_pending,
  COALESCE((SELECT SUM(l.ordered - l.received) FROM purchase_lines l WHERE l.product_id = p.id AND l.cancelled = 0 AND l.job_id IS NULL AND l.ordered > l.received), 0) AS refill_ordered
  FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id`;

function withPlan(r: Omit<ProductOverview, 'plan' | 'suggest'>): ProductOverview {
  const plan = stockPlan(r);
  return { ...r, plan, suggest: suggestQty(r, plan, r.refill_pending) };
}

export async function productOverview(db: D1Database, opts: { all?: boolean } = {}): Promise<ProductOverview[]> {
  const { results } = await db
    .prepare(`${OVERVIEW_SQL} ${opts.all ? '' : 'WHERE p.active = 1'} ORDER BY p.name COLLATE NOCASE`)
    .all<Omit<ProductOverview, 'plan' | 'suggest'>>();
  return results.map(withPlan);
}

export async function productOverviewOne(db: D1Database, id: number): Promise<ProductOverview | null> {
  const r = await db.prepare(`${OVERVIEW_SQL} WHERE p.id = ?`).bind(id).first<Omit<ProductOverview, 'plan' | 'suggest'>>();
  return r ? withPlan(r) : null;
}

export async function suppliers(db: D1Database) {
  const { results } = await db.prepare('SELECT * FROM suppliers ORDER BY name COLLATE NOCASE').all<import('../env').SupplierRow>();
  return results;
}

export { PRODUCT_SQL };
