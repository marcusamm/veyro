import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { sha256Hex } from '../lib/crypto';
import { MAX_IMPORT_BYTES, exportCsv, parseImport, planImport, TEMPLATE_CSV } from '../lib/csv';
import { loginEmail, orderReceivedEmail, sendEmail, sendLater, statusEmail } from '../lib/email';
import { normalizeEmail, parseIntStrict, parseKr, str } from '../lib/format';
import { notifyLowStock } from '../lib/notify';
import {
  STATUS_LABEL,
  addOrderNote,
  countByStatus,
  createOrder,
  type CheckoutInput,
  getOrder,
  getOrderEvents,
  getOrderLines,
  isStatus,
  listOrders,
  recentStatusEvents,
  revenueSince,
  setOrderStatus,
} from '../lib/orders';
import {
  adjustStock,
  applyImport,
  createProduct,
  deleteProduct,
  getProduct,
  getProductsByIds,
  isConstraintError,
  listCategories,
  listMovements,
  listProducts,
  productsBySku,
  recentManualMovements,
  skuValid,
  stockOverview,
  updateProduct,
  type ProductInput,
} from '../lib/products';
import { MIN_HISTORY_DAYS, SERVICE_LEVELS, ensureFreshForecast, recomputeForecast, reorderInfo, runReorderAlerts } from '../lib/forecast';
import { DEFAULT_SETTINGS, isHexColor, safeUrl, saveSettings, type Settings } from '../lib/settings';
import {
  consumeLoginToken,
  createLoginToken,
  createSession,
  destroySession,
  isAdmin,
  rateLimit,
  requireAdmin,
  safeNext,
} from '../lib/session';
import { renderAdmin } from '../render';
import {
  adminErrorPage,
  dashboardPage,
  flashMessage,
  historyPage,
  importPage,
  importPreviewPage,
  linkInvalidPage,
  loginPage,
  loginSentPage,
  newOrderPage,
  orderDetailPage,
  ordersPage,
  productEditPage,
  productNewPage,
  productValues,
  productsPage,
  reorderPage,
  settingsPage,
  verifyPage,
  type ProductFormValues,
  type StaffOrderValues,
} from '../views/admin';
import { alert } from '../views/layout';
import { appPage } from '../views/shop';
import { html } from 'hono/html';

const admin = new Hono<AppEnv>();
const PAGE_SIZE = 50;

function appUrl(env: { APP_URL: string }): string {
  return env.APP_URL.replace(/\/+$/, '');
}

function actor(c: Context<AppEnv>): string {
  return c.get('session')!.email;
}

// ---------------- Login (magic link) ----------------

admin.get('/login', (c) => {
  const next = safeNext(c.req.query('next'));
  if (c.get('session')) return c.redirect(next ?? '/admin', 303);
  const info = c.req.query('besked') === 'logget_ud' ? 'Du er logget ud.' : null;
  return renderAdmin(c, 'Log ind', loginPage({ csrf: c.get('csrf'), info, next }));
});

admin.post('/login', async (c) => {
  const body = await c.req.parseBody();
  const next = safeNext(c.req.query('next'));
  const email = normalizeEmail(body['email']);
  if (!email) {
    return renderAdmin(c, 'Log ind', loginPage({ csrf: c.get('csrf'), email: str(body['email'], 254), error: 'Indtast en gyldig e-mailadresse.', next }), { status: 400 });
  }
  // Rate limiting pr. IP og pr. e-mail (hashet). Svaret er det samme, uanset om e-mailen har adgang.
  const ip = c.req.header('CF-Connecting-IP') ?? 'ukendt';
  const ipOk = await rateLimit(c.env.DB, 'login-ip:' + (await sha256Hex(ip)), 10, 15 * 60);
  const emailOk = await rateLimit(c.env.DB, 'login-email:' + (await sha256Hex(email)), 5, 15 * 60);
  if (!ipOk || !emailOk) {
    return renderAdmin(c, 'Log ind', loginPage({ csrf: c.get('csrf'), email, error: 'For mange forsøg. Vent 15 minutter, og prøv igen.', next }), { status: 429 });
  }
  let devLink: string | null = null;
  if (isAdmin(c.env, email)) {
    const token = await createLoginToken(c.env, email);
    const link = `${appUrl(c.env)}/admin/login/bekraeft?token=${encodeURIComponent(token)}${next ? `&next=${encodeURIComponent(next)}` : ''}`;
    if (c.env.RESEND_API_KEY) {
      const s = c.get('settings');
      c.executionCtx.waitUntil(
        sendEmail(c.env, { to: email, ...loginEmail(link, s) }, s).catch((err) => console.error('Login-mail fejlede:', (err as Error).message)),
      );
    } else {
      console.log(`[DEV] Ingen RESEND_API_KEY – login-link: ${link}`);
      if (c.env.DEV_MODE === '1') devLink = link;
    }
  }
  return renderAdmin(c, 'Tjek din indbakke', loginSentPage(devLink));
});

// GET viser kun en knap; selve login sker ved POST, så e-mail-scannere ikke bruger engangslinket.
admin.get('/login/bekraeft', (c) => {
  const token = c.req.query('token') ?? '';
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) return renderAdmin(c, 'Ugyldigt link', linkInvalidPage(), { status: 400 });
  return renderAdmin(c, 'Bekræft login', verifyPage(c.get('csrf'), token, safeNext(c.req.query('next'))));
});

admin.post('/login/bekraeft', async (c) => {
  const body = await c.req.parseBody();
  const email = await consumeLoginToken(c.env, typeof body['token'] === 'string' ? body['token'] : '');
  if (!email || !isAdmin(c.env, email)) return renderAdmin(c, 'Ugyldigt link', linkInvalidPage(), { status: 400 });
  if (c.get('session')) await destroySession(c);
  await createSession(c, email);
  return c.redirect(safeNext(body['next']) ?? '/admin', 303);
});

admin.post('/logout', async (c) => {
  await destroySession(c);
  return c.redirect('/admin/login?besked=logget_ud', 303);
});

// Alt herunder kræver login
admin.use('*', requireAdmin);

// ---------------- Oversigt ----------------

admin.get('/', async (c) => {
  const s = c.get('settings');
  const now = Math.floor(Date.now() / 1000);
  const midnight = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Copenhagen' }));
  const sinceMidnight = midnight.getHours() * 3600 + midnight.getMinutes() * 60 + midnight.getSeconds();
  await ensureFreshForecast(c.env.DB, s);
  const [counts, latest, stock, events, manual, today, month, countRow] = await Promise.all([
    countByStatus(c.env.DB),
    listOrders(c.env.DB, { limit: 6, offset: 0 }),
    stockOverview(c.env.DB, s, 50),
    recentStatusEvents(c.env.DB, 6),
    recentManualMovements(c.env.DB, 6),
    revenueSince(c.env.DB, now - sinceMidnight),
    revenueSince(c.env.DB, now - 30 * 86400),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM products').first<{ n: number }>(),
  ]);
  return renderAdmin(
    c,
    'Oversigt',
    dashboardPage({ settings: s, counts, latest, stock, events, manual, today, month, productCount: countRow?.n ?? 0 }),
    { nav: 'oversigt' },
  );
});

admin.get('/app', (c) => renderAdmin(c, 'App', appPage({ settings: c.get('settings'), admin: true }), { nav: 'oversigt' }));

// ---------------- Genbestilling ----------------

admin.get('/genbestilling', async (c) => {
  const s = c.get('settings');
  await ensureFreshForecast(c.env.DB, s);
  const products = await stockOverview(c.env.DB, s, 1000);
  const rank = { now: 0, soon: 1, ok: 2 } as const;
  const rows = products
    .map((p) => ({ p, r: reorderInfo(p, s) }))
    .sort((a, b) => rank[a.r.urgency] - rank[b.r.urgency] || (a.r.daysToReorder ?? 1e9) - (b.r.daysToReorder ?? 1e9) || a.p.name.localeCompare(b.p.name, 'da'));
  return renderAdmin(
    c,
    'Genbestilling',
    reorderPage({ csrf: c.get('csrf'), settings: s, rows, now: Math.floor(Date.now() / 1000), flash: flashMessage(c.req.query('besked')) }),
    { nav: 'genbestilling' },
  );
});

admin.post('/genbestilling/beregn', async (c) => {
  const s = c.get('settings');
  // Nulstil varsler, så alle varer, der skal bestilles hjem, kommer med i e-mailen
  await c.env.DB.prepare('UPDATE products SET reorder_alerted = 0').run();
  await runReorderAlerts(c.env, c.executionCtx, s);
  return c.redirect('/admin/genbestilling?besked=beregnet', 303);
});

// ---------------- Ordrer ----------------

admin.get('/ordrer', async (c) => {
  const status = isStatus(c.req.query('status')) ? (c.req.query('status') as never) : null;
  const q = str(c.req.query('q'), 100);
  const page = Math.max(1, parseIntStrict(c.req.query('side') ?? '') ?? 1);
  const [rows, counts] = await Promise.all([
    listOrders(c.env.DB, { status, q: q || undefined, limit: PAGE_SIZE + 1, offset: (page - 1) * PAGE_SIZE }),
    countByStatus(c.env.DB),
  ]);
  return renderAdmin(
    c,
    'Ordrer',
    ordersPage({ orders: rows.slice(0, PAGE_SIZE), counts, status, q, page, hasMore: rows.length > PAGE_SIZE }),
    { nav: 'ordrer' },
  );
});

async function orderView(c: Context<AppEnv>, id: number, extra: { error?: ReturnType<typeof alert> | null; status?: 200 | 409 } = {}) {
  const order = await getOrder(c.env.DB, id);
  if (!order) return renderAdmin(c, 'Ikke fundet', adminErrorPage('Ordren findes ikke', 'Den er måske slettet.'), { status: 404, nav: 'ordrer' });
  const [lines, events] = await Promise.all([getOrderLines(c.env.DB, id), getOrderEvents(c.env.DB, id)]);
  const products = await getProductsByIds(c.env.DB, lines.map((l) => l.product_id).filter((x): x is number => x !== null));
  return renderAdmin(
    c,
    `Ordre #${order.number}`,
    orderDetailPage({ csrf: c.get('csrf'), order, lines, events, products, flash: flashMessage(c.req.query('besked')), error: extra.error }),
    { nav: 'ordrer', status: extra.status },
  );
}

const emptyStaffOrder = (): StaffOrderValues => ({
  source: 'telefon',
  customer_name: '',
  company: '',
  customer_phone: '',
  customer_email: '',
  delivery: 'afhentning',
  address: '',
  postcode: '',
  city: '',
  note: '',
  confirm: true,
  send_receipt: true,
});

async function newOrderView(
  c: Context<AppEnv>,
  values: StaffOrderValues,
  quantities: Map<number, number>,
  extra: { errors?: Parameters<typeof newOrderPage>[0]['errors']; short?: ReturnType<typeof alert> | null; status?: 400 | 409 } = {},
) {
  const products = await listProducts(c.env.DB, { activeOnly: true });
  return renderAdmin(
    c,
    'Ny ordre',
    newOrderPage({ csrf: c.get('csrf'), settings: c.get('settings'), products, quantities, values, errors: extra.errors, short: extra.short }),
    { nav: 'ordrer', status: extra.status },
  );
}

admin.get('/ordrer/ny', (c) => newOrderView(c, emptyStaffOrder(), new Map()));

admin.post('/ordrer/ny', async (c) => {
  const s = c.get('settings');
  const body = await c.req.parseBody();
  const src = body['source'];
  const v: StaffOrderValues = {
    source: src === 'email' || src === 'direkte' ? src : 'telefon',
    customer_name: str(body['customer_name'], 100),
    company: str(body['company'], 100),
    customer_phone: str(body['customer_phone'], 30),
    customer_email: str(body['customer_email'], 254),
    delivery: body['delivery'] === 'levering' ? 'levering' : 'afhentning',
    address: str(body['address'], 150),
    postcode: str(body['postcode'], 10),
    city: str(body['city'], 80),
    note: str(body['note'], 1000, { multiline: true }),
    confirm: body['confirm'] === '1',
    send_receipt: body['send_receipt'] === '1',
  };
  const quantities = new Map<number, number>();
  for (const [key, raw] of Object.entries(body)) {
    const m = /^q_(\d{1,9})$/.exec(key);
    if (!m || typeof raw !== 'string' || raw.trim() === '') continue;
    const q = parseIntStrict(raw, { max: 9999 });
    if (q !== null && q > 0) quantities.set(Number(m[1]), q);
  }

  const errors: NonNullable<Parameters<typeof newOrderPage>[0]['errors']> = {};
  const email = v.customer_email ? normalizeEmail(v.customer_email) : '';
  if (!v.customer_name) errors.customer_name = 'Skriv kundens navn.';
  if (email === null) errors.customer_email = 'Indtast en gyldig e-mailadresse, eller lad feltet stå tomt.';
  if (v.customer_phone && !/^[+\d][\d\s\-()]{5,}$/.test(v.customer_phone)) errors.customer_phone = 'Indtast et gyldigt telefonnummer.';
  if (v.delivery === 'levering') {
    if (!v.address) errors.address = 'Skriv leveringsadressen.';
    if (!/^\d{3,5}$/.test(v.postcode.replace(/\s/g, ''))) errors.postcode = 'Indtast et gyldigt postnummer.';
    if (!v.city) errors.city = 'Skriv byen.';
  }
  if (!quantities.size) errors.lines = 'Skriv et antal ud for mindst én vare.';
  if (Object.keys(errors).length) {
    errors.form = 'Ret de markerede felter.';
    return newOrderView(c, v, quantities, { errors, status: 400 });
  }

  const input: CheckoutInput = {
    customer_name: v.customer_name,
    customer_email: email ?? '',
    customer_phone: v.customer_phone,
    company: v.company,
    delivery: v.delivery,
    address: v.address,
    postcode: v.postcode.replace(/\s/g, ''),
    city: v.city,
    note: v.note,
  };
  const cart = [...quantities].map(([productId, quantity]) => ({ productId, quantity }));
  const result = await createOrder(c.env.DB, s, input, cart, { source: v.source, actor: actor(c), confirm: v.confirm });
  if (!result.ok) {
    if (result.reason === 'stock') {
      const short = alert(
        'err',
        html`Der er ikke nok på lager af:
          <ul>${(result.short ?? []).map((l) => html`<li>${l.name} (${l.sku}): ${l.quantity} bestilt, ${l.available ?? 0} disponible</li>`)}</ul>
          Ret antallet, eller regulér lageret først.`,
      );
      return newOrderView(c, v, quantities, { short, status: 409 });
    }
    return newOrderView(c, v, quantities, { errors: { lines: 'Vælg mindst én aktiv vare.' }, status: 400 });
  }
  const order = result.order;
  if (v.send_receipt && order.customer_email) {
    const lines = await getOrderLines(c.env.DB, order.id);
    sendLater(c.env, c.executionCtx, orderReceivedEmail(order, lines, s, `${appUrl(c.env)}/ordre/${order.token}`), s);
  }
  if (order.stock_deducted) await notifyLowStock(c, order.id);
  return c.redirect(`/admin/ordrer/${order.id}?besked=ordre_oprettet`, 303);
});

admin.get('/ordrer/:id{[0-9]+}', (c) => orderView(c, Number(c.req.param('id'))));

admin.post('/ordrer/:id{[0-9]+}/status', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  const next = body['status'];
  if (!isStatus(next)) return c.redirect(`/admin/ordrer/${id}`, 303);
  const result = await setOrderStatus(c.env.DB, id, next, actor(c));
  if (!result.ok) {
    if (result.reason === 'not_found') return orderView(c, id);
    const msg =
      result.reason === 'stock'
        ? alert('err', html`Ordren kan ikke ${next === 'bekraeftet' ? 'bekræftes' : 'opdateres'}, fordi der ikke er nok på lager:
            <ul>${(result.short ?? []).map((s) => html`<li>${s.name} (${s.sku}): bestilt ${s.need}, på lager ${s.stock}</li>`)}</ul>
            Regulér lageret eller annullér ordren.`)
        : result.reason === 'conflict'
          ? alert('warn', 'Ordren er lige blevet ændret af en anden. Se den nye status herunder.')
          : alert('err', `Ordren kan ikke skifte til "${STATUS_LABEL[next]}" herfra.`);
    return orderView(c, id, { error: msg, status: 409 });
  }
  const s = c.get('settings');
  sendLater(c.env, c.executionCtx, statusEmail(result.order, s, `${appUrl(c.env)}/ordre/${result.order.token}`), s);
  if (result.order.stock_deducted) await notifyLowStock(c, id);
  return c.redirect(`/admin/ordrer/${id}?besked=status`, 303);
});

admin.post('/ordrer/:id{[0-9]+}/note', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  if (!(await getOrder(c.env.DB, id))) return orderView(c, id);
  await addOrderNote(c.env.DB, id, str(body['internal_note'], 2000, { multiline: true }), actor(c));
  return c.redirect(`/admin/ordrer/${id}?besked=note`, 303);
});

// ---------------- Varer ----------------

admin.get('/varer', async (c) => {
  const s = c.get('settings');
  await ensureFreshForecast(c.env.DB, s);
  const q = str(c.req.query('q'), 100);
  const category = str(c.req.query('kategori'), 80) || null;
  const low = c.req.query('lav') === '1';
  const [products, categories] = await Promise.all([
    listProducts(c.env.DB, { q: q || undefined, category: category ?? undefined, lowStock: low ? s : undefined }),
    listCategories(c.env.DB, false),
  ]);
  return renderAdmin(
    c,
    'Varer og lager',
    productsPage({ settings: s, products, categories, q, category, low, flash: flashMessage(c.req.query('besked')) }),
    { nav: 'varer' },
  );
});

admin.get('/varer/eksport.csv', async (c) => {
  const products = await listProducts(c.env.DB);
  const date = new Date().toISOString().slice(0, 10);
  return c.body(exportCsv(products), 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="varer-${date}.csv"`,
  });
});

function readProductForm(body: Record<string, unknown>, isNew: boolean): { values: ProductFormValues; input?: ProductInput; stock?: number; errors: Partial<Record<keyof ProductFormValues, string>> } {
  const values: ProductFormValues = {
    sku: str(body['sku'], 64),
    name: str(body['name'], 200),
    category: str(body['category'], 80),
    description: str(body['description'], 2000, { multiline: true }),
    unit: str(body['unit'], 20) || 'stk.',
    price: str(body['price'], 20),
    image_url: str(body['image_url'], 500),
    track_stock: body['track_stock'] === '1',
    stock: str(body['stock'], 12) || '0',
    low_stock_threshold: str(body['low_stock_threshold'], 12),
    lead_time_days: str(body['lead_time_days'], 12),
    active: body['active'] === '1',
    sort_order: str(body['sort_order'], 12) || '0',
  };
  const errors: Partial<Record<keyof ProductFormValues, string>> = {};
  if (!values.name) errors.name = 'Skriv et navn.';
  if (!skuValid(values.sku)) errors.sku = 'Varenummer må kun indeholde bogstaver, tal og - _ . / +';
  const price = parseKr(values.price);
  if (price === null) errors.price = 'Skriv en pris, fx 149,95';
  if (values.image_url && !safeUrl(values.image_url)) errors.image_url = 'Linket skal starte med https://';
  const stock = parseIntStrict(values.stock);
  if (isNew && stock === null) errors.stock = 'Skriv et helt tal på 0 eller mere.';
  const low = values.low_stock_threshold === '' ? null : parseIntStrict(values.low_stock_threshold);
  if (values.low_stock_threshold !== '' && low === null) errors.low_stock_threshold = 'Skriv et helt tal, eller lad feltet stå tomt.';
  const lead = values.lead_time_days === '' ? null : parseIntStrict(values.lead_time_days, { max: 365 });
  if (values.lead_time_days !== '' && lead === null) errors.lead_time_days = 'Skriv antal dage (0-365), eller lad feltet stå tomt.';
  const sort = parseIntStrict(values.sort_order, { signed: true, max: 1_000_000 });
  if (sort === null) errors.sort_order = 'Skriv et helt tal.';
  if (Object.keys(errors).length) return { values, errors };
  return {
    values,
    errors,
    stock: stock ?? 0,
    input: {
      sku: values.sku,
      name: values.name,
      category: values.category,
      description: values.description,
      unit: values.unit,
      price: price!,
      image_url: values.image_url,
      track_stock: values.track_stock,
      low_stock_threshold: low,
      lead_time_days: lead,
      active: values.active,
      sort_order: sort!,
    },
  };
}

admin.get('/varer/ny', async (c) => {
  const categories = await listCategories(c.env.DB, false);
  return renderAdmin(c, 'Ny vare', productNewPage({ csrf: c.get('csrf'), settings: c.get('settings'), categories, values: productValues() }), { nav: 'varer' });
});

admin.post('/varer', async (c) => {
  const body = await c.req.parseBody();
  const form = readProductForm(body, true);
  const again = async (status: 400 | 409) =>
    renderAdmin(
      c,
      'Ny vare',
      productNewPage({ csrf: c.get('csrf'), settings: c.get('settings'), categories: await listCategories(c.env.DB, false), values: form.values, errors: form.errors }),
      { nav: 'varer', status },
    );
  if (!form.input) return again(400);
  try {
    const id = await createProduct(c.env.DB, form.input, form.stock ?? 0, actor(c));
    return c.redirect(`/admin/varer/${id}?besked=oprettet`, 303);
  } catch (err) {
    if (!isConstraintError(err)) throw err;
    form.errors.sku = 'Varenummeret findes allerede.';
    return again(409);
  }
});

async function productView(
  c: Context<AppEnv>,
  id: number,
  extra: { values?: ProductFormValues; errors?: Partial<Record<keyof ProductFormValues, string>>; stockError?: string; status?: 400 | 409 } = {},
) {
  const product = await getProduct(c.env.DB, id);
  if (!product) return renderAdmin(c, 'Ikke fundet', adminErrorPage('Varen findes ikke', 'Den er måske slettet.'), { status: 404, nav: 'varer' });
  const [categories, movements] = await Promise.all([listCategories(c.env.DB, false), listMovements(c.env.DB, { productId: id, limit: 30 })]);
  return renderAdmin(
    c,
    product.name,
    productEditPage({
      csrf: c.get('csrf'),
      settings: c.get('settings'),
      product,
      categories,
      values: extra.values ?? productValues(product),
      movements,
      errors: extra.errors,
      stockError: extra.stockError,
      flash: flashMessage(c.req.query('besked')),
    }),
    { nav: 'varer', status: extra.status },
  );
}

admin.get('/varer/:id{[0-9]+}', async (c) => {
  await ensureFreshForecast(c.env.DB, c.get('settings'));
  return productView(c, Number(c.req.param('id')));
});

admin.post('/varer/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const existing = await getProduct(c.env.DB, id);
  if (!existing) return productView(c, id);
  const body = await c.req.parseBody();
  const form = readProductForm(body, false);
  if (!form.input) return productView(c, id, { values: form.values, errors: form.errors, status: 400 });
  // Slås lagerstyring til på en vare med negativt tal, startes der fra 0
  if (form.input.track_stock && !existing.track_stock && existing.stock < 0) {
    await adjustStock(c.env.DB, id, { mode: 'set', value: 0, reason: 'Lagerstyring slået til', actor: actor(c) });
  }
  try {
    await updateProduct(c.env.DB, id, form.input);
  } catch (err) {
    if (!isConstraintError(err)) throw err;
    return productView(c, id, { values: form.values, errors: { sku: 'Varenummeret bruges af en anden vare.' }, status: 409 });
  }
  return c.redirect(`/admin/varer/${id}?besked=gemt`, 303);
});

admin.post('/varer/:id{[0-9]+}/lager', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.parseBody();
  const mode = body['mode'] === 'set' ? 'set' : 'add';
  const value = parseIntStrict(body['value'], { signed: mode === 'add', max: 10_000_000 });
  if (value === null) return productView(c, id, { stockError: mode === 'set' ? 'Skriv et helt tal på 0 eller mere.' : 'Skriv et helt tal, fx 10 eller -3.', status: 400 });
  const product = await getProduct(c.env.DB, id);
  if (!product) return productView(c, id);
  const reason = str(body['reason'], 120) || (mode === 'set' ? 'Optælling' : 'Manuel regulering');
  const ok = await adjustStock(c.env.DB, id, { mode, value, reason, actor: actor(c) });
  if (!ok) return productView(c, id, { stockError: `Lageret kan ikke blive negativt (der er ${product.stock} på lager).`, status: 409 });
  return c.redirect(`/admin/varer/${id}?besked=lager`, 303);
});

admin.post('/varer/:id{[0-9]+}/slet', async (c) => {
  await deleteProduct(c.env.DB, Number(c.req.param('id')));
  return c.redirect('/admin/varer?besked=slettet', 303);
});

admin.get('/historik', async (c) => {
  const page = Math.max(1, parseIntStrict(c.req.query('side') ?? '') ?? 1);
  const rows = await listMovements(c.env.DB, { limit: 101, offset: (page - 1) * 100 });
  return renderAdmin(c, 'Lagerhistorik', historyPage({ movements: rows.slice(0, 100), page, hasMore: rows.length > 100 }), { nav: 'historik' });
});

// ---------------- Import ----------------

admin.get('/import', (c) => renderAdmin(c, 'Import', importPage({ csrf: c.get('csrf') }), { nav: 'import' }));

admin.get('/import/skabelon.csv', (c) =>
  c.body(TEMPLATE_CSV, 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="vareliste-skabelon.csv"' }),
);

/** Læser CSV fra upload eller tekstfelt. Filer gemt i Windows-1252 (ældre Excel) konverteres. */
async function readImportText(body: Record<string, unknown>): Promise<string | { error: string }> {
  const file = body['file'];
  let text = typeof body['text'] === 'string' ? body['text'] : '';
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_IMPORT_BYTES) return { error: 'Filen er for stor (højst 2 MB).' };
    const buf = await file.arrayBuffer();
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf);
    } catch {
      text = new TextDecoder('windows-1252').decode(buf);
    }
  }
  if (text.length > MAX_IMPORT_BYTES) return { error: 'Teksten er for lang (højst 2 MB).' };
  if (!text.trim()) return { error: 'Vælg en fil eller indsæt tekst.' };
  return text;
}

admin.post('/import', async (c) => {
  const body = await c.req.parseBody();
  const text = await readImportText(body);
  if (typeof text !== 'string') return renderAdmin(c, 'Import', importPage({ csrf: c.get('csrf'), error: text.error }), { nav: 'import', status: 400 });
  const parsed = parseImport(text);
  const { planned, errors } = planImport(parsed, await productsBySku(c.env.DB));
  if (!planned.length && errors.length && errors[0]!.line === 1) {
    return renderAdmin(c, 'Import', importPage({ csrf: c.get('csrf'), error: errors[0]!.message }), { nav: 'import', status: 400 });
  }
  return renderAdmin(
    c,
    'Forhåndsvisning',
    importPreviewPage({ csrf: c.get('csrf'), text, planned, errors, columns: parsed.columns, unknownColumns: parsed.unknownColumns }),
    { nav: 'import' },
  );
});

admin.post('/import/udfoer', async (c) => {
  const body = await c.req.parseBody();
  const text = await readImportText(body);
  if (typeof text !== 'string') return renderAdmin(c, 'Import', importPage({ csrf: c.get('csrf'), error: text.error }), { nav: 'import', status: 400 });
  // Planen beregnes igen mod de aktuelle varer, så ændringer siden forhåndsvisningen tages med
  const { planned } = planImport(parseImport(text), await productsBySku(c.env.DB));
  const result = await applyImport(c.env.DB, planned, actor(c));
  return renderAdmin(c, 'Import', importPage({ csrf: c.get('csrf'), result }), { nav: 'import' });
});

// ---------------- Indstillinger ----------------

admin.get('/indstillinger', (c) =>
  renderAdmin(c, 'Indstillinger', settingsPage({ csrf: c.get('csrf'), s: c.get('settings'), flash: flashMessage(c.req.query('besked')) }), { nav: 'indstillinger' }),
);

admin.post('/indstillinger', async (c) => {
  const b = await c.req.parseBody();
  const errors: Record<string, string> = {};
  const money = (k: string): number => {
    const v = parseKr(str(b[k], 20) || '0');
    if (v === null) errors[k] = 'Skriv et beløb, fx 49 eller 49,95';
    return v ?? 0;
  };
  const optEmail = (k: string): string => {
    const raw = str(b[k], 254);
    if (!raw) return '';
    const e = normalizeEmail(raw);
    if (!e) errors[k] = 'Indtast en gyldig e-mailadresse.';
    return e ?? raw;
  };
  const optUrl = (k: string): string => {
    const raw = str(b[k], 500);
    if (raw && !safeUrl(raw)) errors[k] = 'Linket skal starte med https://';
    return raw;
  };
  const s: Settings = {
    ...DEFAULT_SETTINGS,
    shop_name: str(b['shop_name'], 80),
    tagline: str(b['tagline'], 120),
    intro: str(b['intro'], 1000, { multiline: true }),
    accent_color: str(b['accent_color'], 7),
    website_url: optUrl('website_url'),
    contact_email: optEmail('contact_email'),
    contact_phone: str(b['contact_phone'], 30),
    address: str(b['address'], 150),
    notify_email: optEmail('notify_email'),
    pickup_enabled: b['pickup_enabled'] === '1',
    pickup_info: str(b['pickup_info'], 300),
    delivery_enabled: b['delivery_enabled'] === '1',
    delivery_info: str(b['delivery_info'], 300),
    delivery_fee: money('delivery_fee'),
    free_delivery_from: money('free_delivery_from'),
    min_order: money('min_order'),
    auto_confirm: b['auto_confirm'] === '1',
    show_stock_count: b['show_stock_count'] === '1',
    low_stock_default: parseIntStrict(b['low_stock_default']) ?? -1,
    lead_time_days: b['lead_time_days'] === undefined ? DEFAULT_SETTINGS.lead_time_days : (parseIntStrict(b['lead_time_days'], { max: 365 }) ?? -1),
    service_level: SERVICE_LEVELS.includes(Number(b['service_level'])) ? Number(b['service_level']) : DEFAULT_SETTINGS.service_level,
    forecast_days: b['forecast_days'] === undefined ? DEFAULT_SETTINGS.forecast_days : (parseIntStrict(b['forecast_days'], { max: 365 }) ?? -1),
    reorder_warn_days: b['reorder_warn_days'] === undefined ? DEFAULT_SETTINGS.reorder_warn_days : (parseIntStrict(b['reorder_warn_days'], { max: 90 }) ?? -1),
    terms_url: optUrl('terms_url'),
    privacy_url: optUrl('privacy_url'),
  };
  if (!s.shop_name) errors['shop_name'] = 'Skriv butikkens navn.';
  if (!isHexColor(s.accent_color)) errors['accent_color'] = 'Vælg en farve.';
  if (!s.pickup_enabled && !s.delivery_enabled) errors['delivery'] = 'Vælg mindst én af afhentning og levering.';
  if (s.low_stock_default < 0) errors['low_stock_default'] = 'Skriv et helt tal på 0 eller mere.';
  if (s.lead_time_days < 0) errors['lead_time_days'] = 'Skriv antal dage (0-365).';
  if (s.forecast_days < MIN_HISTORY_DAYS) errors['forecast_days'] = `Skriv et antal dage mellem ${MIN_HISTORY_DAYS} og 365.`;
  if (s.reorder_warn_days < 0) errors['reorder_warn_days'] = 'Skriv antal dage (0-90).';
  if (Object.keys(errors).length) {
    return renderAdmin(c, 'Indstillinger', settingsPage({ csrf: c.get('csrf'), s, errors }), { nav: 'indstillinger', status: 400 });
  }
  await saveSettings(c.env.DB, s);
  await recomputeForecast(c.env.DB, s);
  return c.redirect('/admin/indstillinger?besked=gemt', 303);
});

export default admin;
