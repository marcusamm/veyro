import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from './env';
import { getCurrentSubscription, getCustomerByEmail } from './lib/db';
import { isComplimentary } from './lib/customer-agreement';
import { isAdmin } from './lib/session';
import { agreementsAccess } from './routes/aftaler';
import { layout, type H, type NavKey } from './views/layout';

export async function render(
  c: Context<AppEnv>,
  title: string,
  body: H,
  opts: { nav?: NavKey; status?: ContentfulStatusCode; admin?: boolean; isCustomer?: boolean; kasse?: boolean; refresh?: number } = {},
) {
  const session = c.get('session');
  const admin = isAdmin(c.env, session?.email);
  let isCustomer = opts.isCustomer;
  if (session && isCustomer === undefined) {
    isCustomer = !!(await getCustomerByEmail(c.env.DB, session.email));
  }
  const customer = session && isCustomer && !opts.admin ? await getCustomerByEmail(c.env.DB, session.email) : null;
  const complimentaryNav = !!customer && isComplimentary(await getCurrentSubscription(c.env.DB, customer.id));
  const agreementsNav = !!session && !!isCustomer && !opts.admin && (await agreementsAccess(c.env, session.email));
  const legacyToolsNav = !!session && !!isCustomer && !opts.admin && !!(await c.env.DB.prepare(
    'SELECT 1 AS found FROM tool_projects p JOIN customers c ON c.id = p.customer_id WHERE c.email = ? LIMIT 1',
  ).bind(session.email).first());
  return c.html(
    layout(
      {
        title,
        email: session?.email ?? null,
        csrf: c.get('csrf'),
        nav: opts.nav,
        isAdmin: admin,
        customerNav: !!session && !!isCustomer && !opts.admin,
        complimentaryNav,
        legacyToolsNav,
        adminNav: !!opts.admin && admin,
        agreementsNav,
        // Kassens medarbejdere uden for ADMIN_EMAILS ser kun kassen
        staffNav: !!opts.kasse && !admin && !!session,
        kasse: opts.kasse,
        refresh: opts.refresh,
      },
      body,
    ),
    opts.status ?? 200,
  );
}
