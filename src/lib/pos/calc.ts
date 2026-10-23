// Beregning af kassesalg: rabatter, moms, afrunding og byttepenge. Alt i øre (heltal).
// Kassens browserkode (views/kasse-assets.ts) regner på samme måde, men serveren bestemmer:
// priserne slås op i databasen, og browserens totaler bruges kun til at opdage ændrede priser.

export type DiscountType = 'pct' | 'amount';

export interface Discount {
  type: DiscountType;
  /** Basispoint ved pct (1000 = 10 %), øre ved amount */
  value: number;
}

export interface CalcLineInput {
  unit_price: number;
  quantity: number;
  discount?: Discount | null;
}

export interface CalcLine {
  gross: number;
  line_discount: number;
  order_discount: number;
  net: number;
}

export interface CalcResult {
  lines: CalcLine[];
  /** Varer før rabat */
  subtotal: number;
  /** Linjerabatter + rabat på ordren */
  discount: number;
  order_discount: number;
  total: number;
  vat: number;
  /** Samlet rabat i procent af varernes pris (basispoint), til godkendelsesgrænser */
  discount_bp: number;
}

export function discountAmount(base: number, d: Discount | null | undefined): number {
  if (!d || base <= 0) return 0;
  if (d.type === 'pct') return Math.min(base, Math.round((base * Math.min(10000, Math.max(0, d.value))) / 10000));
  return Math.min(base, Math.max(0, d.value));
}

/**
 * Fordeler et beløb på linjerne i forhold til deres beløb (største rest), så summen altid passer.
 */
export function allocate(amount: number, weights: number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  if (amount <= 0 || total <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (amount * w) / total);
  const out = raw.map(Math.floor);
  let rest = amount - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; rest > 0 && k < order.length; k++, rest--) out[order[k]![1]]! += 1;
  return out;
}

/** Moms indeholdt i et beløb inkl. moms. */
export function vatOf(total: number, vatBp: number): number {
  return vatBp > 0 ? Math.round((total * vatBp) / (10000 + vatBp)) : 0;
}

export function calcSale(lines: CalcLineInput[], orderDiscount: Discount | null | undefined, vatBp: number): CalcResult {
  const base = lines.map((l) => {
    const gross = l.unit_price * l.quantity;
    const line_discount = discountAmount(gross, l.discount);
    return { gross, line_discount, after: gross - line_discount };
  });
  const afterLines = base.reduce((a, l) => a + l.after, 0);
  const od = discountAmount(afterLines, orderDiscount);
  const shares = allocate(od, base.map((l) => l.after));
  const out: CalcLine[] = base.map((l, i) => ({
    gross: l.gross,
    line_discount: l.line_discount,
    order_discount: shares[i]!,
    net: l.after - shares[i]!,
  }));
  const subtotal = base.reduce((a, l) => a + l.gross, 0);
  const total = out.reduce((a, l) => a + l.net, 0);
  const discount = subtotal - total;
  return {
    lines: out,
    subtotal,
    discount,
    order_discount: od,
    total,
    vat: vatOf(total, vatBp),
    discount_bp: subtotal > 0 ? Math.ceil((discount * 10000) / subtotal) : 0,
  };
}

/**
 * Dansk kontantafrunding til nærmeste 50 øre: 1-24 øre ned, 25-74 til 50, 75-99 op.
 */
export function roundCash(amount: number): number {
  return Math.floor((amount + 25) / 50) * 50;
}

/** Hvor meget af en refunderet linje der svarer til `qty` stk., når `already` stk. allerede er refunderet. */
export function refundShare(net: number, quantity: number, already: number, qty: number): number {
  return Math.floor((net * (already + qty)) / quantity) - Math.floor((net * already) / quantity);
}
