// Sikkerhedslager og genbestillingspunkt ud fra butikkens egen salgshistorik.
//
// For hver vare med lagerstyring tælles det bestilte antal pr. dag (alle ordrer, der ikke er
// annulleret, uanset kilde) over de seneste `forecast_days` dage. Ud fra det beregnes:
//   gennemsnit pr. dag (d) og standardafvigelse pr. dag (σ)
//   sikkerhedslager       = z × σ × √leveringstid
//   genbestillingspunkt   = d × leveringstid + sikkerhedslager
// hvor z svarer til den ønskede sikkerhed mod udsolgt (fx 95 % → 1,65). Når det disponible lager
// når genbestillingspunktet, skal der bestilles hjem, så varerne når frem, før lageret er tomt.

import type { ProductRow } from '../env';
import { nowSec } from './crypto';
import { reorderEmail, sendLater, type ReorderItem } from './email';
import { stockOverview } from './products';
import type { Settings } from './settings';

const DAY = 86400;
/** Mindst så mange dages historik, før der beregnes noget (ellers bruges standardgrænsen) */
export const MIN_HISTORY_DAYS = 14;
/** Tallene genberegnes højst så ofte, når siderne vises (cron beregner også én gang i døgnet) */
const REFRESH_AFTER = 6 * 3600;

const Z: Record<number, number> = { 90: 1.28, 95: 1.65, 98: 2.05, 99: 2.33 };
export const SERVICE_LEVELS = [90, 95, 98, 99];

export function zFor(serviceLevel: number): number {
  return Z[serviceLevel] ?? 1.65;
}

export interface DemandStats {
  avg: number;
  sd: number;
  days: number;
}

/** Gennemsnit og standardafvigelse pr. dag, hvor dage uden salg tæller med som 0. */
export function demandStats(daily: Map<number, number>, days: number): DemandStats {
  if (days <= 0) return { avg: 0, sd: 0, days: 0 };
  let sum = 0;
  for (const q of daily.values()) sum += q;
  const avg = sum / days;
  let sq = 0;
  for (let d = 0; d < days; d++) {
    const q = daily.get(d) ?? 0;
    sq += (q - avg) ** 2;
  }
  const sd = days > 1 ? Math.sqrt(sq / (days - 1)) : 0;
  return { avg, sd, days };
}

export function safetyStock(stats: DemandStats, leadDays: number, serviceLevel: number): number {
  return Math.ceil(zFor(serviceLevel) * stats.sd * Math.sqrt(Math.max(leadDays, 0)));
}

export function reorderPoint(stats: DemandStats, leadDays: number, safety: number): number {
  return Math.ceil(stats.avg * Math.max(leadDays, 0) + safety);
}

/**
 * Genberegner tallene for alle varer med lagerstyring. Varer med for lidt historik eller uden salg
 * får ingen beregnede tal, så de falder tilbage på et fast minimum eller butikkens standard.
 */
export async function recomputeForecast(db: D1Database, s: Settings, now = nowSec()): Promise<number> {
  const window = Math.max(MIN_HISTORY_DAYS, Math.min(365, s.forecast_days || 90));
  const start = now - window * DAY;
  const [{ results: products }, { results: sales }] = await Promise.all([
    db.prepare('SELECT id, created_at, lead_time_days FROM products WHERE track_stock = 1').all<Pick<ProductRow, 'id' | 'created_at' | 'lead_time_days'>>(),
    db
      .prepare(
        // d = antal hele døgn siden ordren (0 = det seneste døgn)
        `SELECT l.product_id AS id, CAST((?2 - o.created_at) / 86400 AS INTEGER) AS d, SUM(l.quantity) AS q
         FROM order_lines l JOIN orders o ON o.id = l.order_id
         WHERE o.status <> 'annulleret' AND o.created_at > ?1 AND o.created_at <= ?2 AND l.product_id IS NOT NULL
         GROUP BY l.product_id, d`,
      )
      .bind(start, now)
      .all<{ id: number; d: number; q: number }>(),
  ]);
  const byProduct = new Map<number, Map<number, number>>();
  for (const r of sales) {
    if (!byProduct.has(r.id)) byProduct.set(r.id, new Map());
    byProduct.get(r.id)!.set(r.d, r.q);
  }
  const stmts: D1PreparedStatement[] = [];
  for (const p of products) {
    // Nye varer: kun dagene siden varen blev oprettet tæller med
    const days = Math.min(window, Math.floor((now - p.created_at) / DAY));
    const daily = new Map<number, number>();
    for (const [d, q] of byProduct.get(p.id) ?? []) if (d < days) daily.set(d, q);
    let avg: number | null = null;
    let safety: number | null = null;
    let rop: number | null = null;
    if (days >= MIN_HISTORY_DAYS && daily.size) {
      const stats = demandStats(daily, days);
      const lead = p.lead_time_days ?? s.lead_time_days;
      avg = Math.round(stats.avg * 1000) / 1000;
      safety = safetyStock(stats, lead, s.service_level);
      rop = reorderPoint(stats, lead, safety);
    }
    stmts.push(
      db
        .prepare('UPDATE products SET avg_daily_demand = ?, auto_safety_stock = ?, auto_reorder_point = ?, forecast_at = ? WHERE id = ?')
        .bind(avg, safety, rop, now, p.id),
    );
  }
  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
  return stmts.length;
}

/** Genberegner, hvis tallene er ældre end et par timer (billigt at kalde ved hver sidevisning). */
export async function ensureFreshForecast(db: D1Database, s: Settings): Promise<void> {
  const row = await db
    .prepare('SELECT MIN(COALESCE(forecast_at, 0)) AS oldest FROM products WHERE track_stock = 1')
    .first<{ oldest: number | null }>();
  if (row?.oldest !== null && row?.oldest !== undefined && nowSec() - row.oldest < REFRESH_AFTER) return;
  await recomputeForecast(db, s);
}

export interface ReorderInfo {
  /** Det, der kan sælges nu (lager minus reserveret) */
  available: number;
  limit: number;
  /** Om grænsen er beregnet ud fra salget (ellers fast minimum eller standard) */
  automatic: boolean;
  avgDaily: number | null;
  safety: number | null;
  leadDays: number;
  /** Dage til genbestillingspunktet nås (0 = nu), null hvis der ikke sælges noget */
  daysToReorder: number | null;
  /** Dage til lageret er tomt ved det nuværende salg */
  daysToEmpty: number | null;
  /** Foreslået antal at bestille hjem: dækker leveringstiden og 30 dages salg oven i sikkerhedslageret */
  suggestQty: number;
  /** 'now' = skal bestilles nu, 'soon' = inden for varslingsperioden, 'ok' = god tid */
  urgency: 'now' | 'soon' | 'ok';
}

export function reorderInfo(
  p: Pick<ProductRow, 'stock' | 'low_stock_threshold' | 'auto_reorder_point' | 'auto_safety_stock' | 'avg_daily_demand' | 'lead_time_days'> & { reserved: number },
  s: Settings,
): ReorderInfo {
  const available = Math.max(0, p.stock - p.reserved);
  const automatic = p.low_stock_threshold === null && p.auto_reorder_point !== null;
  const limit = p.low_stock_threshold ?? p.auto_reorder_point ?? s.low_stock_default;
  const avg = p.avg_daily_demand && p.avg_daily_demand > 0 ? p.avg_daily_demand : null;
  const leadDays = p.lead_time_days ?? s.lead_time_days;
  const daysToReorder = avg ? Math.max(0, Math.floor((available - limit) / avg)) : null;
  const daysToEmpty = avg ? Math.floor(available / avg) : null;
  const target = avg ? Math.ceil(avg * (leadDays + 30)) + (p.auto_safety_stock ?? 0) : limit * 2;
  const suggestQty = Math.max(0, target - available);
  const urgency: ReorderInfo['urgency'] =
    available <= limit ? 'now' : daysToReorder !== null && daysToReorder <= s.reorder_warn_days ? 'soon' : 'ok';
  return { available, limit, automatic, avgDaily: avg, safety: p.auto_safety_stock, leadDays, daysToReorder, daysToEmpty, suggestQty, urgency };
}

/**
 * Daglig varsling: genberegner tallene og sender én samlet e-mail med de varer, der er kommet inden
 * for varslingsperioden siden sidst. En vare varsles kun én gang, indtil lageret igen er i god tid.
 */
export async function runReorderAlerts(
  env: { DB: D1Database; APP_URL: string } & Parameters<typeof sendLater>[0],
  ctx: { waitUntil(p: Promise<unknown>): void },
  s: Settings,
): Promise<ReorderItem[]> {
  await recomputeForecast(env.DB, s);
  const products = await stockOverview(env.DB, s, 1000);
  const now = nowSec();
  const fresh: ReorderItem[] = [];
  const stmts: D1PreparedStatement[] = [];
  for (const p of products) {
    const r = reorderInfo(p, s);
    if (r.urgency !== 'ok' && !p.reorder_alerted) {
      fresh.push({
        sku: p.sku,
        name: p.name,
        available: r.available,
        limit: r.limit,
        orderBy: r.urgency === 'now' || r.daysToReorder === null ? null : now + r.daysToReorder * DAY,
        suggestQty: r.suggestQty,
      });
      stmts.push(env.DB.prepare('UPDATE products SET reorder_alerted = 1 WHERE id = ?').bind(p.id));
    } else if (r.urgency === 'ok' && p.reorder_alerted) {
      stmts.push(env.DB.prepare('UPDATE products SET reorder_alerted = 0 WHERE id = ?').bind(p.id));
    }
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  if (fresh.length && (s.notify_email || s.contact_email)) {
    sendLater(env, ctx, reorderEmail(fresh, s, `${env.APP_URL.replace(/\/+$/, '')}/admin/genbestilling`), s);
  }
  return fresh;
}
