import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from './env';
import { cartCount, readCart } from './lib/cart';
import { countByStatus } from './lib/orders';
import { adminLayout, shopLayout, type AdminNav, type H } from './views/layout';

export function renderShop(
  c: Context<AppEnv>,
  title: string,
  body: H,
  opts: { status?: ContentfulStatusCode; description?: string; noindex?: boolean } = {},
) {
  return c.html(
    shopLayout({ title, settings: c.get('settings'), cartCount: cartCount(readCart(c)), description: opts.description, noindex: opts.noindex }, body),
    opts.status ?? 200,
  );
}

export async function renderAdmin(c: Context<AppEnv>, title: string, body: H, opts: { nav?: AdminNav; status?: ContentfulStatusCode } = {}) {
  const session = c.get('session');
  const newCount = session ? (await countByStatus(c.env.DB)).ny : 0;
  return c.html(
    adminLayout({ title, settings: c.get('settings'), email: session?.email ?? null, csrf: c.get('csrf'), nav: opts.nav, newCount }, body),
    opts.status ?? 200,
  );
}
