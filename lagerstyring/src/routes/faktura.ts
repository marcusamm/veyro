// Det tidligere fakturagrundlag (kun materialer). Fakturering sker nu under Job → Faktura; her kan
// tidligere grundlag stadig ses og eksporteres, og en kladde, der allerede findes, kan gøres færdig,
// så længe jobbet ikke er faktureret i den nye faktura.

import { Hono, type Context } from 'hono';
import type { AppEnv, InvoiceBasisRow } from '../env';
import { basisCsv, customerSnapshot, getBasis, totals, uninvoiced } from '../lib/billing';
import { parseKr, parseQty, str } from '../lib/format';
import { getJob } from '../lib/materials';
import { actorOf, render } from '../render';
import { basisPage, fakturaListPage, type BasisListRow, type BillingJobRow } from '../views/faktura';

const faktura = new Hono<AppEnv>();
const NAV = { portal: 'lager', tab: 'faktura' } as const;
const now = () => Math.floor(Date.now() / 1000);

faktura.get('/', async (c) => {
  const db = c.env.DB;
  const [{ results: jobs }, { results: bases }] = await Promise.all([
    db
      .prepare(
        `SELECT j.id, j.number, j.name, j.customer_name, j.status,
           (SELECT id FROM invoice_bases b WHERE b.job_id = j.id AND b.status = 'kladde') AS draft_id,
           (SELECT COUNT(*) FROM invoice_bases b WHERE b.job_id = j.id AND b.status = 'godkendt') AS approved_count,
           (SELECT MAX(approved_at) FROM invoice_bases b WHERE b.job_id = j.id AND b.status = 'godkendt') AS last_approved_at
         FROM jobs j
         WHERE EXISTS (SELECT 1 FROM job_materials m WHERE m.job_id = j.id AND (m.issued > 0 OR m.site_used > 0))
            OR EXISTS (SELECT 1 FROM purchase_lines l WHERE l.job_id = j.id AND l.product_id IS NULL AND l.received > 0)
         ORDER BY j.status <> 'afsluttet', j.updated_at DESC LIMIT 200`,
      )
      .all<BillingJobRow>(),
    db
      .prepare('SELECT b.*, j.number AS job_number, j.name AS job_name FROM invoice_bases b JOIN jobs j ON j.id = b.job_id ORDER BY b.id DESC LIMIT 30')
      .all<BasisListRow>(),
  ]);
  return render(c, 'Fakturagrundlag', fakturaListPage({ jobs, bases, flashCode: c.req.query('besked') }), NAV);
});

faktura.get('/job/:id{[0-9]+}', (c) => c.redirect(`/job/${c.req.param('id')}/faktura`, 301));

faktura.post('/job/:id{[0-9]+}/kladde', async (c) => {
  // Nye kladder laves under Job → Faktura, så intet faktureres to steder
  return c.redirect(`/job/${c.req.param('id')}/faktura`, 303);
});

async function showBasis(c: Context<AppEnv>, id: number, errs: string[] = []) {
  const b = await getBasis(c.env.DB, id);
  if (!b) return c.notFound();
  return render(
    c,
    'Fakturagrundlag',
    basisPage({ ...b, company: c.get('settings').company_name, csrf: c.get('csrf'), flashCode: c.req.query('besked'), errs }),
    NAV,
    errs.length ? 400 : 200,
  );
}

faktura.get('/:id{[0-9]+}', (c) => showBasis(c, Number(c.req.param('id'))));

faktura.post('/:id{[0-9]+}', async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const b = await getBasis(db, id);
  if (!b) return c.notFound();
  if (b.basis.status !== 'kladde') return showBasis(c, id, ['Fakturagrundlaget er godkendt og kan ikke ændres.']);
  const body = await c.req.parseBody();
  const action = body['do'];
  if (action !== 'slet' && (await db.prepare('SELECT 1 FROM invoices WHERE job_id = ? LIMIT 1').bind(b.basis.job_id).first()))
    return showBasis(c, id, ['Jobbet faktureres nu under Job → Faktura. Slet denne kladde, så intet faktureres to gange.']);

  if (action === 'slet') {
    await db.batch([
      db.prepare('DELETE FROM invoice_lines WHERE basis_id = ?').bind(id),
      db.prepare("DELETE FROM invoice_bases WHERE id = ? AND status = 'kladde'").bind(id),
    ]);
    return c.redirect(`/lager/faktura/job/${b.basis.job_id}?besked=slettet`, 303);
  }

  // Gem rettelser (også før godkendelse)
  const errs: string[] = [];
  const lines = b.lines.map((l) => {
    const qty = parseQty(body[`qty_${l.id}`]);
    const cost = parseKr(body[`cost_${l.id}`]);
    const price = parseKr(body[`price_${l.id}`]);
    if (qty === null || qty < 0) errs.push(`Mængden for ${l.name} er ikke gyldig.`);
    if (cost === null || cost < 0) errs.push(`Kostprisen for ${l.name} er ikke gyldig.`);
    if (price === null || price < 0) errs.push(`Salgsprisen for ${l.name} er ikke gyldig.`);
    return { ...l, qty: qty ?? l.qty, unit_cost: cost ?? l.unit_cost, unit_price: price ?? l.unit_price, include: body[`inc_${l.id}`] === '1' ? 1 : 0 };
  });
  if (errs.length) return showBasis(c, id, errs);

  if (action === 'godkend') {
    // Der kan ikke godkendes mere, end der faktisk er brugt og ikke allerede faktureret
    const open = await uninvoiced(db, b.basis.job_id);
    const avail = new Map(open.map((o) => [`${o.source}:${o.product_id ?? ''}:${o.purchase_line_id ?? ''}`, o.qty]));
    const used = new Map<string, number>();
    for (const l of lines) {
      const k = `${l.source}:${l.product_id ?? ''}:${l.purchase_line_id ?? ''}`;
      used.set(k, (used.get(k) ?? 0) + l.qty);
      if ((used.get(k) ?? 0) > (avail.get(k) ?? 0)) {
        errs.push(`${l.name}: mængden er større end det forbrug, der ikke er faktureret. Forbruget kan være ændret (fx returneret); opdatér kladden fra jobbet.`);
      }
    }
    if (errs.length) return showBasis(c, id, errs);
  }

  const job = await getJob(db, b.basis.job_id);
  const t = totals(lines);
  const stmts = lines.map((l) =>
    db.prepare('UPDATE invoice_lines SET qty = ?, unit_cost = ?, unit_price = ?, include = ? WHERE id = ? AND basis_id = ?').bind(l.qty, l.unit_cost, l.unit_price, l.include, l.id, id),
  );
  const approve = action === 'godkend';
  stmts.push(
    db
      .prepare(
        `UPDATE invoice_bases SET note = ?, total_cost = ?, total_sale = ?, customer = COALESCE(?, customer),
           status = CASE WHEN ? THEN 'godkendt' ELSE status END, approved_by = CASE WHEN ? THEN ? ELSE approved_by END, approved_at = CASE WHEN ? THEN ? ELSE approved_at END
         WHERE id = ? AND status = 'kladde'`,
      )
      .bind(str(body['note'], 1000, { multiline: true }), t.cost, t.sale, job ? customerSnapshot(job) : null, approve ? 1 : 0, approve ? 1 : 0, actorOf(c).name, approve ? 1 : 0, now(), id),
  );
  await db.batch(stmts);
  return c.redirect(`/lager/faktura/${id}?besked=${approve ? 'godkendt' : 'gemt'}`, 303);
});

faktura.get('/:file{[0-9]+\\.csv}', async (c) => {
  const b = await getBasis(c.env.DB, parseInt(c.req.param('file'), 10));
  if (!b) return c.notFound();
  const job = b.basis.job_id;
  return c.body(basisCsv(b.basis, b.lines, c.get('settings')), 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="fakturagrundlag-${job}-${b.basis.id}.csv"`,
  });
});

export default faktura;
