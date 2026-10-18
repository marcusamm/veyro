import type { Delivery, OrderEventRow, OrderLineRow, OrderRow, OrderSource, OrderStatus } from '../env';
import { nowSec, randomToken } from './crypto';
import { available, getProductsByIds, isConstraintError } from './products';
import { deliveryFee, type Settings } from './settings';

export const STATUSES: OrderStatus[] = ['ny', 'bekraeftet', 'klar', 'afsluttet', 'annulleret'];

export const STATUS_LABEL: Record<OrderStatus, string> = {
  ny: 'Ny',
  bekraeftet: 'Bekræftet',
  klar: 'Klar / afsendt',
  afsluttet: 'Afsluttet',
  annulleret: 'Annulleret',
};

export const SOURCES: OrderSource[] = ['hjemmeside', 'telefon', 'email', 'direkte'];

export const SOURCE_LABEL: Record<OrderSource, string> = {
  hjemmeside: 'Hjemmeside',
  telefon: 'Telefon',
  email: 'E-mail',
  direkte: 'Direkte salg',
};

export function isSource(s: unknown): s is OrderSource {
  return typeof s === 'string' && (SOURCES as string[]).includes(s);
}

/** Statusser, hvor varerne er solgt, og lageret derfor skal være trukket. */
const DEDUCTED: OrderStatus[] = ['bekraeftet', 'klar', 'afsluttet'];

/** Tilladte statusskift. Afsluttede ordrer er låst; annullerede kan genåbnes som nye. */
export const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  ny: ['bekraeftet', 'klar', 'afsluttet', 'annulleret'],
  bekraeftet: ['klar', 'afsluttet', 'annulleret'],
  klar: ['bekraeftet', 'afsluttet', 'annulleret'],
  afsluttet: [],
  annulleret: ['ny'],
};

export function isStatus(s: unknown): s is OrderStatus {
  return typeof s === 'string' && (STATUSES as string[]).includes(s);
}

export interface CartLine {
  productId: number;
  quantity: number;
}

export interface CheckoutInput {
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  company: string;
  delivery: Delivery;
  address: string;
  postcode: string;
  city: string;
  note: string;
}

export interface PricedLine {
  productId: number;
  sku: string;
  name: string;
  unit: string;
  unit_price: number;
  quantity: number;
  line_total: number;
  /** Hvor mange der kan bestilles (null = ubegrænset) */
  available: number | null;
}

export interface PricedCart {
  lines: PricedLine[];
  subtotal: number;
  /** Varer i kurven, der ikke længere findes eller er skjult */
  removed: number;
  /** Linjer hvor der er bestilt flere end der er på lager */
  short: PricedLine[];
}

/** Prissætter kurven ud fra databasen (aldrig ud fra priser sendt af browseren). */
export async function priceCart(db: D1Database, cart: CartLine[]): Promise<PricedCart> {
  const products = await getProductsByIds(db, cart.map((l) => l.productId));
  const lines: PricedLine[] = [];
  let removed = 0;
  for (const c of cart) {
    const p = products.get(c.productId);
    if (!p || !p.active) {
      removed++;
      continue;
    }
    lines.push({
      productId: p.id,
      sku: p.sku,
      name: p.name,
      unit: p.unit,
      unit_price: p.price,
      quantity: c.quantity,
      line_total: p.price * c.quantity,
      available: available(p),
    });
  }
  return {
    lines,
    subtotal: lines.reduce((s, l) => s + l.line_total, 0),
    removed,
    short: lines.filter((l) => l.available !== null && l.quantity > l.available),
  };
}

/**
 * SQL-udtryk for en ordres id. Enten et tal eller et opslag på ordrens token (som vi selv har
 * genereret, base64url), så ordren kan oprettes og lageret trækkes i én og samme transaktion.
 */
type OrderRef = string;
const refById = (id: number): OrderRef => String(Math.trunc(id));
const refByToken = (token: string): OrderRef => {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) throw new Error('Ugyldigt token');
  return `(SELECT id FROM orders WHERE token = '${token}')`;
};

/** Statements, der flytter lageret for en ordre: -1 = træk (kun hvis ikke allerede trukket), +1 = læg tilbage. */
function stockStatements(db: D1Database, ref: OrderRef, dir: -1 | 1, actor: string, now: number): D1PreparedStatement[] {
  const op = dir === -1 ? '-' : '+';
  const before = dir === -1 ? 0 : 1; // stock_deducted før ændringen
  const reason = dir === -1 ? `'Ordre #' || o.number` : `'Ordre #' || o.number || ' annulleret'`;
  return [
    db
      .prepare(
        `UPDATE products SET
           stock = stock ${op} (SELECT SUM(l.quantity) FROM order_lines l WHERE l.order_id = ${ref} AND l.product_id = products.id),
           updated_at = ?1
         WHERE track_stock = 1
           AND id IN (SELECT product_id FROM order_lines WHERE order_id = ${ref})
           AND (SELECT stock_deducted FROM orders WHERE id = ${ref}) = ${before}`,
      )
      .bind(now),
    db
      .prepare(
        `INSERT INTO stock_movements (product_id, change, stock_after, reason, order_id, actor, created_at)
         SELECT p.id, ${op}SUM(l.quantity), p.stock, ${reason}, o.id, ?1, ?2
         FROM order_lines l JOIN products p ON p.id = l.product_id JOIN orders o ON o.id = l.order_id
         WHERE o.id = ${ref} AND p.track_stock = 1 AND o.stock_deducted = ${before}
         GROUP BY p.id`,
      )
      .bind(actor, now),
    db.prepare(`UPDATE orders SET stock_deducted = ${1 - before} WHERE id = ${ref} AND stock_deducted = ${before}`),
  ];
}

export type CreateResult =
  | { ok: true; order: OrderRow }
  | { ok: false; reason: 'empty' | 'stock' | 'min_order' | 'delivery'; short?: PricedLine[] };

/**
 * Opretter en ordre fra kurven. Prisen beregnes på serveren, og der må ikke bestilles mere,
 * end der er tilgængeligt (lager minus reserveret i andre nye ordrer). Med automatisk bekræftelse
 * trækkes lageret i samme transaktion; mangler der varer, oprettes ordren slet ikke.
 */
export async function createOrder(
  db: D1Database,
  settings: Settings,
  input: CheckoutInput,
  cart: CartLine[],
  /** Ordrer oprettet af en medarbejder: kilde, hvem og om de bekræftes med det samme */
  staff?: { source: Exclude<OrderSource, 'hjemmeside'>; actor: string; confirm: boolean },
): Promise<CreateResult> {
  const priced = await priceCart(db, cart);
  if (!priced.lines.length) return { ok: false, reason: 'empty' };
  if (priced.short.length) return { ok: false, reason: 'stock', short: priced.short };
  // Mindstebeløb og leveringsformer gælder kun for kundernes egne bestillinger
  if (!staff) {
    if (settings.min_order > 0 && priced.subtotal < settings.min_order) return { ok: false, reason: 'min_order' };
    if ((input.delivery === 'levering' && !settings.delivery_enabled) || (input.delivery === 'afhentning' && !settings.pickup_enabled)) {
      return { ok: false, reason: 'delivery' };
    }
  }

  const fee = input.delivery === 'levering' ? deliveryFee(settings, priced.subtotal) : 0;
  const now = nowSec();
  const token = randomToken(24);
  const status: OrderStatus = (staff ? staff.confirm : settings.auto_confirm) ? 'bekraeftet' : 'ny';
  const source: OrderSource = staff?.source ?? 'hjemmeside';

  const ref = refByToken(token);
  const event = (st: OrderStatus, msg: string, actor: string) =>
    db
      .prepare(`INSERT INTO order_events (order_id, status, message, actor, created_at) VALUES (${ref}, ?, ?, ?, ?)`)
      .bind(st, msg, actor, now);

  // Ordre, linjer, historik og evt. lagertræk i én transaktion: fejler noget, oprettes intet
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO orders (number, token, status, customer_name, customer_email, customer_phone, company, delivery, source,
           address, postcode, city, note, subtotal, delivery_fee, total, created_at, updated_at)
         VALUES ((SELECT COALESCE(MAX(number), 1000) + 1 FROM orders), ?, 'ny', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(token, input.customer_name, input.customer_email, input.customer_phone, input.company, input.delivery, source,
        input.delivery === 'levering' ? input.address : '', input.delivery === 'levering' ? input.postcode : '',
        input.delivery === 'levering' ? input.city : '', input.note, priced.subtotal, fee, priced.subtotal + fee, now, now),
    ...priced.lines.map((l) =>
      db
        .prepare(
          `INSERT INTO order_lines (order_id, product_id, sku, name, unit, unit_price, quantity, line_total)
           VALUES (${ref}, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(l.productId, l.sku, l.name, l.unit, l.unit_price, l.quantity, l.line_total),
    ),
    staff
      ? event('ny', `Oprettet af medarbejder (${SOURCE_LABEL[source].toLowerCase()})`, staff.actor)
      : event('ny', 'Bestilling modtaget', 'kunde'),
  ];
  if (status === 'bekraeftet') {
    const actor = staff?.actor ?? 'system';
    stmts.push(
      ...stockStatements(db, ref, -1, actor, now),
      db.prepare(`UPDATE orders SET status = 'bekraeftet' WHERE id = ${ref}`),
      event('bekraeftet', staff ? 'Bekræftet ved oprettelse' : 'Bekræftet automatisk', actor),
    );
  }
  try {
    await db.batch(stmts);
  } catch (err) {
    if (isConstraintError(err)) {
      // Udsolgt i mellemtiden (lageret må ikke blive negativt)
      const again = await priceCart(db, cart);
      return { ok: false, reason: 'stock', short: again.short.length ? again.short : again.lines };
    }
    throw err;
  }
  const order = await db.prepare('SELECT * FROM orders WHERE token = ?').bind(token).first<OrderRow>();
  return { ok: true, order: order! };
}

export type StatusResult =
  | { ok: true; order: OrderRow }
  | { ok: false; reason: 'not_found' | 'transition' | 'conflict' | 'stock'; short?: { sku: string; name: string; need: number; stock: number }[] };

/**
 * Skifter status på en ordre. Når ordren bekræftes første gang, trækkes lageret – præcis én gang.
 * Annulleres en ordre, hvis lager er trukket, lægges varerne tilbage. Alt sker i én transaktion, og
 * mangler der varer på lager, afvises skiftet helt (lageret kan aldrig blive negativt).
 */
export async function setOrderStatus(
  db: D1Database,
  id: number,
  next: OrderStatus,
  actor: string,
  message?: string,
): Promise<StatusResult> {
  const order = await getOrder(db, id);
  if (!order) return { ok: false, reason: 'not_found' };
  if (!TRANSITIONS[order.status].includes(next)) return { ok: false, reason: 'transition' };
  const now = nowSec();

  const stmts: D1PreparedStatement[] = [
    // Vagt: order_id bliver NULL (og hele transaktionen afbrydes), hvis en anden har ændret status imens
    db
      .prepare(
        `INSERT INTO order_events (order_id, status, message, actor, created_at)
         VALUES ((SELECT id FROM orders WHERE id = ? AND status = ?), ?, ?, ?, ?)`,
      )
      .bind(id, order.status, next, message || `Status ændret til ${STATUS_LABEL[next].toLowerCase()}`, actor, now),
  ];
  if (DEDUCTED.includes(next)) stmts.push(...stockStatements(db, refById(id), -1, actor, now));
  if (next === 'annulleret') stmts.push(...stockStatements(db, refById(id), 1, actor, now));
  stmts.push(db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').bind(next, now, id));

  try {
    await db.batch(stmts);
  } catch (err) {
    if (!isConstraintError(err)) throw err;
    const fresh = await getOrder(db, id);
    if (fresh && fresh.status !== order.status) return { ok: false, reason: 'conflict' };
    return { ok: false, reason: 'stock', short: await shortages(db, id) };
  }
  return { ok: true, order: (await getOrder(db, id))! };
}

/** Varer i ordren, der ikke er nok af på lager. */
export async function shortages(db: D1Database, orderId: number) {
  const { results } = await db
    .prepare(
      `SELECT p.sku, p.name, SUM(l.quantity) AS need, p.stock FROM order_lines l JOIN products p ON p.id = l.product_id
       WHERE l.order_id = ? AND p.track_stock = 1 GROUP BY p.id HAVING SUM(l.quantity) > p.stock`,
    )
    .bind(orderId)
    .all<{ sku: string; name: string; need: number; stock: number }>();
  return results;
}

export async function getOrder(db: D1Database, id: number): Promise<OrderRow | null> {
  return db.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first<OrderRow>();
}

export async function getOrderByToken(db: D1Database, token: string): Promise<OrderRow | null> {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return null;
  return db.prepare('SELECT * FROM orders WHERE token = ?').bind(token).first<OrderRow>();
}

export async function getOrderLines(db: D1Database, orderId: number): Promise<OrderLineRow[]> {
  const { results } = await db.prepare('SELECT * FROM order_lines WHERE order_id = ? ORDER BY id').bind(orderId).all<OrderLineRow>();
  return results;
}

export async function getOrderEvents(db: D1Database, orderId: number): Promise<OrderEventRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM order_events WHERE order_id = ? ORDER BY created_at, id')
    .bind(orderId)
    .all<OrderEventRow>();
  return results;
}

export async function addOrderNote(db: D1Database, id: number, note: string, actor: string): Promise<void> {
  const now = nowSec();
  await db.batch([
    db.prepare('UPDATE orders SET internal_note = ?, updated_at = ? WHERE id = ?').bind(note, now, id),
    db
      .prepare('INSERT INTO order_events (order_id, status, message, actor, created_at) VALUES (?, NULL, ?, ?, ?)')
      .bind(id, note ? 'Intern note opdateret' : 'Intern note fjernet', actor, now),
  ]);
}

export interface OrderFilter {
  status?: OrderStatus | null;
  q?: string;
  limit: number;
  offset: number;
}

export interface OrderListRow extends OrderRow {
  item_count: number;
}

export async function listOrders(db: D1Database, f: OrderFilter): Promise<OrderListRow[]> {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.status) {
    where.push('o.status = ?');
    args.push(f.status);
  }
  if (f.q) {
    const n = f.q.replace(/^#/, '');
    if (/^\d+$/.test(n)) {
      where.push('(o.number = ? OR o.customer_phone LIKE ?)');
      args.push(Number(n), `%${n}%`);
    } else {
      const like = '%' + f.q.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
      where.push("(o.customer_name LIKE ? ESCAPE '\\' OR o.customer_email LIKE ? ESCAPE '\\' OR o.company LIKE ? ESCAPE '\\')");
      args.push(like, like, like);
    }
  }
  const { results } = await db
    .prepare(
      `SELECT o.*, (SELECT COALESCE(SUM(quantity), 0) FROM order_lines WHERE order_id = o.id) AS item_count
       FROM orders o ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY o.created_at DESC, o.id DESC LIMIT ? OFFSET ?`,
    )
    .bind(...args, f.limit, f.offset)
    .all<OrderListRow>();
  return results;
}

export async function countByStatus(db: D1Database): Promise<Record<OrderStatus, number>> {
  const { results } = await db.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').all<{ status: OrderStatus; n: number }>();
  const out = { ny: 0, bekraeftet: 0, klar: 0, afsluttet: 0, annulleret: 0 } as Record<OrderStatus, number>;
  for (const r of results) out[r.status] = r.n;
  return out;
}

/** Omsætning (ekskl. annullerede) siden et tidspunkt. */
export async function revenueSince(db: D1Database, since: number): Promise<{ orders: number; total: number }> {
  const r = await db
    .prepare("SELECT COUNT(*) AS orders, COALESCE(SUM(total), 0) AS total FROM orders WHERE status <> 'annulleret' AND created_at >= ?")
    .bind(since)
    .first<{ orders: number; total: number }>();
  return r ?? { orders: 0, total: 0 };
}

export interface StatusEvent {
  created_at: number;
  status: OrderStatus;
  order_id: number;
  number: number;
  source: OrderSource;
  item_count: number;
}

/** Seneste statusskift på ordrer (til oversigtens "Seneste ændringer"). */
export async function recentStatusEvents(db: D1Database, limit: number): Promise<StatusEvent[]> {
  const { results } = await db
    .prepare(
      `SELECT e.created_at, e.status, o.id AS order_id, o.number, o.source,
         (SELECT COALESCE(SUM(quantity), 0) FROM order_lines WHERE order_id = o.id) AS item_count
       FROM order_events e JOIN orders o ON o.id = e.order_id
       WHERE e.status IS NOT NULL ORDER BY e.created_at DESC, e.id DESC LIMIT ?`,
    )
    .bind(limit)
    .all<StatusEvent>();
  return results;
}
