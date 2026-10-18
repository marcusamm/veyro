import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { MAX_QTY, readCart, writeCart } from '../lib/cart';
import { sha256Hex } from '../lib/crypto';
import { newOrderNotifyEmail, orderReceivedEmail, sendLater } from '../lib/email';
import { normalizeEmail, parseIntStrict, str } from '../lib/format';
import { notifyLowStock } from '../lib/notify';
import { createOrder, getOrderByToken, getOrderEvents, getOrderLines, priceCart, type CheckoutInput } from '../lib/orders';
import { getProduct, listCategories, listProducts } from '../lib/products';
import { safeUrl } from '../lib/settings';
import { rateLimit } from '../lib/session';
import { renderShop } from '../render';
import { cartPage, catalogPage, checkoutPage, messagePage, orderPage, type CheckoutValues } from '../views/shop';

const shop = new Hono<AppEnv>();

function appUrl(env: { APP_URL: string }): string {
  return env.APP_URL.replace(/\/+$/, '');
}

/** Kun lokale stier til forsiden (efter "Læg i kurv"). */
function safeBack(raw: unknown): string {
  return typeof raw === 'string' && /^\/(\?[A-Za-z0-9\-._~%=&+]*)?$/.test(raw) && raw.length <= 300 ? raw : '/';
}

shop.get('/', async (c) => {
  const q = str(c.req.query('q'), 80);
  const category = str(c.req.query('kategori'), 80) || null;
  const [products, categories] = await Promise.all([
    listProducts(c.env.DB, { activeOnly: true, q: q || undefined, category: category ?? undefined }),
    listCategories(c.env.DB, true),
  ]);
  const cart = new Map(readCart(c).map((l) => [l.productId, l.quantity]));
  const added = parseIntStrict(c.req.query('tilfoejet') ?? '');
  const s = c.get('settings');
  return renderShop(
    c,
    s.shop_name,
    catalogPage({ settings: s, products, categories, category, q, csrf: c.get('csrf'), cart, added }),
    { description: s.tagline, noindex: !!q || !!category },
  );
});

shop.post('/kurv', async (c) => {
  const body = await c.req.parseBody();
  const id = parseIntStrict(body['id']);
  const qty = Math.min(parseIntStrict(body['qty']) ?? 1, MAX_QTY);
  const back = safeBack(body['back']);
  if (!id || qty < 1) return c.redirect(back, 303);
  const p = await getProduct(c.env.DB, id);
  if (!p || !p.active) return c.redirect(back, 303);
  const cart = readCart(c);
  const line = cart.find((l) => l.productId === id);
  // Mere end der er på lager kan ikke lægges i kurven
  const max = p.track_stock ? Math.max(0, p.stock - p.reserved) : MAX_QTY;
  const want = Math.min((line?.quantity ?? 0) + qty, max);
  if (want <= 0) return c.redirect(back, 303);
  if (line) line.quantity = want;
  else cart.push({ productId: id, quantity: want });
  writeCart(c, cart);
  return c.redirect(`${back}${back.includes('?') ? '&' : '?'}tilfoejet=${id}#vare-${id}`, 303);
});

shop.get('/kurv', async (c) => {
  const priced = await priceCart(c.env.DB, readCart(c));
  if (priced.removed) writeCart(c, priced.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })));
  const notice = c.req.query('besked') === 'opdateret' ? 'Kurven er opdateret.' : null;
  return renderShop(c, 'Kurv', cartPage({ settings: c.get('settings'), priced, csrf: c.get('csrf'), notice }), { noindex: true });
});

shop.post('/kurv/opdater', async (c) => {
  const body = await c.req.parseBody();
  const remove = parseIntStrict(body['fjern']);
  const cart = readCart(c)
    .map((l) => {
      const v = parseIntStrict(body[`q_${l.productId}`]);
      return { productId: l.productId, quantity: l.productId === remove ? 0 : Math.min(v ?? l.quantity, MAX_QTY) };
    })
    .filter((l) => l.quantity > 0);
  writeCart(c, cart);
  return c.redirect('/kurv?besked=opdateret', 303);
});

const emptyValues = (s: { pickup_enabled: boolean }): CheckoutValues => ({
  customer_name: '',
  customer_email: '',
  customer_phone: '',
  company: '',
  delivery: s.pickup_enabled ? 'afhentning' : 'levering',
  address: '',
  postcode: '',
  city: '',
  note: '',
  accept: false,
});

shop.get('/kassen', async (c) => {
  const priced = await priceCart(c.env.DB, readCart(c));
  if (!priced.lines.length) return c.redirect('/kurv', 303);
  const s = c.get('settings');
  return renderShop(c, 'Kassen', checkoutPage({ settings: s, priced, csrf: c.get('csrf'), values: emptyValues(s) }), { noindex: true });
});

shop.post('/kassen', async (c) => {
  const s = c.get('settings');
  const cart = readCart(c);
  const priced = await priceCart(c.env.DB, cart);
  if (!priced.lines.length) return c.redirect('/kurv', 303);
  const body = await c.req.parseBody();
  const v: CheckoutValues = {
    customer_name: str(body['customer_name'], 100),
    customer_email: str(body['customer_email'], 254),
    customer_phone: str(body['customer_phone'], 30),
    company: str(body['company'], 100),
    delivery: body['delivery'] === 'levering' ? 'levering' : 'afhentning',
    address: str(body['address'], 150),
    postcode: str(body['postcode'], 10),
    city: str(body['city'], 80),
    note: str(body['note'], 1000, { multiline: true }),
    accept: body['accept'] === '1',
  };
  if (v.delivery === 'levering' && !s.delivery_enabled) v.delivery = 'afhentning';
  if (v.delivery === 'afhentning' && !s.pickup_enabled) v.delivery = 'levering';

  const errors: Partial<Record<keyof CheckoutValues | 'form', string>> = {};
  const email = normalizeEmail(v.customer_email);
  if (!v.customer_name) errors.customer_name = 'Skriv dit navn.';
  if (!email) errors.customer_email = 'Indtast en gyldig e-mailadresse.';
  if (!/^[+\d][\d\s\-()]{5,}$/.test(v.customer_phone)) errors.customer_phone = 'Indtast et gyldigt telefonnummer.';
  if (v.delivery === 'levering') {
    if (!v.address) errors.address = 'Skriv leveringsadressen.';
    if (!/^\d{3,5}$/.test(v.postcode.replace(/\s/g, ''))) errors.postcode = 'Indtast et gyldigt postnummer.';
    if (!v.city) errors.city = 'Skriv byen.';
  }
  if (safeUrl(s.terms_url) && !v.accept) errors.accept = 'Du skal acceptere handelsbetingelserne.';
  const again = (status: 400 | 409 | 429 = 400) =>
    renderShop(c, 'Kassen', checkoutPage({ settings: s, priced, csrf: c.get('csrf'), values: v, errors }), { status, noindex: true });
  if (Object.keys(errors).length) {
    errors.form = 'Ret de markerede felter.';
    return again();
  }

  // Beskyt mod spam: højst 10 bestillinger i timen pr. IP-adresse
  const ip = c.req.header('CF-Connecting-IP') ?? 'ukendt';
  if (!(await rateLimit(c.env.DB, 'order-ip:' + (await sha256Hex(ip)), 10, 3600))) {
    errors.form = 'Der er sendt mange bestillinger fra din forbindelse. Vent lidt, og prøv igen, eller kontakt os.';
    return again(429);
  }

  const input: CheckoutInput = {
    customer_name: v.customer_name,
    customer_email: email!,
    customer_phone: v.customer_phone,
    company: v.company,
    delivery: v.delivery,
    address: v.address,
    postcode: v.postcode.replace(/\s/g, ''),
    city: v.city,
    note: v.note,
  };
  const result = await createOrder(c.env.DB, s, input, cart);
  if (!result.ok) {
    if (result.reason === 'stock') {
      const fresh = await priceCart(c.env.DB, cart);
      errors.form = 'Nogle varer er blevet udsolgt, mens du handlede. Ret antallet i kurven.';
      return renderShop(c, 'Kassen', checkoutPage({ settings: s, priced: fresh, csrf: c.get('csrf'), values: v, errors }), { status: 409, noindex: true });
    }
    if (result.reason === 'min_order') errors.form = 'Bestillingen er under mindstebeløbet.';
    else if (result.reason === 'delivery') errors.form = 'Den valgte leveringsform er ikke mulig.';
    else return c.redirect('/kurv', 303);
    return again();
  }

  const order = result.order;
  writeCart(c, []);
  const lines = await getOrderLines(c.env.DB, order.id);
  const base = appUrl(c.env);
  sendLater(c.env, c.executionCtx, orderReceivedEmail(order, lines, s, `${base}/ordre/${order.token}`), s);
  sendLater(c.env, c.executionCtx, newOrderNotifyEmail(order, lines, s, `${base}/admin/ordrer/${order.id}`), s);
  if (order.stock_deducted) await notifyLowStock(c, order.id);
  return c.redirect(`/ordre/${order.token}?ny=1`, 303);
});

shop.get('/ordre/:token', async (c) => {
  const order = await getOrderByToken(c.env.DB, c.req.param('token'));
  if (!order) return renderShop(c, 'Bestilling ikke fundet', messagePage('Bestillingen findes ikke', 'Tjek linket i din e-mail.'), { status: 404, noindex: true });
  const [lines, events] = await Promise.all([getOrderLines(c.env.DB, order.id), getOrderEvents(c.env.DB, order.id)]);
  const res = await renderShop(
    c,
    `Bestilling #${order.number}`,
    orderPage({ settings: c.get('settings'), order, lines, events, justPlaced: c.req.query('ny') === '1' }),
    { noindex: true },
  );
  res.headers.set('Referrer-Policy', 'no-referrer');
  return res;
});

export default shop;
