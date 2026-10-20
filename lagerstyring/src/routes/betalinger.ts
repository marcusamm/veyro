// Betalinger og påmindelser på udstedte fakturaer (kun ejer og indkøber).

import { Hono, type MiddlewareHandler } from 'hono';
import type { AppEnv, InvoiceRow } from '../env';
import { formatDay, formatKr, parseDay, parseKr, str, todayDk } from '../lib/format';
import { getInvoice, parseJson } from '../lib/invoicing';
import { getJob } from '../lib/materials';
import { creditedTotal, duplicatePayment, invoicePayments, invoicesWithStatus, isMethod, payStatus } from '../lib/payments';
import { renderDoc } from '../lib/pdf';
import { companyInfo, type CustomerInfo } from '../lib/quotes';
import { canManage, requireUser } from '../lib/session';
import { actorOf, isDemo, render } from '../render';
import { FILTERS, followPage, paymentsSection } from '../views/betalinger';
import type { H } from '../views/layout';

const betalinger = new Hono<AppEnv>();
// Kun egne stier: routeren er monteret på /job sammen med jobportalens øvrige ruter
const guard: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!canManage(c.get('session')!.user)) return c.redirect('/job?besked=ingen_adgang', 303);
  await next();
};
betalinger.use('/faktura/opfolgning', requireUser, guard);
betalinger.use('/faktura/:iid{[0-9]+}/betaling/*', requireUser, guard);
betalinger.use('/faktura/:iid{[0-9]+}/betaling', requireUser, guard);
betalinger.use('/faktura/:iid{[0-9]+}/paamindelse/*', requireUser, guard);
betalinger.use('/faktura/:iid{[0-9]+}/paamindelse', requireUser, guard);
const now = () => Math.floor(Date.now() / 1000);

export async function paymentsFor(db: D1Database, inv: InvoiceRow, csrf: string, errs: string[] = []): Promise<H> {
  if (inv.status !== 'udstedt' || inv.kind !== 'faktura') return paymentsSection({ inv, st: payStatus(inv, 0, []), payments: [], reminders: [], csrf });
  const [payments, credited, { results: reminders }] = await Promise.all([
    invoicePayments(db, inv.id),
    creditedTotal(db, inv.id),
    db.prepare('SELECT r.id, r.outstanding, u.name AS created_by, r.created_at FROM invoice_reminders r LEFT JOIN users u ON u.email = r.created_by WHERE r.invoice_id = ? ORDER BY r.id DESC').bind(inv.id).all<{ id: number; outstanding: number; created_by: string; created_at: number }>(),
  ]);
  return paymentsSection({ inv, st: payStatus(inv, credited, payments), payments, reminders, csrf, errs });
}

betalinger.get('/faktura/opfolgning', async (c) => {
  const all = await invoicesWithStatus(c.env.DB);
  const filter = c.req.query('vis') ?? '';
  const f = FILTERS[filter];
  const rows = all.filter((i) => (f ? i.kind === 'faktura' && f(i.st) : true));
  const fak = all.filter((i) => i.kind === 'faktura');
  return render(
    c,
    'Betalingsopfølgning',
    followPage({ rows, filter: f ? filter : '', totals: { outstanding: fak.reduce((a, i) => a + Math.max(0, i.st.outstanding), 0), overdue: fak.filter((i) => i.st.pay === 'forfalden').reduce((a, i) => a + i.st.outstanding, 0) } }),
    { portal: 'job', tab: 'faktura' },
  );
});

async function issued(c: { env: AppEnv['Bindings']; req: { param: (k: string) => string | undefined } }): Promise<InvoiceRow | null> {
  const inv = await getInvoice(c.env.DB, parseInt(c.req.param('iid') ?? '', 10));
  return inv && inv.status === 'udstedt' && inv.kind === 'faktura' ? inv : null;
}

betalinger.post('/faktura/:iid{[0-9]+}/betaling', async (c) => {
  const db = c.env.DB;
  const inv = await issued(c);
  if (!inv) return c.notFound();
  const body = await c.req.parseBody();
  const raw = String(body['amount'] ?? '').trim();
  const abs = parseKr(raw.replace(/^-/, ''));
  const amount = abs === null ? null : raw.startsWith('-') ? -abs : abs;
  const paidOn = parseDay(body['paid_on']);
  const method = isMethod(body['method']) ? body['method'] : null;
  const currency = (str(body['currency'], 3) || 'DKK').toUpperCase();
  const reference = str(body['reference'], 100);
  const errs: string[] = [];
  if (!amount) errs.push('Angiv et beløb (ikke 0).');
  if (!paidOn) errs.push('Angiv datoen.');
  if (!method) errs.push('Vælg metoden.');
  if (!/^[A-Z]{3}$/.test(currency)) errs.push('Valutaen skal være tre bogstaver, fx DKK.');
  if (!errs.length && body['confirm_dup'] !== '1') {
    const dup = duplicatePayment(await invoicePayments(db, inv.id), { amount: amount!, paid_on: paidOn!, reference });
    if (dup) errs.push(`Der er allerede registreret ${formatKr(dup.amount, { decimals: true })} den ${formatDay(dup.paid_on)}${dup.reference ? ` (${dup.reference})` : ''}. Sæt flueben, hvis det er en ny betaling.`);
  }
  if (errs.length) return c.redirect(`/job/faktura/${inv.id}?betalingsfejl=${encodeURIComponent(errs.join(' '))}#betalinger`, 303);
  const a = actorOf(c);
  await db
    .prepare('INSERT INTO invoice_payments (invoice_id, paid_on, amount, currency, method, reference, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(inv.id, paidOn, amount, currency, method, reference, str(body['note'], 200), a.name, now())
    .run();
  return c.redirect(`/job/faktura/${inv.id}?besked=betaling_registreret#betalinger`, 303);
});

betalinger.post('/faktura/:iid{[0-9]+}/betaling/:pid{[0-9]+}/annuller', async (c) => {
  const inv = await issued(c);
  if (!inv) return c.notFound();
  await c.env.DB.prepare('UPDATE invoice_payments SET deleted_at = ?, deleted_by = ? WHERE id = ? AND invoice_id = ? AND deleted_at IS NULL').bind(now(), actorOf(c).name, Number(c.req.param('pid')), inv.id).run();
  return c.redirect(`/job/faktura/${inv.id}?besked=betaling_annulleret#betalinger`, 303);
});

betalinger.post('/faktura/:iid{[0-9]+}/paamindelse', async (c) => {
  const db = c.env.DB;
  const inv = await issued(c);
  if (!inv) return c.notFound();
  const st = payStatus(inv, await creditedTotal(db, inv.id), await invoicePayments(db, inv.id));
  if (st.outstanding <= 0) return c.redirect(`/job/faktura/${inv.id}#betalinger`, 303);
  const r = await db.prepare('INSERT INTO invoice_reminders (invoice_id, outstanding, created_by, created_at) VALUES (?, ?, ?, ?) RETURNING id').bind(inv.id, st.outstanding, actorOf(c).email, now()).first<{ id: number }>();
  return c.redirect(`/job/faktura/${inv.id}/paamindelse/${r!.id}.pdf`, 303);
});

betalinger.get('/faktura/:iid{[0-9]+}/paamindelse/:file{[0-9]+\\.pdf}', async (c) => {
  const db = c.env.DB;
  const inv = await issued(c);
  if (!inv) return c.notFound();
  const rem = await db.prepare('SELECT * FROM invoice_reminders WHERE id = ? AND invoice_id = ?').bind(parseInt(c.req.param('file'), 10), inv.id).first<{ id: number; outstanding: number; created_at: number }>();
  const j = await getJob(db, inv.job_id);
  if (!rem || !j) return c.notFound();
  const s = c.get('settings');
  const kr = (o: number) => formatKr(o, { decimals: true });
  const bytes = await renderDoc({
    title: 'Betalingspåmindelse',
    stamp: 'UDKAST: ikke sendt. Kontrollér før afsendelse.',
    company: companyInfo(s),
    customer: parseJson<CustomerInfo>(inv.customer),
    meta: [
      ['Dato', formatDay(todayDk(rem.created_at * 1000))],
      ['Faktura nr.', String(inv.number)],
      ['Fakturadato', formatDay(inv.issue_date)],
      ['Betalingsfrist', formatDay(inv.due_date)],
    ],
    intro: [
      `Vi kan ikke se, at faktura nr. ${inv.number} vedrørende ${j.name} er betalt fuldt ud. Udestående beløb: ${kr(rem.outstanding)}.`,
      'Har du allerede betalt, kan du se bort fra denne påmindelse. Ellers bedes beløbet indbetalt hurtigst muligt.',
    ],
    sections: [],
    totals: [
      ['Fakturabeløb', kr(inv.total)],
      ['Udestående', kr(rem.outstanding), true],
    ],
    notes: [s.bank_reg && s.bank_account ? `Betaling til reg.nr. ${s.bank_reg}, konto ${s.bank_account}. Angiv fakturanummer ${inv.number}.` : '!Bankoplysninger mangler under Indstillinger.', 'Der er ikke beregnet gebyrer eller renter.'],
    footer: [[s.company_name, s.company_cvr && `CVR ${s.company_cvr}`].filter(Boolean).join(' · '), isDemo(c) ? 'DEMODATA: fiktiv påmindelse.' : ''].filter(Boolean),
  });
  return c.body(bytes as Uint8Array<ArrayBuffer>, 200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="Paamindelse-udkast-${inv.number}.pdf"` });
});

export default betalinger;
