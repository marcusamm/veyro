// Statistik i admin (/admin/statistik) og Excel-udtræk for en periode.
import { Hono, type MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';
import { isAdmin } from '../lib/session';
import { collectStats, monthly, parsePeriod, previousPeriod, recentMonths, snapshot, type Snapshot, type Stats } from '../lib/stats';
import { buildXlsx, type XCell, type XSheet } from '../lib/xlsx';
import { render } from '../render';
import { LEAD_KIND_LABEL, LEAD_STATUS_LABEL, type LeadCartLine, type LeadKind, type LeadStatus } from '../site/leads';
import { statsPage } from '../views/admin-stats';
import { errorPage } from '../views/pages';

const adminStats = new Hono<AppEnv>();

const guard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = c.get('session');
  if (!session) return c.redirect('/admin/login', 303);
  if (!isAdmin(c.env, session.email)) {
    return render(c, 'Ingen adgang', errorPage('Ingen adgang', 'Du har ikke adgang til denne side.', { href: '/konto', label: 'Til kundepanelet' }), { status: 403 });
  }
  await next();
};
adminStats.use('/statistik', guard);
adminStats.use('/statistik/*', guard);

async function load(c: { env: AppEnv['Bindings'] }, raw: string | undefined, details: boolean) {
  const period = parsePeriod(raw);
  const [stats, prev, snap] = await Promise.all([
    collectStats(c.env, period, { details }),
    collectStats(c.env, previousPeriod(period)),
    snapshot(c.env.DB),
  ]);
  return { stats, prev, snap };
}

adminStats.get('/statistik', async (c) => {
  const { stats, prev, snap } = await load(c, c.req.query('periode'), false);
  return render(c, 'Statistik', statsPage({ stats, prev, snap, months: recentMonths() }), { nav: 'admin-statistik', admin: true });
});

adminStats.get('/statistik/excel', async (c) => {
  const { stats, prev, snap } = await load(c, c.req.query('periode'), true);
  const file = buildXlsx(workbook(stats, prev, snap));
  const name = `veyro-statistik-${stats.period.key.length === 7 ? stats.period.key : `${stats.period.from}_${stats.period.to}`}.xlsx`;
  return c.body(file, 200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${name}"`,
    'Cache-Control': 'no-store',
  });
});

const kr = (oere: number | null | undefined): XCell => (oere === null || oere === undefined ? null : { kr: oere / 100 });
const ratio = (a: number, b: number): XCell => (b ? { pct: a / b } : null);

function cartText(raw: string | null): string {
  if (!raw) return '';
  try {
    return (JSON.parse(raw) as LeadCartLine[]).map((l) => `${l.quantity} × ${l.title}`).join(', ');
  } catch {
    return '';
  }
}

export function workbook(s: Stats, p: Stats, snap: Snapshot): XSheet[] {
  const per = s.period;
  const conv = (x: Stats) => (x.views.total ? x.leads.rows.length / x.views.total : null);
  const kpi = (label: string, now: number, before: number, money = false): XCell[] => [
    label,
    money ? kr(now) : now,
    money ? kr(before) : before,
    before ? { pct: (now - before) / before } : null,
  ];
  const lastDay = new Date(Date.UTC(+per.to.slice(0, 4), +per.to.slice(5, 7) - 1, +per.to.slice(8, 10) - 1)).toISOString().slice(0, 10);
  const prevLast = new Date(Date.UTC(+p.period.to.slice(0, 4), +p.period.to.slice(5, 7) - 1, +p.period.to.slice(8, 10) - 1)).toISOString().slice(0, 10);
  return [
    {
      name: 'Oversigt',
      widths: [40, 18, 18, 12],
      rows: [
        ['Nøgletal', `${per.from} – ${lastDay}`, `${p.period.from} – ${prevLast}`, 'Ændring'],
        kpi('Sidevisninger', s.views.total, p.views.total),
        kpi('Forespørgsler', s.leads.rows.length, p.leads.rows.length),
        ['Forespørgsler pr. visning', conv(s) === null ? null : { pct: conv(s)! }, conv(p) === null ? null : { pct: conv(p)! }, null],
        kpi('Tilbud sendt', s.offers.sent, p.offers.sent),
        kpi('Tilbud accepteret og betalt', s.offers.activated, p.offers.activated),
        kpi('Nye kunder', s.customers.rows.length, p.customers.rows.length),
        kpi('Omsætning, betalt inkl. moms (kr.)', s.revenue.total, p.revenue.total, true),
        ['Antal betalinger', s.revenue.rows.length, p.revenue.rows.length, null],
        [],
        ['Lige nu', 'Værdi'],
        ['Aktive abonnementer', snap.activeSubscriptions],
        ['Fast månedlig omsætning (kr., som i Stripe)', kr(snap.mrr)],
        ['Åbne forespørgsler', snap.openLeads],
        [],
        [`Omsætning hentet fra ${s.revenue.source === 'stripe' ? 'Stripe' : 'kundepanelets egne betalinger (Stripe svarede ikke)'}. Sidevisninger tælles uden cookies.`],
      ],
    },
    {
      name: 'Pr. dag',
      widths: [14, 14, 14, 18],
      rows: [
        ['Dato', 'Sidevisninger', 'Forespørgsler', 'Omsætning (kr.)'],
        ...s.days.map((d, i): XCell[] => [{ date: d }, s.views.byDay[i] ?? 0, s.leads.byDay[i] ?? 0, kr(s.revenue.byDay[i] ?? 0)]),
        ['I alt', s.views.total, s.leads.rows.length, kr(s.revenue.total)],
      ],
    },
    {
      name: 'Sider',
      widths: [50, 14, 10],
      rows: [['Side', 'Visninger', 'Andel'], ...s.views.byPath.map((r): XCell[] => [r.path, r.views, ratio(r.views, s.views.total)])],
    },
    {
      name: 'Forespørgsler',
      widths: [18, 18, 14, 24, 24, 30, 24, 24, 40],
      rows: [
        ['Modtaget', 'Kilde', 'Status', 'Navn', 'Firma', 'E-mail', 'Ydelse', 'Side', 'Kurv'],
        ...s.leads.rows.map((l): XCell[] => [
          { dateTime: l.created_at },
          LEAD_KIND_LABEL[l.kind as LeadKind] ?? l.kind,
          LEAD_STATUS_LABEL[l.status as LeadStatus] ?? l.status,
          l.name,
          l.company,
          l.email,
          l.service,
          l.page,
          cartText(l.cart),
        ]),
      ],
    },
    {
      name: 'Tilbud',
      widths: [18, 24, 24, 30, 28, 20, 10, 20, 20, 12, 18],
      rows: [
        ['Oprettet', 'Kunde', 'Firma', 'E-mail', 'Ydelse', 'Pris pr. periode ekskl. moms (kr.)', 'Interval', 'Pr. måned ekskl. moms (kr.)', 'Engangsbeløb ekskl. moms (kr.)', 'Status', 'Accepteret og betalt'],
        ...s.offers.rows.map((o): XCell[] => [
          { dateTime: o.created_at },
          o.name,
          o.company,
          o.email,
          o.service,
          kr(o.amount),
          o.interval === 'year' ? 'År' : 'Måned',
          kr(monthly(o.amount, o.interval)),
          kr(o.setup_amount),
          { open: 'Åbent', processing: 'Betales', active: 'Aktivt', withdrawn: 'Trukket tilbage', ended: 'Afsluttet' }[o.status] ?? o.status,
          o.activated_at ? { dateTime: o.activated_at } : null,
        ]),
      ],
    },
    {
      name: 'Betalinger',
      widths: [18, 18, 30, 18, 18, 8],
      rows: [
        ['Betalt', 'Fakturanr.', 'Kunde', 'Beløb inkl. moms (kr.)', 'Beløb ekskl. moms (kr.)', 'Valuta'],
        ...s.revenue.rows.map((r): XCell[] => [{ dateTime: r.paidAt }, r.number ?? r.id, r.customer, kr(r.total), kr(r.net), r.currency.toUpperCase()]),
        ['I alt', null, null, kr(s.revenue.total), kr(s.revenue.rows.every((r) => r.net !== null) ? s.revenue.rows.reduce((a, r) => a + (r.net ?? 0), 0) : null)],
      ],
    },
    {
      name: 'Nye kunder',
      widths: [18, 24, 24, 30],
      rows: [['Oprettet', 'Navn', 'Firma', 'E-mail'], ...s.customers.rows.map((k): XCell[] => [{ dateTime: k.created_at }, k.name, k.company, k.email])],
    },
  ];
}

export default adminStats;
