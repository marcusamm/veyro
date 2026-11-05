import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { analyticsReport, analyticsSessionDetail } from '../lib/site-analytics';
import { parsePeriod, recentMonths } from '../lib/stats';
import { render } from '../render';
import { visitorsPage, visitorSessionPage } from '../views/admin-visitors';
import { errorPage } from '../views/pages';
import { adminGuard } from './admin-guard';

const adminVisitors = new Hono<AppEnv>();
adminVisitors.use('/besoegende', adminGuard);
adminVisitors.use('/besoegende/*', adminGuard);

function isMissingAnalyticsSchema(error: unknown): boolean {
  return error instanceof Error && /no such table:\s*(?:main\.)?site_analytics_(?:visitors|sessions|pageviews)\b/i.test(error.message);
}

function analyticsUnavailable(c: Context<AppEnv>) {
  return render(c, 'Besøgsstatistik klargøres', errorPage('Besøgsstatistik klargøres', 'Den nye besøgsoversigt bliver gjort klar. Prøv igen om et øjeblik.', { href: '/admin/statistik', label: 'Til den eksisterende statistik' }), { nav: 'admin-besoegende', admin: true, status: 503 });
}

adminVisitors.get('/besoegende', async (c) => {
  const raw = c.req.query('periode');
  const period = parsePeriod(/^(7|30|90|\d{4}-\d{2})$/.test(raw ?? '') ? raw : '30');
  c.header('Cache-Control', 'private, no-store');
  try {
    const report = await analyticsReport(c.env.DB, period);
    return render(c, 'Besøgende', visitorsPage({ report, months: recentMonths().slice(0, 4) }), { nav: 'admin-besoegende', admin: true });
  } catch (error) {
    if (isMissingAnalyticsSchema(error)) return analyticsUnavailable(c);
    throw error;
  }
});

adminVisitors.get('/besoegende/:id', async (c) => {
  const id = c.req.param('id');
  const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  c.header('Cache-Control', 'private, no-store');
  let detail;
  try {
    detail = validId ? await analyticsSessionDetail(c.env.DB, id) : null;
  } catch (error) {
    if (isMissingAnalyticsSchema(error)) return analyticsUnavailable(c);
    throw error;
  }
  if (!detail) {
    return render(c, 'Besøg ikke fundet', errorPage('Besøg ikke fundet', 'Besøget findes ikke længere i den gemte historik.', { href: '/admin/besoegende', label: 'Til besøgsoversigten' }), { nav: 'admin-besoegende', admin: true, status: 404 });
  }
  return render(c, 'Besøgsforløb', visitorSessionPage(detail), { nav: 'admin-besoegende', admin: true });
});

export default adminVisitors;
