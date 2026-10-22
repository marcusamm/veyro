// Startkatalog til kundens varebestilling: indlæses som CSV i opsætningen og lægges i kundens database ved første
// udrulning. Bruger varebestillingens egen import (samme kolonner, regler og fejlbeskeder).
// Senere ændringer laves i bestillingssystemets egen import (Admin › Varer › Importér), som kender de rigtige lagertal.
import { parseImport, planImport, type ImportError, type ImportRow, type PlannedRow } from '../../varebestilling/src/lib/csv';
import type { ProductRow } from '../../varebestilling/src/env';

export const MAX_START_ROWS = 1000;

export const SAMPLE_CSV =
  '﻿Varenummer;Navn;Kategori;Pris;Lager;Enhed;Beskrivelse;Minimum;Aktiv;Lagerstyring\r\n' +
  'EKS-100;Eksempelvare (slet denne linje);Kategori;149,95;24;stk.;Kort beskrivelse;5;ja;ja\r\n' +
  'EKS-200;Ydelse uden lager (slet denne linje);Ydelser;500,00;;time;Bruges til ydelser;;ja;nej\r\n';

export interface CatalogPlan {
  planned: PlannedRow[];
  errors: ImportError[];
  /** Varer i det nuværende startkatalog, som ikke er i filen (fjernes, hvis man erstatter) */
  removed: string[];
  unknownColumns: string[];
}

function asProduct(r: ImportRow): ProductRow {
  return {
    id: 0,
    sku: r.sku,
    name: r.name ?? '',
    category: r.category ?? '',
    description: r.description ?? '',
    unit: r.unit ?? 'stk.',
    price: r.price ?? 0,
    image_url: r.image_url ?? '',
    track_stock: r.track_stock === false ? 0 : 1,
    stock: r.stock ?? 0,
    low_stock_threshold: r.low_stock_threshold ?? null,
    active: r.active === false ? 0 : 1,
    sort_order: r.sort_order ?? 0,
  } as unknown as ProductRow;
}

/** Læser filen og sammenholder den med det nuværende startkatalog. Ændrer intet. */
export function planCatalog(csv: string, current: ImportRow[]): CatalogPlan {
  const parsed = parseImport(csv);
  if (parsed.rows.length > MAX_START_ROWS) {
    return { planned: [], errors: [{ line: 1, message: `Startkataloget kan højst have ${MAX_START_ROWS} varer. Importér resten i bestillingssystemet bagefter.` }], removed: [], unknownColumns: parsed.unknownColumns };
  }
  const existing = new Map(current.map((r) => [r.sku.toLowerCase(), asProduct(r)]));
  const { planned, errors } = planImport(parsed, existing);
  const inFile = new Set(parsed.rows.map((r) => r.sku.toLowerCase()));
  const removed = current.filter((r) => !inFile.has(r.sku.toLowerCase())).map((r) => r.sku);
  return { planned, errors, removed, unknownColumns: parsed.unknownColumns };
}

/** Rækkerne, der gemmes (uden "existing"), med standardværdier for felter, filen ikke havde */
export function catalogRows(plan: CatalogPlan, current: ImportRow[]): ImportRow[] {
  const old = new Map(current.map((r) => [r.sku.toLowerCase(), r]));
  return plan.planned.map(({ action: _a, existing: _e, ...r }) => ({ ...old.get(r.sku.toLowerCase()), ...Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)) }) as ImportRow);
}
