import type { ProductRow, StockMovementRow } from '../env';
import { nowSec } from './crypto';
import { lowStockLimit, type Settings } from './settings';

/** Antal, der er bestilt i nye (endnu ikke bekræftede) ordrer og derfor reserveret. */
const RESERVED_SQL = `COALESCE((SELECT SUM(l.quantity) FROM order_lines l JOIN orders o ON o.id = l.order_id
  WHERE l.product_id = p.id AND o.status = 'ny' AND o.stock_deducted = 0), 0)`;

export interface ProductWithReserved extends ProductRow {
  reserved: number;
}

/** Hvor mange der kan bestilles nu (lager minus reserveret). Null = ubegrænset. */
export function available(p: ProductWithReserved): number | null {
  if (!p.track_stock) return null;
  return Math.max(0, p.stock - p.reserved);
}

export function isLowStock(p: ProductRow, s: Settings): boolean {
  return p.track_stock === 1 && p.stock <= lowStockLimit(p, s);
}

export interface ProductFilter {
  q?: string;
  category?: string;
  activeOnly?: boolean;
  lowStock?: Settings;
  limit?: number;
}

export async function listProducts(db: D1Database, f: ProductFilter = {}): Promise<ProductWithReserved[]> {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.activeOnly) where.push('p.active = 1');
  if (f.category) {
    where.push('p.category = ?');
    args.push(f.category);
  }
  if (f.q) {
    where.push("(p.name LIKE ? ESCAPE '\\' OR p.sku LIKE ? ESCAPE '\\' OR p.category LIKE ? ESCAPE '\\')");
    const like = '%' + f.q.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
    args.push(like, like, like);
  }
  if (f.lowStock) {
    where.push('p.track_stock = 1 AND p.stock <= COALESCE(p.low_stock_threshold, ?)');
    args.push(f.lowStock.low_stock_default);
  }
  const sql = `SELECT p.*, ${RESERVED_SQL} AS reserved FROM products p
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${f.lowStock ? 'p.stock ASC,' : ''} p.category COLLATE NOCASE, p.sort_order, p.name COLLATE NOCASE
    LIMIT ${Math.min(f.limit ?? 5000, 5000)}`;
  const { results } = await db.prepare(sql).bind(...args).all<ProductWithReserved>();
  return results;
}

export async function getProduct(db: D1Database, id: number): Promise<ProductWithReserved | null> {
  return db.prepare(`SELECT p.*, ${RESERVED_SQL} AS reserved FROM products p WHERE p.id = ?`).bind(id).first<ProductWithReserved>();
}

export async function getProductsByIds(db: D1Database, ids: number[]): Promise<Map<number, ProductWithReserved>> {
  const out = new Map<number, ProductWithReserved>();
  // D1 tillader højst 100 parametre pr. forespørgsel
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results } = await db
      .prepare(`SELECT p.*, ${RESERVED_SQL} AS reserved FROM products p WHERE p.id IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk)
      .all<ProductWithReserved>();
    for (const p of results) out.set(p.id, p);
  }
  return out;
}

export async function listCategories(db: D1Database, activeOnly: boolean): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT category FROM products WHERE category <> '' ${activeOnly ? 'AND active = 1' : ''} ORDER BY category COLLATE NOCASE`,
    )
    .all<{ category: string }>();
  return results.map((r) => r.category);
}

export async function countLowStock(db: D1Database, s: Settings): Promise<number> {
  const r = await db
    .prepare('SELECT COUNT(*) AS n FROM products WHERE track_stock = 1 AND stock <= COALESCE(low_stock_threshold, ?)')
    .bind(s.low_stock_default)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

export interface ProductInput {
  sku: string;
  name: string;
  category: string;
  description: string;
  unit: string;
  price: number;
  image_url: string;
  track_stock: boolean;
  low_stock_threshold: number | null;
  active: boolean;
  sort_order: number;
}

export function skuValid(sku: string): boolean {
  return /^[\p{L}\p{N}][\p{L}\p{N}\-_.\/+]{0,63}$/u.test(sku);
}

/** Opretter en vare. Et startlager logges i lagerhistorikken. */
export async function createProduct(db: D1Database, p: ProductInput, stock: number, actor: string): Promise<number> {
  const now = nowSec();
  const [ins] = await db.batch<{ id: number }>([
    db
      .prepare(
        `INSERT INTO products (sku, name, category, description, unit, price, image_url, track_stock, stock,
           low_stock_threshold, active, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .bind(p.sku, p.name, p.category, p.description, p.unit, p.price, p.image_url, p.track_stock ? 1 : 0, stock,
        p.low_stock_threshold, p.active ? 1 : 0, p.sort_order, now, now),
    db
      .prepare(
        `INSERT INTO stock_movements (product_id, change, stock_after, reason, order_id, actor, created_at)
         SELECT id, stock, stock, 'Vare oprettet', NULL, ?, ? FROM products WHERE sku = ? AND track_stock = 1 AND stock <> 0`,
      )
      .bind(actor, now, p.sku),
  ]);
  return ins!.results[0]!.id;
}

export async function updateProduct(db: D1Database, id: number, p: ProductInput): Promise<void> {
  await db
    .prepare(
      `UPDATE products SET sku = ?, name = ?, category = ?, description = ?, unit = ?, price = ?, image_url = ?,
         track_stock = ?, low_stock_threshold = ?, active = ?, sort_order = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(p.sku, p.name, p.category, p.description, p.unit, p.price, p.image_url, p.track_stock ? 1 : 0,
      p.low_stock_threshold, p.active ? 1 : 0, p.sort_order, nowSec(), id)
    .run();
}

export async function deleteProduct(db: D1Database, id: number): Promise<void> {
  await db.prepare('DELETE FROM products WHERE id = ?').bind(id).run();
}

export function isConstraintError(err: unknown): boolean {
  return /constraint/i.test((err as Error)?.message ?? '');
}

/**
 * Manuel lagerregulering: læg til/træk fra (`add`) eller sæt til et bestemt tal (`set`).
 * Historik og lagertal ændres i samme transaktion. Returnerer false, hvis lageret ville blive negativt.
 */
export async function adjustStock(
  db: D1Database,
  id: number,
  args: { mode: 'add' | 'set'; value: number; reason: string; actor: string },
): Promise<boolean> {
  const now = nowSec();
  const newStock = args.mode === 'set' ? '?1' : 'stock + ?1';
  try {
    await db.batch([
      // Historikken skrives før opdateringen, så ændringen beregnes ud fra det aktuelle lagertal
      db
        .prepare(
          `INSERT INTO stock_movements (product_id, change, stock_after, reason, order_id, actor, created_at)
           SELECT id, (${newStock}) - stock, ${newStock}, ?2, NULL, ?3, ?4 FROM products WHERE id = ?5 AND (${newStock}) <> stock`,
        )
        .bind(args.value, args.reason, args.actor, now, id),
      db.prepare(`UPDATE products SET stock = ${newStock}, updated_at = ?2 WHERE id = ?3`).bind(args.value, now, id),
    ]);
    return true;
  } catch (err) {
    if (isConstraintError(err)) return false;
    throw err;
  }
}

export interface MovementWithProduct extends StockMovementRow {
  sku: string;
  name: string;
  order_number: number | null;
}

export async function listMovements(
  db: D1Database,
  opts: { productId?: number; limit?: number; offset?: number } = {},
): Promise<MovementWithProduct[]> {
  const { results } = await db
    .prepare(
      `SELECT m.*, p.sku, p.name, o.number AS order_number FROM stock_movements m
       JOIN products p ON p.id = m.product_id
       LEFT JOIN orders o ON o.id = m.order_id
       ${opts.productId ? 'WHERE m.product_id = ?1' : 'WHERE ?1 IS NULL'}
       ORDER BY m.created_at DESC, m.id DESC LIMIT ?2 OFFSET ?3`,
    )
    .bind(opts.productId ?? null, opts.limit ?? 100, opts.offset ?? 0)
    .all<MovementWithProduct>();
  return results;
}

/** Varer opslået på varenummer (små bogstaver), til import. */
export async function productsBySku(db: D1Database): Promise<Map<string, ProductRow>> {
  const { results } = await db.prepare('SELECT * FROM products').all<ProductRow>();
  return new Map(results.map((p) => [p.sku.toLowerCase(), p]));
}

export interface ImportApplyRow {
  action: 'opret' | 'opdater' | 'uændret';
  sku: string;
  existing?: ProductRow;
  name?: string;
  category?: string;
  price?: number;
  stock?: number;
  unit?: string;
  description?: string;
  image_url?: string;
  low_stock_threshold?: number | null;
  active?: boolean;
  track_stock?: boolean;
  sort_order?: number;
}

const UPDATABLE = ['name', 'category', 'price', 'unit', 'description', 'image_url', 'low_stock_threshold', 'sort_order'] as const;

/**
 * Gennemfører en import: nye varer oprettes, eksisterende opdateres (kun de kolonner, der er med i filen).
 * Ændringer af lagertal logges i lagerhistorikken som "Import". Køres i bidder af 100 varer pr. transaktion.
 */
export async function applyImport(db: D1Database, rows: ImportApplyRow[], actor: string): Promise<{ created: number; updated: number }> {
  const now = nowSec();
  let created = 0;
  let updated = 0;
  const stmts: D1PreparedStatement[][] = [];
  for (const r of rows) {
    if (r.action === 'uændret') continue;
    const s: D1PreparedStatement[] = [];
    if (r.action === 'opret') {
      const track = r.track_stock ?? true;
      s.push(
        db
          .prepare(
            `INSERT INTO products (sku, name, category, description, unit, price, image_url, track_stock, stock,
               low_stock_threshold, active, sort_order, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(r.sku, r.name!, r.category ?? '', r.description ?? '', r.unit ?? 'stk.', r.price!, r.image_url ?? '',
            track ? 1 : 0, r.stock ?? 0, r.low_stock_threshold ?? null, r.active === false ? 0 : 1, r.sort_order ?? 0, now, now),
        db
          .prepare(
            `INSERT INTO stock_movements (product_id, change, stock_after, reason, order_id, actor, created_at)
             SELECT id, stock, stock, 'Import (ny vare)', NULL, ?, ? FROM products WHERE sku = ? AND track_stock = 1 AND stock <> 0`,
          )
          .bind(actor, now, r.sku),
      );
      created++;
    } else {
      const id = r.existing!.id;
      if (r.stock !== undefined) {
        s.push(
          db
            .prepare(
              `INSERT INTO stock_movements (product_id, change, stock_after, reason, order_id, actor, created_at)
               SELECT id, ?1 - stock, ?1, 'Import', NULL, ?2, ?3 FROM products WHERE id = ?4 AND stock <> ?1`,
            )
            .bind(r.stock, actor, now, id),
        );
      }
      const sets: string[] = [];
      const args: (string | number | null)[] = [];
      for (const k of UPDATABLE) {
        if (r[k] !== undefined) {
          sets.push(`${k} = ?`);
          args.push(r[k] as string | number | null);
        }
      }
      if (r.stock !== undefined) {
        sets.push('stock = ?');
        args.push(r.stock);
      }
      if (r.active !== undefined) {
        sets.push('active = ?');
        args.push(r.active ? 1 : 0);
      }
      if (r.track_stock !== undefined) {
        sets.push('track_stock = ?');
        args.push(r.track_stock ? 1 : 0);
      }
      sets.push('updated_at = ?');
      args.push(now);
      s.push(db.prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`).bind(...args, id));
      updated++;
    }
    stmts.push(s);
  }
  for (let i = 0; i < stmts.length; i += 100) {
    await db.batch(stmts.slice(i, i + 100).flat());
  }
  return { created, updated };
}
