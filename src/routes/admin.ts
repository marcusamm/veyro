import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { listAllRequests, listCustomers, updateRequestStatus } from '../lib/db';
import { isAdmin } from '../lib/session';
import { render } from '../render';
import { adminCustomersPage, adminOverviewPage, adminRequestsPage } from '../views/admin';
import { errorPage } from '../views/pages';
import { REQUEST_STATUSES } from '../views/status';

const admin = new Hono<AppEnv>();

// Kun e-mails i ADMIN_EMAILS (samme magic-link-login som kunder)
admin.use('*', async (c, next) => {
  const session = c.get('session');
  if (!session) return c.redirect('/login', 303);
  if (!isAdmin(c.env, session.email)) {
    return render(c, 'Ingen adgang', errorPage('Ingen adgang', 'Du har ikke adgang til denne side.', { href: '/konto', label: 'Til kundepanelet' }), {
      status: 403,
    });
  }
  await next();
});

admin.get('/', async (c) => {
  const [customers, requests] = await Promise.all([listCustomers(c.env.DB), listAllRequests(c.env.DB, null)]);
  return render(c, 'Admin', adminOverviewPage({ customers, requests }), { nav: 'admin', admin: true });
});

admin.get('/kunder', async (c) => {
  const customers = await listCustomers(c.env.DB);
  return render(c, 'Kunder', adminCustomersPage({ customers }), { nav: 'admin-kunder', admin: true });
});

admin.get('/henvendelser', async (c) => {
  const q = c.req.query('status');
  const filter = q && q in REQUEST_STATUSES ? q : null;
  const requests = await listAllRequests(c.env.DB, filter);
  return render(
    c,
    'Henvendelser',
    adminRequestsPage({ csrf: c.get('csrf'), requests, filter, updated: c.req.query('opdateret') === '1' }),
    { nav: 'admin-henvendelser', admin: true },
  );
});

admin.post('/henvendelser/:id/status', async (c) => {
  const id = Number.parseInt(c.req.param('id'), 10);
  const body = await c.req.parseBody();
  const status = body['status'];
  if (!Number.isSafeInteger(id) || id <= 0 || typeof status !== 'string' || !(status in REQUEST_STATUSES)) {
    return c.text('Ugyldig anmodning.', 400);
  }
  const ok = await updateRequestStatus(c.env.DB, id, status);
  if (!ok) return c.text('Henvendelsen findes ikke.', 404);
  return c.redirect(`/admin/henvendelser?opdateret=1#h-${id}`, 303);
});

export default admin;
