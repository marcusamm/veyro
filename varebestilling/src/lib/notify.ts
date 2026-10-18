import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { lowStockEmail, sendLater } from './email';

/**
 * Giver besked, når en ordre får en vare til at krydse lavlager-grænsen
 * (kun i det øjeblik grænsen krydses, så der ikke kommer en mail ved hver ordre).
 */
export async function notifyLowStock(c: Context<AppEnv>, orderId: number): Promise<void> {
  const s = c.get('settings');
  if (!(s.notify_email || s.contact_email)) return;
  const { results } = await c.env.DB.prepare(
    `SELECT p.sku, p.name, p.stock, SUM(l.quantity) AS qty, COALESCE(p.low_stock_threshold, p.auto_reorder_point, ?2) AS lim
     FROM order_lines l JOIN products p ON p.id = l.product_id
     WHERE l.order_id = ?1 AND p.track_stock = 1 GROUP BY p.id`,
  )
    .bind(orderId, s.low_stock_default)
    .all<{ sku: string; name: string; stock: number; qty: number; lim: number }>();
  const crossed = results.filter((r) => r.stock <= r.lim && r.stock + r.qty > r.lim);
  if (crossed.length) {
    sendLater(c.env, c.executionCtx, lowStockEmail(crossed, s, `${c.env.APP_URL.replace(/\/+$/, '')}/admin/varer?lav=1`), s);
  }
}
