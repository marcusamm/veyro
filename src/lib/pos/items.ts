// Ydelser og varer i kassen: oprettelse, ændring, billede og lager.
import { nowSec } from '../crypto';

export interface PosItemRow {
  id: number;
  sku: string;
  barcode: string | null;
  name: string;
  category: string;
  description: string;
  price: number;
  unit: string;
  track_stock: number;
  stock: number;
  active: number;
  sort_order: number;
  image_type: string | null;
  created_at: number;
  updated_at: number;
}

/** Kolonner uden billeddata (billedet hentes kun, når det vises) */
const COLS = 'id, sku, barcode, name, category, description, price, unit, track_stock, stock, active, sort_order, image_type, created_at, updated_at';

export function isConstraintError(err: unknown): boolean {
  return /constraint/i.test((err as Error)?.message ?? '');
}

export async function listItems(db: D1Database, opts: { activeOnly?: boolean } = {}): Promise<PosItemRow[]> {
  const { results } = await db
    .prepare(`SELECT ${COLS} FROM pos_items ${opts.activeOnly ? 'WHERE active = 1' : ''} ORDER BY category COLLATE NOCASE, sort_order, name COLLATE NOCASE LIMIT 5000`)
    .all<PosItemRow>();
  return results;
}

export async function getItem(db: D1Database, id: number): Promise<PosItemRow | null> {
  return db.prepare(`SELECT ${COLS} FROM pos_items WHERE id = ?`).bind(id).first<PosItemRow>();
}

export async function getItemsByIds(db: D1Database, ids: number[]): Promise<Map<number, PosItemRow>> {
  if (!ids.length) return new Map();
  const { results } = await db
    .prepare(`SELECT ${COLS} FROM pos_items WHERE id IN (${ids.map(() => '?').join(',')})`)
    .bind(...ids)
    .all<PosItemRow>();
  return new Map(results.map((r) => [r.id, r]));
}

export async function getItemImage(db: D1Database, id: number): Promise<{ type: string; data: ArrayBuffer } | null> {
  const r = await db.prepare('SELECT image_type, image FROM pos_items WHERE id = ? AND image IS NOT NULL').bind(id).first<{ image_type: string; image: number[] | ArrayBuffer }>();
  if (!r?.image || !r.image_type) return null;
  const data = r.image instanceof ArrayBuffer ? r.image : new Uint8Array(r.image).buffer;
  return { type: r.image_type, data };
}

export interface ItemInput {
  sku: string;
  barcode: string;
  name: string;
  category: string;
  description: string;
  price: number;
  unit: string;
  track_stock: boolean;
  active: boolean;
  sort_order: number;
}

export type SaveResult = { ok: true; id: number } | { ok: false; field: string; message: string };

/** Opretter eller ændrer en vare. Lagertallet ændres kun via adjustStock (så det altid logges). */
export async function saveItem(
  db: D1Database,
  id: number | null,
  v: ItemInput,
  opts: { initialStock?: number; image?: { type: string; data: ArrayBuffer } | null; removeImage?: boolean; actor: string },
): Promise<SaveResult> {
  const now = nowSec();
  try {
    if (id === null) {
      const row = await db
        .prepare(
          `INSERT INTO pos_items (sku, barcode, name, category, description, price, unit, track_stock, stock, active, sort_order, image_type, image, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        )
        .bind(v.sku, v.barcode || null, v.name, v.category, v.description, v.price, v.unit, v.track_stock ? 1 : 0, v.track_stock ? (opts.initialStock ?? 0) : 0,
          v.active ? 1 : 0, v.sort_order, opts.image?.type ?? null, opts.image ? opts.image.data : null, now, now)
        .first<{ id: number }>();
      const newId = row!.id;
      // Uden varenummer får varen et kort, fortløbende nummer (V1001, V1002 …)
      if (v.sku.startsWith('tmp-')) await db.prepare('UPDATE pos_items SET sku = ? WHERE id = ?').bind(`V${1000 + newId}`, newId).run();
      if (v.track_stock && opts.initialStock) {
        await db
          .prepare('INSERT INTO pos_stock_movements (item_id, change, stock_after, reason, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(newId, opts.initialStock, opts.initialStock, 'Startlager', opts.actor, now)
          .run();
      }
      return { ok: true, id: newId };
    }
    const sets = ['sku = ?', 'barcode = ?', 'name = ?', 'category = ?', 'description = ?', 'price = ?', 'unit = ?', 'track_stock = ?', 'active = ?', 'sort_order = ?', 'updated_at = ?'];
    const args: unknown[] = [v.sku, v.barcode || null, v.name, v.category, v.description, v.price, v.unit, v.track_stock ? 1 : 0, v.active ? 1 : 0, v.sort_order, now];
    if (opts.image) {
      sets.push('image_type = ?', 'image = ?');
      args.push(opts.image.type, opts.image.data);
    } else if (opts.removeImage) {
      sets.push('image_type = NULL', 'image = NULL');
    }
    await db.prepare(`UPDATE pos_items SET ${sets.join(', ')} WHERE id = ?`).bind(...args, id).run();
    return { ok: true, id };
  } catch (err) {
    if (isConstraintError(err) && /sku/i.test((err as Error).message)) return { ok: false, field: 'sku', message: 'Varenummeret er allerede brugt.' };
    if (isConstraintError(err) && /UNIQUE/i.test((err as Error).message)) return { ok: false, field: 'sku', message: 'Varenummeret er allerede brugt.' };
    throw err;
  }
}

/**
 * Lagerregulering: læg til/træk fra (`add`) eller sæt til et tal (`set`). Lagertal og historik ændres
 * i samme transaktion. Returnerer false, hvis lageret ville blive negativt.
 */
export async function adjustStock(db: D1Database, id: number, mode: 'add' | 'set', value: number, reason: string, actor: string): Promise<boolean> {
  const now = nowSec();
  const change = mode === 'add' ? '?1' : '?1 - stock';
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO pos_stock_movements (item_id, change, stock_after, reason, actor, created_at)
           SELECT id, ${change}, ${mode === 'add' ? 'stock + ?1' : '?1'}, ?2, ?3, ?4 FROM pos_items WHERE id = ?5 AND track_stock = 1`,
        )
        .bind(value, reason, actor, now, id),
      db.prepare(`UPDATE pos_items SET stock = ${mode === 'add' ? 'stock + ?1' : '?1'}, updated_at = ?2 WHERE id = ?3 AND track_stock = 1`).bind(value, now, id),
    ]);
    return true;
  } catch (err) {
    if (isConstraintError(err)) return false;
    throw err;
  }
}

export interface MovementRow {
  id: number;
  change: number;
  stock_after: number;
  reason: string;
  sale_id: number | null;
  sale_number: number | null;
  actor: string;
  created_at: number;
}

export async function listMovements(db: D1Database, itemId: number, limit = 50): Promise<MovementRow[]> {
  const { results } = await db
    .prepare(
      `SELECT m.*, s.number AS sale_number FROM pos_stock_movements m LEFT JOIN pos_sales s ON s.id = m.sale_id
       WHERE m.item_id = ? ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
    )
    .bind(itemId, limit)
    .all<MovementRow>();
  return results;
}

export async function itemCategories(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare("SELECT DISTINCT category FROM pos_items WHERE category <> '' ORDER BY category COLLATE NOCASE").all<{ category: string }>();
  return results.map((r) => r.category);
}
