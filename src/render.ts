import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from './env';
import { getCustomerByEmail } from './lib/db';
import { isAdmin } from './lib/session';
import { agreementsAccess } from './routes/aftaler';
import { layout, type H, type NavKey } from './views/layout';

export async function render(
  c: Context<AppEnv>,
  title: string,
  body: H,
  opts: { nav?: NavKey; status?: ContentfulStatusCode; admin?: boolean; isCustomer?: boolean } = {},
) {
  const session = c.get('session');
  const admin = isAdmin(c.env, session?.email);
  let isCustomer = opts.isCustomer;
  if (session && isCustomer === undefined) {
    isCustomer = !!(await getCustomerByEmail(c.env.DB, session.email));
  }
  const agreementsNav = !!session && !!isCustomer && !opts.admin && (await agreementsAccess(c.env, session.email));
  const websiteNav =
    !!session && !!isCustomer && !opts.admin && !!(await c.env.DB.prepare('SELECT 1 FROM company_members WHERE email = ? LIMIT 1').bind(session.email).first().catch(() => null));
  return c.html(
    layout(
      {
        title,
        email: session?.email ?? null,
        csrf: c.get('csrf'),
        nav: opts.nav,
        isAdmin: admin,
        customerNav: !!session && !!isCustomer && !opts.admin,
        adminNav: !!opts.admin && admin,
        agreementsNav,
        websiteNav,
      },
      body,
    ),
    opts.status ?? 200,
  );
}
