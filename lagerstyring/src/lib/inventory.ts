// Lagerbevægelser, som ejer eller indkøber registrerer direkte på en vare:
// varemodtagelse uden indkøbsliste, brugbare returvarer, optælling, svind og returnering til leverandør.

import type { ProductRow } from '../env';
import { formatQty } from './format';
import { Conflict, type Tx } from './ledger';

export type AdjustKind = 'modtagelse' | 'returvare' | 'optaelling' | 'svind' | 'leverandorretur';

export const ADJUST_LABEL: Record<AdjustKind, string> = {
  modtagelse: 'Varemodtagelse',
  returvare: 'Brugbar returvare',
  optaelling: 'Optælling',
  svind: 'Svind',
  leverandorretur: 'Returnering til leverandør',
};

export function isAdjustKind(s: unknown): s is AdjustKind {
  return typeof s === 'string' && s in ADJUST_LABEL;
}

/**
 * @param q For optælling den optalte beholdning, ellers mængden der kommer ind eller går ud.
 */
export function adjustStock(tx: Tx, p: ProductRow, kind: AdjustKind, q: number, reason: string, unitPrice: number | null = null): void {
  if (p.whole_units && q % 1000 !== 0) throw new Conflict(`${p.name} håndteres kun i hele ${p.unit}.`);
  const available = p.stock - p.reserved;
  if (kind === 'modtagelse') {
    if (q <= 0) throw new Conflict('Angiv den modtagne mængde.');
    tx.add(
      tx.db
        .prepare('UPDATE products SET stock = stock + ?, updated_at = ? WHERE id = ?')
        .bind(q, tx.now, p.id),
    );
    tx.move({ product_id: p.id, kind, qty: q, stock_delta: q, unit_cost: unitPrice ?? p.purchase_price, reason });
    return;
  }
  if (kind === 'returvare') {
    // Brugbare varer, der kommer retur uden for et job (fx fra en byggeplads eller en kunde). Indkøbsprisen ændres ikke.
    if (q <= 0) throw new Conflict('Angiv den mængde, der kommer retur.');
    tx.add(tx.db.prepare('UPDATE products SET stock = stock + ?, updated_at = ? WHERE id = ?').bind(q, tx.now, p.id));
    tx.move({ product_id: p.id, kind, qty: q, stock_delta: q, unit_cost: p.purchase_price, reason });
    return;
  }
  if (kind === 'optaelling') {
    if (q < p.reserved) {
      throw new Conflict(
        `Der er reserveret ${formatQty(p.reserved)} ${p.unit} til job. Frigiv reservationer på jobbene, før beholdningen kan sættes lavere end det.`,
      );
    }
    // Er beholdningen ændret, siden siden blev vist, afvises optællingen (CHECK stock >= 0)
    tx.move({ product_id: p.id, kind, qty: q, stock_delta: q - p.stock, stock_after: q, reason: reason || `Optalt ${formatQty(q)} (før ${formatQty(p.stock)})` });
    tx.add(
      tx.db.prepare('UPDATE products SET stock = CASE WHEN stock = ?1 THEN ?2 ELSE -1 END, updated_at = ?3 WHERE id = ?4').bind(p.stock, q, tx.now, p.id),
    );
    return;
  }
  if (q <= 0) throw new Conflict('Angiv mængden.');
  if (q > available) {
    throw new Conflict(`Der er kun ${formatQty(available)} ${p.unit} disponibelt. Reserverede varer skal frigives på jobbet først.`);
  }
  tx.add(tx.db.prepare('UPDATE products SET stock = stock - ?, updated_at = ? WHERE id = ?').bind(q, tx.now, p.id));
  tx.move({ product_id: p.id, kind, qty: q, stock_delta: -q, unit_cost: p.purchase_price, reason });
}
