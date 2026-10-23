// Fælles adgangskontrol for de interne salgs- og omkostningssider: kun ADMIN_EMAILS (tjekkes på serveren).
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';
import { isAdmin } from '../lib/session';
import { render } from '../render';
import { errorPage } from '../views/pages';

export const adminGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = c.get('session');
  if (!session) return c.redirect('/admin/login', 303);
  if (!isAdmin(c.env, session.email)) {
    return render(c, 'Ingen adgang', errorPage('Ingen adgang', 'Du har ikke adgang til denne side.', { href: '/konto', label: 'Til kundepanelet' }), { status: 403 });
  }
  await next();
};
