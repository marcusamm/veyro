import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { CartLine } from './orders';

// Kurven gemmes i en cookie som "id:antal,id:antal". Priser og lager slås altid op på serveren,
// så indholdet ikke behøver at være hemmeligt eller signeret.
const MAX_LINES = 60;
export const MAX_QTY = 9999;

function name(c: Context): string {
  return new URL(c.req.url).protocol === 'https:' ? '__Host-vb_cart' : 'vb_cart';
}

export function readCart(c: Context): CartLine[] {
  const raw = getCookie(c, name(c)) ?? '';
  const out: CartLine[] = [];
  const seen = new Set<number>();
  for (const part of raw.split(',')) {
    const m = /^(\d{1,9}):(\d{1,4})$/.exec(part);
    if (!m) continue;
    const productId = Number(m[1]);
    const quantity = Number(m[2]);
    if (quantity < 1 || seen.has(productId)) continue;
    seen.add(productId);
    out.push({ productId, quantity });
    if (out.length >= MAX_LINES) break;
  }
  return out;
}

export function writeCart(c: Context, lines: CartLine[]): void {
  const clean = lines.filter((l) => l.quantity > 0).slice(0, MAX_LINES);
  if (!clean.length) {
    deleteCookie(c, name(c), { path: '/', secure: new URL(c.req.url).protocol === 'https:' });
    return;
  }
  setCookie(c, name(c), clean.map((l) => `${l.productId}:${Math.min(l.quantity, MAX_QTY)}`).join(','), {
    path: '/',
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    maxAge: 14 * 86400,
  });
}

export function cartCount(lines: CartLine[]): number {
  return lines.reduce((s, l) => s + l.quantity, 0);
}
