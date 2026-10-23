// Kassen (point of sale) under /admin/kasse. Monteres før resten af admin, så medarbejdere med en
// rolle i kassen (Personale) kan bruge den uden at stå i ADMIN_EMAILS. Rettigheder tjekkes pr.
// handling her på serveren, ikke kun ved at skjule knapper. CSRF håndteres af index.ts.
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { randomToken } from '../lib/crypto';
import { normalizeEmail } from '../lib/db';
import { sendEmail } from '../lib/email';
import { logError } from '../lib/errlog';
import type { Discount } from '../lib/pos/calc';
import { adjustStock, getItem, getItemImage, itemCategories, listItems, listMovements, saveItem, type ItemInput } from '../lib/pos/items';
import { receiptEmail } from '../lib/pos/receipt';
import { addDays, buildReport, dayStart, isDate, localDate } from '../lib/pos/reports';
import {
  SALE_STATUSES,
  audit,
  cancelPendingSale,
  createSale,
  getSale,
  listAudit,
  listSales,
  maxDiscountBp,
  posProducts,
  refundSale,
  saleStaffEmails,
  searchCustomers,
  startStripePayment,
  syncCardPayment,
  type CreateSaleResult,
  type SaleDetail,
  type SaleLineInput,
  type SalePaymentInput,
  type SaleStatus,
} from '../lib/pos/sales';
import {
  DEFAULT_POS_SETTINGS,
  discountPresets,
  getPosSettings,
  methodOptions,
  otherMethods,
  savePosSettings,
  vatBp,
  type PaymentMethod,
  type PosSettings,
} from '../lib/pos/settings';
import { can, getStaff, isRole, listStaff, pinValid, setPin, staffAccess, staffNames, upsertStaff, type Permission, type Role, type StaffInfo } from '../lib/pos/staff';
import { isAdmin, parseAdminEmails } from '../lib/session';
import { render } from '../render';
import {
  itemFormPage,
  itemFormValues,
  itemsPage,
  pinPage,
  posPage,
  posSettingsPage,
  receiptPage,
  reportsPage,
  saleDetailPage,
  saleFlash,
  salesPage,
  staffPage,
  type ItemFormValues,
} from '../views/kasse';
import { alert, type H } from '../views/layout';
import { errorPage } from '../views/pages';

type KasseEnv = AppEnv & { Variables: AppEnv['Variables'] & { staff: StaffInfo } };
type C = Context<KasseEnv>;

const kasse = new Hono<KasseEnv>();
const PAGE_SIZE = 50;
const KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;

const me = (c: C) => c.get('staff');
const role = (c: C): Role => me(c).role;

/** Tekst fra en formular: trimmet, uden kontroltegn og højst `max` tegn. */
function str(v: unknown, max: number, multiline = false): string {
  if (typeof v !== 'string') return '';
  const s = multiline ? v.replace(/\r\n?/g, '\n').replace(/[^\S\n]+\n/g, '\n') : v.replace(/\s+/g, ' ');
  return s.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim().slice(0, max);
}

function intOf(v: unknown, min: number, max: number): number | null {
  if (typeof v !== 'string' || !/^-?\d{1,9}$/.test(v.trim())) return null;
  const n = Number(v.trim());
  return n >= min && n <= max ? n : null;
}

/** Kroner fra en formular ("1.234,50", "99") til øre. 0 er tilladt. */
function krToOere(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  let s = v.replace(/\s|kr\.?/gi, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const oere = Math.round(Number(s) * 100);
  return Number.isSafeInteger(oere) && oere <= 100_000_000 ? oere : null;
}

function page(c: C, title: string, body: H, opts: { status?: 400 | 403 | 404 | 409 | 502 } = {}) {
  return render(c as unknown as Context<AppEnv>, title, body, { nav: 'admin-kasse', admin: true, kasse: true, status: opts.status });
}

function isApi(c: C) {
  return new URL(c.req.url).pathname.startsWith('/admin/kasse/api/');
}

// ---- Adgang: logget ind og medarbejder i kassen (ADMIN_EMAILS eller aktiv i Personale) ----

kasse.use('*', async (c, next) => {
  const session = c.get('session');
  if (!session) return isApi(c) ? c.json({ ok: false, message: 'Du er logget ud. Log ind igen.' }, 401) : c.redirect('/admin/login', 303);
  const staff = await staffAccess(c.env, session.email);
  if (!staff) {
    if (isApi(c)) return c.json({ ok: false, message: 'Du har ikke adgang til kassen.' }, 403);
    return render(c as unknown as Context<AppEnv>, 'Ingen adgang', errorPage('Ingen adgang', 'Du har ikke adgang til kassen. Spørg en administrator.', { href: '/', label: 'Til forsiden' }), { status: 403 });
  }
  c.set('staff', staff);
  await next();
});

/** Kræver en rettighed; API-kald får JSON, sider får en fejlside. */
function need(p: Permission) {
  return async (c: C, next: () => Promise<void>) => {
    if (!can(role(c), p)) {
      if (isApi(c)) return c.json({ ok: false, message: 'Din rolle giver ikke adgang til det.' }, 403);
      return page(c, 'Ingen adgang', errorPage('Ingen adgang', 'Din rolle giver ikke adgang til denne side. Spørg en administrator.', { href: '/admin/kasse', label: 'Til kassen' }), { status: 403 });
    }
    await next();
  };
}

function canSeeSale(c: C, pos: PosSettings, staffEmail: string): boolean {
  return can(role(c), 'pos.sales.all') || pos.cashier_sees_all || staffEmail.toLowerCase() === me(c).email;
}

async function loadSale(c: C, pos: PosSettings): Promise<SaleDetail | null> {
  const d = await getSale(c.env.DB, Number(c.req.param('id')));
  if (!d || !canSeeSale(c, pos, d.sale.staff_email)) return null;
  return d;
}

function notFound(c: C) {
  return page(c, 'Ikke fundet', errorPage('Salget findes ikke', 'Det findes ikke, eller du har ikke adgang til det.', { href: '/admin/kasse/salg', label: 'Til salgshistorikken' }), { status: 404 });
}

// ---------------- Kasseskærm ----------------

kasse.get('/', async (c) => {
  const pos = await getPosSettings(c.env.DB);
  const options = methodOptions(pos, c.env);
  const notices: string[] = [];
  if (!options.length) notices.push('Der er ingen betalingsformer slået til. En administrator kan slå dem til under Indstillinger.');
  const staffRow = await getStaff(c.env.DB, me(c).email);
  return page(
    c,
    'Kasse',
    posPage({
      role: role(c),
      notices,
      config: {
        csrf: c.get('csrf'),
        methods: options,
        presets: discountPresets(pos),
        vatBp: vatBp(pos),
        cashRounding: pos.cash_rounding,
        scanner: pos.scanner_enabled,
        scannerAutoAdd: pos.scanner_auto_add,
        maxDiscountBp: maxDiscountBp(role(c), pos),
        autoPrint: pos.receipt_auto_print,
        canEmail: !!c.env.RESEND_API_KEY,
        canManage: can(role(c), 'pos.items'),
        staff: staffRow?.name || me(c).email,
      },
    }),
  );
});

kasse.get('/api/varer', async (c) => {
  const pos = await getPosSettings(c.env.DB);
  const products = await posProducts(c.env.DB, pos);
  const categories = [...new Set(products.map((p) => p.category).filter(Boolean))];
  return c.json({ ok: true, products, categories });
});

kasse.get('/api/kunder', async (c) => {
  const q = str(c.req.query('q'), 80);
  if (q.length < 2) return c.json({ ok: true, customers: [] });
  return c.json({ ok: true, customers: await searchCustomers(c.env.DB, q) });
});

function parseJson<T>(raw: unknown): T | null {
  if (typeof raw !== 'string' || raw.length > 100_000) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function parseDiscount(raw: unknown): Discount | null | undefined {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') return undefined;
  const d = raw as { type?: unknown; value?: unknown };
  if (d.type !== 'pct' && d.type !== 'amount') return undefined;
  if (!Number.isSafeInteger(d.value) || (d.value as number) < 0) return undefined;
  if (d.type === 'pct' && (d.value as number) > 10000) return undefined;
  if (d.value === 0) return null;
  return { type: d.type, value: d.value as number };
}

/** Kort oversigt over et salg til kassen (bekræftelse, byttepenge og kvittering). */
function summary(d: SaleDetail) {
  const cash = d.payments.find((p) => p.method === 'kontant' && p.status === 'gennemfoert');
  return {
    id: d.sale.id,
    number: d.sale.number,
    status: d.sale.status,
    total: d.sale.total,
    rounding: d.sale.rounding,
    change: cash?.change_given ?? 0,
    received: cash?.received ?? 0,
    email: d.sale.customer_email,
    payments: d.payments.map((p) => ({ label: p.label, amount: p.amount, status: p.status, method: p.method, error: p.error })),
    receiptUrl: `/admin/kasse/salg/${d.sale.id}/kvittering`,
  };
}

kasse.post('/api/salg', async (c) => {
  const pos = await getPosSettings(c.env.DB);
  const b = await c.req.parseBody();
  const key = typeof b['key'] === 'string' ? b['key'] : '';
  if (!KEY_RE.test(key)) return c.json({ ok: false, code: 'invalid', message: 'Ugyldig anmodning. Genindlæs kassen.' }, 400);
  type RawLine = { id?: unknown; qty?: unknown; discount?: unknown };
  const rawLines = parseJson<RawLine[]>(b['lines']);
  const rawPayments = parseJson<{ key?: unknown; amount?: unknown; received?: unknown; reference?: unknown }[]>(b['payments']);
  const customer = parseJson<{ id?: unknown; name?: unknown; email?: unknown; phone?: unknown; company?: unknown }>(b['customer']) ?? {};
  const orderDiscount = parseDiscount(parseJson(b['order_discount']));
  const expected = intOf(b['expected_total'], 0, 1_000_000_000);
  if (!Array.isArray(rawLines) || !Array.isArray(rawPayments) || orderDiscount === undefined || expected === null || typeof customer !== 'object') {
    return c.json({ ok: false, code: 'invalid', message: 'Ugyldige data. Genindlæs kassen.' }, 400);
  }
  const lines: SaleLineInput[] = [];
  for (const l of rawLines.slice(0, 201)) {
    const discount = parseDiscount(l?.discount);
    if (!Number.isSafeInteger(l?.id) || !Number.isSafeInteger(l?.qty) || (l.qty as number) < 1 || (l.qty as number) > 9999 || discount === undefined) {
      return c.json({ ok: false, code: 'invalid', message: 'Ugyldigt antal eller rabat i kurven.' }, 400);
    }
    lines.push({ itemId: l.id as number, quantity: l.qty as number, discount });
  }
  const payments: SalePaymentInput[] = [];
  for (const p of rawPayments.slice(0, 7)) {
    if (typeof p?.key !== 'string') return c.json({ ok: false, code: 'invalid', message: 'Ugyldig betaling.' }, 400);
    payments.push({
      key: p.key.slice(0, 60),
      amount: Number.isSafeInteger(p.amount) ? (p.amount as number) : 0,
      received: Number.isSafeInteger(p.received) ? (p.received as number) : undefined,
      reference: str(p.reference, 60),
    });
  }
  const email = typeof customer.email === 'string' && customer.email.trim() ? normalizeEmail(customer.email) : '';
  if (email === null) return c.json({ ok: false, code: 'invalid', message: 'Kundens e-mailadresse er ugyldig.' }, 400);
  const approvalEmail = str(b['approver_email'], 254);
  const approvalPin = typeof b['approver_pin'] === 'string' ? b['approver_pin'].slice(0, 8) : '';

  let result: CreateSaleResult;
  try {
    result = await createSale(c.env, pos, {
      key,
      staff: me(c),
      lines,
      orderDiscount,
      customer: {
        id: Number.isSafeInteger(customer.id) && (customer.id as number) > 0 ? (customer.id as number) : null,
        name: str(customer.name, 100),
        email: email ?? '',
        phone: str(customer.phone, 30),
        company: str(customer.company, 100),
      },
      note: str(b['note'], 1000, true),
      payments,
      expectedTotal: expected,
      approval: approvalEmail || approvalPin ? { email: approvalEmail, pin: approvalPin } : null,
    });
  } catch (err) {
    c.executionCtx.waitUntil(logError(c.env.DB, 'Kasse: salg', err));
    return c.json({ ok: false, code: 'error', message: 'Salget kunne ikke gemmes. Intet er registreret. Prøv igen.' }, 500);
  }
  if (!result.ok) {
    const status = result.code === 'stock' || result.code === 'price_changed' || result.code === 'unknown_product' ? 409 : result.code.startsWith('approval') ? 403 : 400;
    return c.json(result, status);
  }
  const d = (await getSale(c.env.DB, result.saleId))!;
  return c.json({ ok: true, existing: !!result.existing, stripeError: result.stripeError ?? null, sale: summary(d) });
});

kasse.get('/api/salg/:id{[0-9]+}/status', async (c) => {
  const pos = await getPosSettings(c.env.DB);
  const d = await loadSale(c, pos);
  if (!d) return c.json({ ok: false, message: 'Salget findes ikke.' }, 404);
  const st = await syncCardPayment(c.env, pos, d.sale.id, me(c).email);
  return c.json({ ok: true, card: st, sale: summary((await getSale(c.env.DB, d.sale.id))!) });
});

kasse.post('/api/salg/:id{[0-9]+}/kort', async (c) => {
  const pos = await getPosSettings(c.env.DB);
  const d = await loadSale(c, pos);
  if (!d) return c.json({ ok: false, message: 'Salget findes ikke.' }, 404);
  if (d.sale.status !== 'afventer') return c.json({ ok: true, sale: summary(d) });
  const e = await startStripePayment(c.env, pos, d.sale.id);
  return c.json({ ok: !e, message: e ?? '', sale: summary((await getSale(c.env.DB, d.sale.id))!) });
});

kasse.post('/api/salg/:id{[0-9]+}/annuller', async (c) => {
  const pos = await getPosSettings(c.env.DB);
  const d = await loadSale(c, pos);
  if (!d) return c.json({ ok: false, message: 'Salget findes ikke.' }, 404);
  const b = await c.req.parseBody();
  const r = await cancelPendingSale(c.env, pos, d.sale.id, me(c).email, str(b['reason'], 200) || 'Annulleret i kassen');
  const fresh = (await getSale(c.env.DB, d.sale.id))!;
  if (!r.ok) return c.json({ ok: false, message: r.message, sale: summary(fresh) }, 409);
  return c.json({ ok: true, completed: !!r.completed, sale: summary(fresh) });
});

async function sendReceipt(c: C, pos: PosSettings, d: SaleDetail, to: string): Promise<boolean> {
  const names = await staffNames(c.env.DB);
  try {
    const ok = await sendEmail(c.env, receiptEmail(d, pos, to, names.get(d.sale.staff_email.toLowerCase()) ?? ''));
    if (ok) await audit(c.env.DB, { action: 'Kvittering sendt', saleId: d.sale.id, detail: to, actor: me(c).email });
    return ok;
  } catch (err) {
    c.executionCtx.waitUntil(logError(c.env.DB, 'Kasse: kvittering på e-mail', err));
    return false;
  }
}

kasse.post('/api/salg/:id{[0-9]+}/send', async (c) => {
  const pos = await getPosSettings(c.env.DB);
  const d = await loadSale(c, pos);
  if (!d) return c.json({ ok: false, message: 'Salget findes ikke.' }, 404);
  const b = await c.req.parseBody();
  const to = normalizeEmail(b['email']);
  if (!to) return c.json({ ok: false, message: 'Skriv en gyldig e-mailadresse.' }, 400);
  if (!c.env.RESEND_API_KEY) return c.json({ ok: false, message: 'E-mail er ikke sat op.' }, 400);
  const ok = await sendReceipt(c, pos, d, to);
  return c.json(ok ? { ok: true, message: `Kvitteringen er sendt til ${to}.` } : { ok: false, message: 'Kvitteringen kunne ikke sendes. Prøv igen.' }, ok ? 200 : 502);
});

// ---------------- Salgshistorik ----------------

kasse.get('/salg', async (c) => {
  const pos = await getPosSettings(c.env.DB);
  const q = str(c.req.query('q'), 100);
  const fra = isDate(c.req.query('fra')) ? c.req.query('fra')! : '';
  const til = isDate(c.req.query('til')) ? c.req.query('til')! : '';
  const medarbejder = str(c.req.query('medarbejder'), 254);
  const betaling = (['kontant', 'kort_terminal', 'stripe_terminal', 'andet'] as PaymentMethod[]).find((m) => m === c.req.query('betaling')) ?? null;
  const status = (SALE_STATUSES as string[]).includes(c.req.query('status') ?? '') ? (c.req.query('status') as SaleStatus) : null;
  const side = Math.max(1, intOf(c.req.query('side') ?? '', 1, 100000) ?? 1);
  const onlyOwn = !can(role(c), 'pos.sales.all') && !pos.cashier_sees_all;
  const [rows, names, staffEmails] = await Promise.all([
    listSales(c.env.DB, {
      q: q || undefined,
      from: fra ? dayStart(fra) : undefined,
      to: til ? dayStart(addDays(til, 1)) : undefined,
      staff: medarbejder || undefined,
      method: betaling,
      status,
      onlyStaff: onlyOwn ? me(c).email : null,
      limit: PAGE_SIZE + 1,
      offset: (side - 1) * PAGE_SIZE,
    }),
    staffNames(c.env.DB),
    saleStaffEmails(c.env.DB),
  ]);
  return page(
    c,
    'Salgshistorik',
    salesPage({
      role: role(c),
      rows: rows.slice(0, PAGE_SIZE),
      names,
      staffEmails,
      filter: { q, fra, til, medarbejder, betaling: betaling ?? '', status: status ?? '' },
      page: side,
      hasMore: rows.length > PAGE_SIZE,
      onlyOwn,
    }),
  );
});

async function saleView(c: C, d: SaleDetail, extra: { error?: string; status?: 400 | 403 | 409 | 502; email?: string } = {}) {
  const names = await staffNames(c.env.DB);
  return page(
    c,
    `Kassesalg #${d.sale.number}`,
    saleDetailPage({
      csrf: c.get('csrf'),
      staff: me(c),
      d,
      names,
      canEmail: !!c.env.RESEND_API_KEY,
      refundKey: randomToken(18),
      flash: saleFlash(c.req.query('besked')),
      error: extra.error ? alert('err', extra.error) : '',
      values: { email: extra.email },
    }),
    { status: extra.status },
  );
}

kasse.get('/salg/:id{[0-9]+}', async (c) => {
  const d = await loadSale(c, await getPosSettings(c.env.DB));
  return d ? saleView(c, d) : notFound(c);
});

kasse.get('/salg/:id{[0-9]+}/kvittering', async (c) => {
  const pos = await getPosSettings(c.env.DB);
  const d = await loadSale(c, pos);
  if (!d) return notFound(c);
  const names = await staffNames(c.env.DB);
  return c.html(
    receiptPage({ d, pos, staffName: names.get(d.sale.staff_email.toLowerCase()) ?? '', copy: c.req.query('kopi') === '1', print: c.req.query('print') === '1' }),
  );
});

kasse.post('/salg/:id{[0-9]+}/send', async (c) => {
  const pos = await getPosSettings(c.env.DB);
  const d = await loadSale(c, pos);
  if (!d) return notFound(c);
  const b = await c.req.parseBody();
  const to = normalizeEmail(b['email']);
  if (!to) return saleView(c, d, { error: 'Skriv en gyldig e-mailadresse.', status: 400, email: str(b['email'], 254) });
  if (!c.env.RESEND_API_KEY) return saleView(c, d, { error: 'E-mail er ikke sat op.', status: 400 });
  if (!(await sendReceipt(c, pos, d, to))) return saleView(c, d, { error: 'Kvitteringen kunne ikke sendes. Prøv igen.', status: 502, email: to });
  return c.redirect(`/admin/kasse/salg/${d.sale.id}?besked=sendt`, 303);
});

kasse.post('/salg/:id{[0-9]+}/tjek', async (c) => {
  const pos = await getPosSettings(c.env.DB);
  const d = await loadSale(c, pos);
  if (!d) return notFound(c);
  const st = await syncCardPayment(c.env, pos, d.sale.id, me(c).email);
  if (st.state === 'betalt') return c.redirect(`/admin/kasse/salg/${d.sale.id}?besked=betalt`, 303);
  return saleView(c, (await getSale(c.env.DB, d.sale.id))!, { error: 'message' in st ? st.message : 'Salget er annulleret.', status: 409 });
});

kasse.post('/salg/:id{[0-9]+}/annuller', async (c) => {
  const pos = await getPosSettings(c.env.DB);
  const d = await loadSale(c, pos);
  if (!d) return notFound(c);
  const r = await cancelPendingSale(c.env, pos, d.sale.id, me(c).email, 'Annulleret fra salgshistorikken');
  if (!r.ok) return saleView(c, (await getSale(c.env.DB, d.sale.id))!, { error: r.message, status: 409 });
  return c.redirect(`/admin/kasse/salg/${d.sale.id}?besked=${r.completed ? 'betalt' : 'annulleret'}`, 303);
});

kasse.post('/salg/:id{[0-9]+}/refunder', async (c) => {
  const pos = await getPosSettings(c.env.DB);
  const d = await loadSale(c, pos);
  if (!d) return notFound(c);
  const b = await c.req.parseBody();
  const key = typeof b['key'] === 'string' && KEY_RE.test(b['key']) ? b['key'] : null;
  if (!key) return saleView(c, d, { error: 'Ugyldig anmodning. Prøv igen.', status: 400 });
  const lines: { lineId: number; quantity: number }[] = [];
  for (const [k, raw] of Object.entries(b)) {
    const m = /^rq_(\d{1,9})$/.exec(k);
    if (!m || typeof raw !== 'string' || !raw.trim()) continue;
    const q = intOf(raw, 0, 9999);
    if (q === null) return saleView(c, d, { error: 'Skriv antal som hele tal.', status: 400 });
    if (q > 0) lines.push({ lineId: Number(m[1]), quantity: q });
  }
  const approvalEmail = str(b['approver_email'], 254);
  const approvalPin = typeof b['approver_pin'] === 'string' ? b['approver_pin'].slice(0, 8) : '';
  let r;
  try {
    r = await refundSale(c.env, pos, {
      saleId: d.sale.id,
      key,
      staff: me(c),
      lines,
      restock: b['restock'] === '1',
      reason: str(b['reason'], 200),
      paymentId: intOf(b['payment'], 1, Number.MAX_SAFE_INTEGER),
      approval: approvalEmail || approvalPin ? { email: approvalEmail, pin: approvalPin } : null,
    });
  } catch (err) {
    c.executionCtx.waitUntil(logError(c.env.DB, 'Kasse: refusion', err));
    return saleView(c, (await getSale(c.env.DB, d.sale.id))!, { error: 'Refusionen kunne ikke gennemføres. Tjek salget, og prøv igen.', status: 502 });
  }
  if (!r.ok) {
    const status = r.code.startsWith('approval') ? 403 : r.code === 'stripe' ? 502 : r.code === 'conflict' ? 409 : 400;
    return saleView(c, (await getSale(c.env.DB, d.sale.id))!, { error: r.message, status });
  }
  return c.redirect(`/admin/kasse/salg/${d.sale.id}?besked=refunderet`, 303);
});

// ---------------- Ydelser og varer ----------------

kasse.get('/varer/:id{[0-9]+}/billede', async (c) => {
  const img = await getItemImage(c.env.DB, Number(c.req.param('id')));
  if (!img) return c.body(null, 404);
  return c.body(img.data, 200, { 'Content-Type': img.type, 'Cache-Control': 'private, max-age=86400' });
});

kasse.get('/varer', need('pos.items'), async (c) => {
  const flash = c.req.query('besked') === 'gemt' ? alert('ok', 'Gemt.') : '';
  return page(c, 'Ydelser og varer', itemsPage({ role: role(c), items: await listItems(c.env.DB), q: str(c.req.query('q'), 80), flash }));
});

async function itemView(c: C, id: number | null, extra: { values?: ItemFormValues; errors?: Record<string, string>; status?: 400 | 404; flash?: H | '' } = {}) {
  const item = id === null ? null : await getItem(c.env.DB, id);
  if (id !== null && !item) return page(c, 'Ikke fundet', errorPage('Findes ikke', 'Ydelsen eller varen findes ikke.', { href: '/admin/kasse/varer', label: 'Til ydelser og varer' }), { status: 404 });
  const [categories, movements, names] = await Promise.all([
    itemCategories(c.env.DB),
    item?.track_stock ? listMovements(c.env.DB, item.id) : Promise.resolve([]),
    staffNames(c.env.DB),
  ]);
  return page(
    c,
    item ? item.name : 'Ny ydelse eller vare',
    itemFormPage({ csrf: c.get('csrf'), role: role(c), item, values: extra.values ?? itemFormValues(item), categories, movements, names, errors: extra.errors, flash: extra.flash }),
    { status: extra.status },
  );
}

kasse.get('/varer/ny', need('pos.items'), (c) => itemView(c, null));
kasse.get('/varer/:id{[0-9]+}', need('pos.items'), (c) =>
  itemView(c, Number(c.req.param('id')), { flash: c.req.query('besked') === 'gemt' ? alert('ok', 'Gemt.') : c.req.query('besked') === 'lager' ? alert('ok', 'Lageret er reguleret.') : '' }),
);

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

/** Tjekker de første bytes, så kun rigtige PNG-, JPEG- og WebP-filer gemmes. */
function sniffImage(buf: ArrayBuffer): string | null {
  const b = new Uint8Array(buf.slice(0, 12));
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

async function saveItemForm(c: C, id: number | null) {
  const b = await c.req.parseBody();
  const errors: Record<string, string> = {};
  const values: ItemFormValues = {
    sku: str(b['sku'], 40),
    barcode: str(b['barcode'], 40),
    name: str(b['name'], 120),
    category: str(b['category'], 40),
    description: str(b['description'], 500, true),
    price: str(b['price'], 20),
    unit: str(b['unit'], 20) || 'stk.',
    track_stock: b['track_stock'] === '1',
    stock: str(b['stock'], 10) || '0',
    active: b['active'] === '1',
    sort_order: str(b['sort_order'], 6) || '0',
  };
  if (!values.name) errors['name'] = 'Skriv et navn.';
  const price = krToOere(values.price);
  if (price === null) errors['price'] = 'Skriv prisen i kroner, fx 1.495 eller 99,50.';
  if (values.sku && !/^[A-Za-z0-9._\-\/]+$/.test(values.sku)) errors['sku'] = 'Brug bogstaver, tal, punktum, bindestreg eller skråstreg.';
  if (values.barcode && !/^[A-Za-z0-9\-]+$/.test(values.barcode)) errors['barcode'] = 'Stregkoden må kun indeholde bogstaver og tal.';
  const sort = intOf(values.sort_order, -9999, 9999);
  if (sort === null) errors['sort_order'] = 'Skriv et helt tal.';
  const stock = intOf(values.stock, 0, 999999);
  if (id === null && values.track_stock && stock === null) errors['stock'] = 'Skriv et helt tal (0 eller mere).';
  let image: { type: string; data: ArrayBuffer } | null = null;
  const file = b['image'];
  if (file instanceof File && file.size > 0) {
    if (file.size > 300 * 1024) errors['image'] = 'Billedet må højst fylde 300 KB.';
    else {
      const data = await file.arrayBuffer();
      const type = sniffImage(data);
      if (!type || !IMAGE_TYPES.includes(type)) errors['image'] = 'Vælg et PNG-, JPEG- eller WebP-billede.';
      else image = { type, data };
    }
  }
  if (Object.keys(errors).length) return itemView(c, id, { values, errors, status: 400 });
  const input: ItemInput = {
    sku: values.sku || (id === null ? `tmp-${randomToken(8)}` : (await getItem(c.env.DB, id))!.sku),
    barcode: values.barcode,
    name: values.name,
    category: values.category,
    description: values.description,
    price: price!,
    unit: values.unit,
    track_stock: values.track_stock,
    active: values.active,
    sort_order: sort!,
  };
  const r = await saveItem(c.env.DB, id, input, { initialStock: stock ?? 0, image, removeImage: b['remove_image'] === '1', actor: me(c).email });
  if (!r.ok) return itemView(c, id, { values, errors: { [r.field]: r.message }, status: 400 });
  await audit(c.env.DB, { action: id === null ? 'Vare oprettet' : 'Vare ændret', detail: `${input.sku} · ${input.name} · ${(input.price / 100).toLocaleString('da-DK')} kr.${input.active ? '' : ' · slået fra'}`, actor: me(c).email });
  return c.redirect(`/admin/kasse/varer/${r.id}?besked=gemt`, 303);
}

kasse.post('/varer', need('pos.items'), (c) => saveItemForm(c, null));
kasse.post('/varer/:id{[0-9]+}', need('pos.items'), async (c) => {
  const id = Number(c.req.param('id'));
  if (!(await getItem(c.env.DB, id))) return itemView(c, id);
  return saveItemForm(c, id);
});

kasse.post('/varer/:id{[0-9]+}/lager', need('pos.items'), async (c) => {
  const id = Number(c.req.param('id'));
  const item = await getItem(c.env.DB, id);
  if (!item || !item.track_stock) return itemView(c, id, { errors: { stock_adjust: 'Varen har ikke lagerstyring.' }, status: 400 });
  const b = await c.req.parseBody();
  const mode = b['mode'] === 'set' ? 'set' : 'add';
  const value = intOf(b['value'], mode === 'set' ? 0 : -999999, 999999);
  const reason = str(b['reason'], 100);
  if (value === null || (mode === 'add' && value === 0)) return itemView(c, id, { errors: { stock_adjust: 'Skriv et antal.' }, status: 400 });
  if (!reason) return itemView(c, id, { errors: { stock_adjust: 'Skriv en årsag.' }, status: 400 });
  if (!(await adjustStock(c.env.DB, id, mode, value, reason, me(c).email))) {
    return itemView(c, id, { errors: { stock_adjust: 'Lageret kan ikke blive negativt.' }, status: 400 });
  }
  await audit(c.env.DB, { action: 'Lager reguleret', detail: `${item.sku}: ${mode === 'set' ? `sat til ${value}` : value > 0 ? `+${value}` : value} (${reason})`, actor: me(c).email });
  return c.redirect(`/admin/kasse/varer/${id}?besked=lager`, 303);
});

// ---------------- Rapporter ----------------

kasse.get('/rapporter', need('pos.reports'), async (c) => {
  const today = localDate(Math.floor(Date.now() / 1000));
  let fra = isDate(c.req.query('fra')) ? c.req.query('fra')! : today;
  let til = isDate(c.req.query('til')) ? c.req.query('til')! : fra;
  if (til < fra) [fra, til] = [til, fra];
  if (addDays(fra, 366) < til) fra = addDays(til, -366);
  const [r, names] = await Promise.all([buildReport(c.env.DB, fra, til), staffNames(c.env.DB)]);
  const monthStart = today.slice(0, 8) + '01';
  const presets = [
    { label: 'I dag', fra: today, til: today },
    { label: 'I går', fra: addDays(today, -1), til: addDays(today, -1) },
    { label: 'Seneste 7 dage', fra: addDays(today, -6), til: today },
    { label: 'Denne måned', fra: monthStart, til: today },
    { label: 'Seneste 30 dage', fra: addDays(today, -29), til: today },
  ];
  return page(c, 'Rapporter', reportsPage({ role: role(c), r, names, presets }));
});

// ---------------- Indstillinger ----------------

async function settingsView(c: C, s: PosSettings, extra: { errors?: Record<string, string>; status?: 400 } = {}) {
  const [auditRows, names] = await Promise.all([listAudit(c.env.DB, 50), staffNames(c.env.DB)]);
  return page(
    c,
    'Indstillinger for kassen',
    posSettingsPage({
      csrf: c.get('csrf'),
      role: role(c),
      s,
      stripeKey: !!c.env.STRIPE_SECRET_KEY,
      emailReady: !!c.env.RESEND_API_KEY,
      audit: auditRows,
      names,
      errors: extra.errors,
      flash: c.req.query('besked') === 'gemt' ? alert('ok', 'Indstillingerne er gemt.') : '',
    }),
    { status: extra.status },
  );
}

kasse.get('/indstillinger', need('pos.settings'), async (c) => settingsView(c, await getPosSettings(c.env.DB)));

kasse.post('/indstillinger', need('pos.settings'), async (c) => {
  const b = await c.req.parseBody();
  const errors: Record<string, string> = {};
  const bool = (k: string) => b[k] === '1';
  const pctField = (k: string, def: number) => {
    const raw = str(b[k], 10).replace(',', '.');
    const v = raw === '' ? def : Number(raw);
    if (!Number.isFinite(v) || v < 0 || v > 100) errors[k] = 'Skriv et tal mellem 0 og 100.';
    return Number.isFinite(v) ? Math.round(v * 100) / 100 : def;
  };
  const width = b['receipt_width'];
  const s: PosSettings = {
    ...DEFAULT_POS_SETTINGS,
    store_name: str(b['store_name'], 80) || DEFAULT_POS_SETTINGS.store_name,
    store_address: str(b['store_address'], 120),
    store_phone: str(b['store_phone'], 30),
    store_email: str(b['store_email'], 120),
    store_website: str(b['store_website'], 120),
    cvr: str(b['cvr'], 20),
    receipt_header: str(b['receipt_header'], 300, true),
    receipt_footer: str(b['receipt_footer'], 300, true),
    receipt_width: width === '58mm' || width === 'a4' ? width : '80mm',
    receipt_auto_print: bool('receipt_auto_print'),
    vat_rate: pctField('vat_rate', 25),
    discount_presets: str(b['discount_presets'], 60),
    cashier_max_discount: pctField('cashier_max_discount', 10),
    manager_max_discount: pctField('manager_max_discount', 50),
    cash_enabled: bool('cash_enabled'),
    cash_rounding: bool('cash_rounding'),
    card_terminal_enabled: bool('card_terminal_enabled'),
    card_terminal_label: str(b['card_terminal_label'], 40) || 'Kort (terminal)',
    stripe_reader_id: str(b['stripe_reader_id'], 60),
    other_methods: str(b['other_methods'], 500, true),
    show_out_of_stock: bool('show_out_of_stock'),
    cashier_sees_all: bool('cashier_sees_all'),
    scanner_enabled: bool('scanner_enabled'),
    scanner_auto_add: bool('scanner_auto_add'),
  };
  if (s.cvr && !/^(DK)?\s?\d{8}$/i.test(s.cvr)) errors['cvr'] = 'Et CVR-nummer har 8 cifre.';
  if (s.store_email && !normalizeEmail(s.store_email)) errors['store_email'] = 'Skriv en gyldig e-mailadresse.';
  if (s.stripe_reader_id && !/^tmr_[A-Za-z0-9]+$/.test(s.stripe_reader_id)) errors['stripe_reader_id'] = 'Kortlæserens ID starter med tmr_';
  if (s.manager_max_discount < s.cashier_max_discount) errors['manager_max_discount'] = 'Lederens grænse skal være mindst lige så høj som kasseassistentens.';
  if (s.discount_presets && !discountPresets(s).length) errors['discount_presets'] = 'Skriv procenter adskilt af komma, fx 5, 10, 15.';
  if (!s.cash_enabled && !s.card_terminal_enabled && !s.stripe_reader_id && !otherMethods(s).length) errors['methods'] = 'Slå mindst én betalingsform til.';
  if (Object.keys(errors).length) return settingsView(c, s, { errors, status: 400 });
  const before = await getPosSettings(c.env.DB);
  await savePosSettings(c.env.DB, s);
  const changed = (Object.keys(s) as (keyof PosSettings)[]).filter((k) => s[k] !== before[k]);
  if (changed.length) await audit(c.env.DB, { action: 'Indstillinger ændret', detail: changed.join(', '), actor: me(c).email });
  return c.redirect('/admin/kasse/indstillinger?besked=gemt', 303);
});

// ---------------- Personale og PIN ----------------

async function staffView(c: C, extra: { errors?: Record<string, string>; values?: { email: string; name: string; role: Role }; status?: 400 } = {}) {
  const flashes: Record<string, string> = { gemt: 'Medarbejderen er gemt.', pin: 'PIN-koden er gemt.' };
  const msg = flashes[c.req.query('besked') ?? ''];
  return page(
    c,
    'Personale',
    staffPage({
      csrf: c.get('csrf'),
      role: role(c),
      me: me(c).email,
      staff: await listStaff(c.env.DB),
      envAdmins: [...parseAdminEmails(c.env)],
      values: extra.values,
      errors: extra.errors,
      flash: msg && !extra.errors ? alert('ok', msg) : '',
    }),
    { status: extra.status },
  );
}

kasse.get('/personale', need('staff.manage'), (c) => staffView(c));

kasse.post('/personale', need('staff.manage'), async (c) => {
  const b = await c.req.parseBody();
  const email = normalizeEmail(b['email']);
  const name = str(b['name'], 80);
  const r = b['role'];
  const values = { email: str(b['email'], 254), name, role: isRole(r) ? r : ('cashier' as Role) };
  if (!email) return staffView(c, { errors: { email: 'Skriv en gyldig e-mailadresse.' }, values, status: 400 });
  if (!isRole(r)) return staffView(c, { errors: { form: 'Vælg en rolle.' }, values, status: 400 });
  if (email === me(c).email) return staffView(c, { errors: { form: 'Du kan ikke ændre din egen rolle eller adgang.' }, values, status: 400 });
  if (isAdmin(c.env, email)) return staffView(c, { errors: { form: 'Adresser i ADMIN_EMAILS er altid administratorer.' }, values, status: 400 });
  const existing = await getStaff(c.env.DB, email);
  if (b['new'] === '1' && existing) return staffView(c, { errors: { email: 'Medarbejderen findes allerede.' }, values, status: 400 });
  const active = b['active'] !== '0';
  await upsertStaff(c.env.DB, { email, name: name || existing?.name || '', role: r, active });
  await audit(c.env.DB, { action: existing ? 'Medarbejder ændret' : 'Medarbejder tilføjet', detail: `${email}: ${r}${active ? '' : ', deaktiveret'}`, actor: me(c).email });
  if (!active) await c.env.DB.prepare('DELETE FROM sessions WHERE email = ?').bind(email).run();
  return c.redirect('/admin/kasse/personale?besked=gemt', 303);
});

kasse.post('/personale/pin', need('staff.manage'), async (c) => {
  const b = await c.req.parseBody();
  const email = normalizeEmail(b['email']);
  const pin = typeof b['pin'] === 'string' ? b['pin'].trim() : '';
  if (!email || !(await getStaff(c.env.DB, email))) return staffView(c, { errors: { form: 'Medarbejderen findes ikke.' }, status: 400 });
  if (!pinValid(pin)) return staffView(c, { errors: { form: 'En PIN-kode er 4-8 cifre.' }, status: 400 });
  await setPin(c.env.DB, email, pin, 'cashier');
  await audit(c.env.DB, { action: 'PIN-kode sat', detail: email, actor: me(c).email });
  return c.redirect('/admin/kasse/personale?besked=pin', 303);
});

kasse.get('/pin', need('pos.refund'), async (c) => {
  const row = await getStaff(c.env.DB, me(c).email);
  return page(c, 'Min PIN-kode', pinPage({ csrf: c.get('csrf'), role: role(c), hasPin: !!row?.pin_hash, flash: c.req.query('besked') === 'gemt' ? alert('ok', 'Din PIN-kode er gemt.') : '' }));
});

kasse.post('/pin', need('pos.refund'), async (c) => {
  const b = await c.req.parseBody();
  const pin = typeof b['pin'] === 'string' ? b['pin'].trim() : '';
  if (!pinValid(pin)) {
    const row = await getStaff(c.env.DB, me(c).email);
    return page(c, 'Min PIN-kode', pinPage({ csrf: c.get('csrf'), role: role(c), hasPin: !!row?.pin_hash, error: 'En PIN-kode er 4-8 cifre.' }), { status: 400 });
  }
  await setPin(c.env.DB, me(c).email, pin, role(c));
  await audit(c.env.DB, { action: 'PIN-kode sat', detail: me(c).email, actor: me(c).email });
  return c.redirect('/admin/kasse/pin?besked=gemt', 303);
});

export default kasse;
