// Sikkerhedslager, genbestillingspunkt og lagerstatus for en vare.
//
//   disponibel beholdning = fysisk beholdning - reservationer
//   sikkerhedslager       = fast antal, eller gennemsnitligt dagligt forbrug × bufferdage
//   genbestillingspunkt   = gennemsnitligt dagligt forbrug × leveringstid + sikkerhedslager
//
// Forbrug, leveringstid og bufferdage regnes alle i kalenderdage. Sikkerhedslageret indgår i
// genbestillingspunktet og lægges ikke til igen. Mangler et tal, vises "Mangler opsætning"
// i stedet for at regne med nul.

import type { ProductRow } from '../env';
import { Q, roundUpUnits } from './format';

export type StockStatus = 'normal' | 'genbestil' | 'kritisk' | 'ingen' | 'mangler';

/** Advarselsniveau pr. status: højere = værre. Bruges til at undgå gentagne beskeder. */
export const LEVEL: Record<StockStatus, number> = { normal: 0, mangler: 0, genbestil: 1, kritisk: 2, ingen: 3 };

export const STATUS_LABEL: Record<StockStatus, string> = {
  normal: 'Normal',
  genbestil: 'Genbestilling nødvendig',
  kritisk: 'Kritisk',
  ingen: 'Ingen disponible varer',
  mangler: 'Mangler opsætning',
};

export const STATUS_TAG: Record<StockStatus, string> = {
  normal: 'tag-ok',
  genbestil: 'tag-low',
  kritisk: 'tag-crit',
  ingen: 'tag-out',
  mangler: 'tag-off',
};

type PlanInput = Pick<
  ProductRow,
  'stock' | 'reserved' | 'whole_units' | 'avg_daily_usage' | 'lead_time_days' | 'safety_method' | 'safety_qty' | 'buffer_days' | 'max_stock'
> & { supplier_lead_time?: number | null; reorder_point?: number | null };

export interface StockPlan {
  available: number;
  avgDaily: number | null;
  leadDays: number | null;
  /** Leveringstiden kommer fra leverandøren (varen har ingen egen) */
  leadFromSupplier: boolean;
  safety: number | null;
  safetyMethod: 'antal' | 'dage' | null;
  rop: number | null;
  ropSource: 'manuel' | 'beregnet' | null;
  suggestedRop: number | null;
  /** Hvad der mangler for at kunne beregne genbestillingspunktet */
  missing: string[];
  status: StockStatus;
}

export function stockPlan(p: PlanInput): StockPlan {
  const whole = !!p.whole_units;
  const available = p.stock - p.reserved;
  const avgDaily = p.avg_daily_usage;
  const leadDays = p.lead_time_days ?? p.supplier_lead_time ?? null;
  const missing: string[] = [];
  if (avgDaily === null) missing.push('dagligt forbrug');
  if (leadDays === null) missing.push('leveringstid');

  let safety: number | null = null;
  if (p.safety_method === 'antal') {
    if (p.safety_qty === null) missing.push('sikkerhedslager');
    else safety = roundUpUnits(p.safety_qty, whole);
  } else if (p.safety_method === 'dage') {
    if (p.buffer_days === null) missing.push('bufferdage');
    else if (avgDaily !== null) safety = roundUpUnits(avgDaily * p.buffer_days, whole);
  } else {
    missing.push('sikkerhedslager');
  }

  const suggestedRop = avgDaily !== null && leadDays !== null && safety !== null ? roundUpUnits(avgDaily * leadDays + safety, whole) : null;
  // Et manuelt punkt er allerede den samlede grænse: sikkerhedslager lægges ikke til igen.
  const manual = p.reorder_point !== null && p.reorder_point !== undefined;
  const rop = manual ? roundUpUnits(p.reorder_point!, whole) : suggestedRop;
  const ropSource = manual ? 'manuel' : suggestedRop !== null ? 'beregnet' : null;

  let status: StockStatus;
  if (available <= 0) status = 'ingen';
  else if (safety !== null && available <= safety) status = 'kritisk';
  else if (rop === null) status = 'mangler';
  else if (available <= rop) status = 'genbestil';
  else status = 'normal';

  return { available, avgDaily, leadDays, leadFromSupplier: p.lead_time_days === null && leadDays !== null, safety, safetyMethod: p.safety_method, rop, ropSource, suggestedRop, missing, status };
}

/**
 * Forslag til indkøbsmængde. Genbestillingspunktet siger kun hvornår, ikke hvor meget, så
 * indkøberen skal altid godkende mængden. Med en ønsket maksimumbeholdning fyldes der op til den;
 * ellers foreslås et genbestillingspunkt plus én leveringstids forbrug.
 */
export function suggestQty(p: PlanInput, plan: StockPlan, onOrder: number): number {
  const target = p.max_stock ?? (plan.rop !== null ? plan.rop + (plan.avgDaily !== null && plan.leadDays !== null ? plan.avgDaily * plan.leadDays : 0) : null);
  if (target === null) return 0;
  return Math.max(0, roundUpUnits(target - plan.available - onOrder, !!p.whole_units));
}

/** Kort forklaring af, hvordan sikkerhedslageret er fastsat. */
export function safetyText(p: Pick<ProductRow, 'safety_method' | 'buffer_days'>): string {
  if (p.safety_method === 'antal') return 'Fast antal';
  if (p.safety_method === 'dage') return `${p.buffer_days ?? '?'} bufferdage × dagligt forbrug`;
  return 'Ikke valgt';
}

export { Q };
