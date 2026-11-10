// Shop records share the salon's durable storage and admin sessions. Prices are always øre.
const PRODUCT = /^[a-f0-9-]{36}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MAX_IMAGE = 800 * 1024;
const IMAGE_CHUNK = 64000;
const ORDER_TTL = 31 * 60 * 1000;
const DEFAULT_SETTINGS = { shippingFeeOre: 0, shippingEnabled: false, shippingDays: '2–5 hverdage', termsUrl: '', country: 'DK' };
export class ShopError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new ShopError(status, message); };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const text = (value, limit, required = false) => {
  if (typeof value !== 'string' || value.trim().length > limit || (required && !value.trim())) fail(400, 'Udfyld feltet med en gyldig tekst.');
  return value.trim();
};
const integer = (value, min, max) => { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(400, 'Pris og lager skal være gyldige, hele tal.'); return value; };
const encode = obj => { const form = new URLSearchParams(); for (const [key, value] of Object.entries(obj)) form.set(key, String(value)); return form; };
const cleanProduct = (input, old = {}) => {
  const imageUrl = text(input.imageUrl || '', 150);
  if (imageUrl && !/^\/api\/shop\/images\/[a-f0-9-]{36}$/.test(imageUrl)) fail(400, 'Upload et produktbillede gennem produkteditoren.');
  if (typeof input.published !== 'boolean') fail(400, 'Vælg kladde eller offentlig.');
  const product = { id: old.id || crypto.randomUUID(), revision: (old.revision || 0) + 1, name: text(input.name, 100, true), description: text(input.description || '', 1200), category: text(input.category || '', 60), priceOre: integer(input.priceOre, 100, 10000000), stock: integer(input.stock, 0, 100000), imageUrl, published: input.published, createdAt: old.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
  if (product.published && !imageUrl) fail(400, 'Tilføj et produktbillede før offentliggørelse.');
  return product;
};

export class ShopCore {
  constructor(salon) { this.salon = salon; this.storage = salon.storage; this.tail = Promise.resolve(); this.nextSweep = 0; }
  env() { return this.salon.env; }
  now() { return this.salon.now(); }
  async serial(fn) { const run = this.tail.then(fn, fn); this.tail = run.catch(() => {}); return run; }
  async transaction(fn) { if (!this.storage.transaction) fail(503, 'Webshoppens lager er ikke tilsluttet.'); return this.storage.transaction(fn); }
  async settings() { return { ...DEFAULT_SETTINGS, ...(await this.storage.get('shop:settings')) }; }
  configured(settings) {
    const secret = this.env().SBB_STRIPE_SECRET_KEY || '';
    const merchantReady = /^(sk|rk)_live_/.test(secret) || (this.env().DEV_LOGIN === '1' && /^(sk|rk)_test_/.test(secret));
    return Boolean(merchantReady && this.env().SBB_STRIPE_WEBHOOK_SECRET && settings.shippingEnabled && settings.termsUrl);
  }
  async products() { return [...(await this.storage.list('shop:product:')).values()]; }
  async orders() { return [...(await this.storage.list('shop:order:')).values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  async body(req, max = 16000) {
    if (!(req.headers.get('content-type') || '').startsWith('application/json')) fail(415, 'Forventede JSON.');
    const raw = await this.limited(req, max);
    try { const value = JSON.parse(new TextDecoder().decode(raw)); if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Forventede et objekt.'); return value; } catch { fail(400, 'Ugyldig JSON.'); }
  }
  async limited(req, max) {
    if (Number(req.headers.get('content-length')) > max) fail(413, 'Filen eller forespørgslen er for stor.');
    const reader = req.body?.getReader(); if (!reader) return new Uint8Array();
    let size = 0; const chunks = [];
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > max) { await reader.cancel(); fail(413, 'Filen eller forespørgslen er for stor.'); } chunks.push(value); }
    const result = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; } return result;
  }
  origin(req) {
    if (req.headers.get('origin') !== new URL(req.url).origin || req.headers.get('sec-fetch-site') === 'cross-site') fail(403, 'Åbn webshoppen på salonens egen hjemmeside.');
  }
  async stripe(path, body, idempotencyKey) {
    const headers = { Authorization: `Bearer ${this.env().SBB_STRIPE_SECRET_KEY}`, 'Stripe-Version': '2026-09-30.endive' };
    if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    let response;
    try { response = await fetch(`https://api.stripe.com/v1/${path}`, { method: body ? 'POST' : 'GET', headers, body: body ? encode(body) : undefined, redirect: 'manual', signal: AbortSignal.timeout(12000) }); }
    catch { fail(503, 'Betalingsforbindelsen svarer ikke. Prøv igen med samme kurv.'); }
    const result = await response.json().catch(() => null);
    if (!response.ok || !result || result.error) fail(502, 'Betalingsforbindelsen kunne ikke gennemføre forespørgslen. Prøv igen.');
    return result;
  }
  async handle(req) {
    const url = new URL(req.url), p = url.pathname, method = req.method;
    // Webhook signature is checked over exact request bytes, independently of browser sessions.
    if (p === '/api/shop/webhook' && method === 'POST') return this.webhook(req);
    if (method !== 'GET') this.origin(req);
    if (p.startsWith('/api/admin/shop')) await this.salon.requireAdmin(req);
    return this.serial(() => this.route(req, p, method));
  }
  async route(req, p, method) {
    if (p === '/api/shop/products' && method === 'GET') {
      await this.sweep();
      const settings = await this.settings();
      return json({ products: (await this.products()).filter(x => x.published), settings: { ...settings, checkoutEnabled: this.configured(settings) } });
    }
    const imageMatch = p.match(/^\/api\/shop\/images\/([a-f0-9-]{36})$/);
    if (imageMatch && method === 'GET') {
      const id = imageMatch[1], meta = await this.storage.get(`shop:image:${id}`);
      if (!meta) fail(404, 'Billedet findes ikke.');
      const published = (await this.products()).some(product => product.published && product.imageUrl === p);
      if (!published) await this.salon.requireAdmin(req);
      const chunks = await Promise.all(Array.from({ length: meta.chunks }, (_, i) => this.storage.get(`shop:imagechunk:${id}:${i}`)));
      if (chunks.some(c => !c)) fail(404, 'Billedet findes ikke.');
      return new Response(new Blob(chunks, { type: meta.type }), { headers: { 'content-type': meta.type, 'cache-control': published ? 'public, max-age=3600' : 'private, no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" } });
    }
    if (p === '/api/shop/checkout' && method === 'POST') {
      this.salon.limit(req.headers.get('cf-connecting-ip') || '', 'shop');
      return this.checkout(await this.body(req));
    }
    const statusMatch = p.match(/^\/api\/shop\/orders\/([a-f0-9-]{36})$/);
    if (statusMatch && method === 'GET') {
      const order = await this.storage.get(`shop:order:${statusMatch[1]}`);
      if (!order) fail(404, 'Ordren findes ikke.');
      // Deliberately no customer, address, item or session data on this public endpoint.
      return json({ status: order.status, totalOre: order.totalOre, currency: 'DKK' });
    }
    if (p === '/api/admin/shop' && method === 'GET') {
      await this.sweep(true); const settings = await this.settings();
      return json({ products: await this.products(), orders: (await this.orders()).slice(0, 200), settings: { ...settings, checkoutEnabled: this.configured(settings) } });
    }
    if (p === '/api/admin/shop/settings' && method === 'PUT') {
      const input = await this.body(req);
      const termsUrl = text(input.termsUrl || '', 300);
      if (termsUrl && !/^https:\/\/[^\s"<>]+$/.test(termsUrl)) fail(400, 'Handelsbetingelser skal være et https-link.');
      if (typeof input.shippingEnabled !== 'boolean') fail(400, 'Vælg om levering er aktiveret.');
      const settings = { shippingFeeOre: integer(input.shippingFeeOre, 0, 100000), shippingEnabled: input.shippingEnabled, shippingDays: text(input.shippingDays || '', 100, true), termsUrl, country: 'DK' };
      if (settings.shippingEnabled && !termsUrl) fail(400, 'Tilføj handelsbetingelser før levering aktiveres.');
      await this.storage.put('shop:settings', settings);
      return json({ settings: { ...settings, checkoutEnabled: this.configured(settings) } });
    }
    if (p === '/api/admin/shop/images' && method === 'POST') return this.upload(req);
    if (p === '/api/admin/shop/products' && method === 'POST') {
      if ((await this.products()).length >= 200) fail(409, 'Der er højst plads til 200 produkter.');
      const product = cleanProduct(await this.body(req));
      await this.checkImage(product);
      await this.storage.put(`shop:product:${product.id}`, product);
      return json({ product }, 201);
    }
    const productMatch = p.match(/^\/api\/admin\/shop\/products\/([a-f0-9-]{36})$/);
    if (productMatch && ['PUT', 'DELETE'].includes(method)) {
      const old = await this.storage.get(`shop:product:${productMatch[1]}`);
      if (!old) fail(404, 'Produktet findes ikke.');
      if (method === 'DELETE') { old.published = false; old.revision = (old.revision || 0) + 1; old.updatedAt = new Date(this.now()).toISOString(); await this.storage.put(`shop:product:${old.id}`, old); return json({ product: old }); }
      const input = await this.body(req);
      if (input.revision !== old.revision) fail(409, 'Produktet eller lageret er ændret siden du åbnede det. Genindlæs produktet før du gemmer.');
      const product = cleanProduct(input, old); await this.checkImage(product);
      await this.storage.put(`shop:product:${product.id}`, product);
      return json({ product });
    }
    const orderMatch = p.match(/^\/api\/admin\/shop\/orders\/([a-f0-9-]{36})$/);
    if (orderMatch && method === 'PATCH') {
      const { status } = await this.body(req), order = await this.storage.get(`shop:order:${orderMatch[1]}`);
      if (!order) fail(404, 'Ordren findes ikke.');
      if (status !== 'fulfilled' || !['paid', 'fulfilled'].includes(order.status)) fail(409, 'Kun betalte ordrer kan markeres som afsendt. Refusion håndteres i Stripe.');
      order.status = 'fulfilled'; order.fulfilledAt ||= new Date(this.now()).toISOString();
      await this.storage.put(`shop:order:${order.id}`, order);
      return json({ order });
    }
    fail(404, 'Ikke fundet.');
  }
  async checkImage(product) { if (product.imageUrl && !await this.storage.get(`shop:image:${product.imageUrl.split('/').pop()}`)) fail(400, 'Upload produktbilledet igen.'); }
  async upload(req) {
    const type = (req.headers.get('content-type') || '').split(';')[0];
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) fail(415, 'Brug JPEG, PNG eller WebP.');
    const bytes = await this.limited(req, MAX_IMAGE);
    const png = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10;
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const webp = new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP';
    if (bytes.length < 16 || !(type === 'image/png' ? png : type === 'image/jpeg' ? jpeg : webp)) fail(400, 'Filen er ikke et gyldigt produktbillede.');
    if ((await this.storage.list('shop:image:')).size >= 600) fail(409, 'Billedlageret er fuldt. Kontakt Veyro.');
    const id = crypto.randomUUID(), chunks = Math.ceil(bytes.length / IMAGE_CHUNK);
    await this.transaction(async store => {
      for (let i = 0; i < chunks; i++) await store.put(`shop:imagechunk:${id}:${i}`, bytes.slice(i * IMAGE_CHUNK, (i + 1) * IMAGE_CHUNK));
      await store.put(`shop:image:${id}`, { type, chunks, createdAt: new Date(this.now()).toISOString() });
    });
    return json({ imageUrl: `/api/shop/images/${id}` }, 201);
  }
  async checkout(input) {
    const settings = await this.settings();
    if (!this.configured(settings)) fail(503, 'Onlinebetaling og levering er ikke åbnet endnu. Kontakt salonen.');
    if (!UUID.test(input.idempotencyKey || '')) fail(400, 'Genindlæs kurven og prøv igen.');
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 20) fail(400, 'Kurven skal indeholde 1–20 produkter.');
    const requested = input.items.map(item => ({ productId: item.productId, quantity: integer(item.quantity, 1, 20) })).sort((a, b) => String(a.productId).localeCompare(String(b.productId)));
    if (new Set(requested.map(item => item.productId)).size !== requested.length || requested.some(item => !PRODUCT.test(item.productId || ''))) fail(400, 'Ugyldige eller gentagne produkter i kurven.');
    const fingerprint = JSON.stringify(requested), key = `shop:attempt:${input.idempotencyKey}`;
    const oldAttempt = await this.storage.get(key);
    let order;
    if (oldAttempt) {
      if (oldAttempt.fingerprint !== fingerprint) fail(409, 'Kurven er ændret. Start en ny betaling.');
      order = await this.storage.get(`shop:order:${oldAttempt.orderId}`);
      if (!order || !['creating', 'pending'].includes(order.status) || this.now() > order.expiresAt) fail(409, 'Denne betaling er afsluttet eller udløbet. Start en ny betaling.');
      if (order.checkoutUrl) return json({ url: order.checkoutUrl, orderId: order.id });
    } else {
      await this.sweep(true);
      const pending = (await this.orders()).filter(o => ['creating', 'pending'].includes(o.status));
      if (pending.length >= 100) fail(503, 'Der er mange aktive betalinger lige nu. Prøv igen senere.');
      order = await this.transaction(async store => {
        const lines = [];
        for (const item of requested) {
          const product = await store.get(`shop:product:${item.productId}`);
          if (!product?.published || product.stock < item.quantity) fail(409, 'En vare i kurven er udsolgt eller findes ikke længere. Opdatér kurven.');
          lines.push({ productId: product.id, name: product.name, priceOre: product.priceOre, quantity: item.quantity });
          product.stock -= item.quantity; product.revision = (product.revision || 0) + 1;
          await store.put(`shop:product:${product.id}`, product);
        }
        const created = { id: crypto.randomUUID(), status: 'creating', items: lines, shippingFeeOre: settings.shippingFeeOre, shippingDays: settings.shippingDays, termsUrl: settings.termsUrl, totalOre: lines.reduce((sum, item) => sum + item.priceOre * item.quantity, settings.shippingFeeOre), createdAt: new Date(this.now()).toISOString(), expiresAt: this.now() + ORDER_TTL, attemptKey: input.idempotencyKey, integrationIdentifier: 'sbb-shop-' + [...crypto.getRandomValues(new Uint8Array(8))].map(n => String.fromCharCode(97 + n % 26)).join(''), sessionId: null };
        await store.put(`shop:order:${created.id}`, created);
        await store.put(key, { orderId: created.id, fingerprint });
        return created;
      });
    }
    const params = {
      mode: 'payment', integration_identifier: order.integrationIdentifier,
      success_url: `${this.salon.site()}/#/shop?order=${order.id}`, cancel_url: `${this.salon.site()}/#/shop?cancelled=1`,
      client_reference_id: order.id, 'metadata[sbb_order_id]': order.id,
      'payment_intent_data[metadata][sbb_order_id]': order.id,
      'shipping_address_collection[allowed_countries][0]': 'DK', 'phone_number_collection[enabled]': true,
      'billing_address_collection': 'required', 'consent_collection[terms_of_service]': 'required',
      'custom_text[terms_of_service_acceptance][message]': `Jeg accepterer salonens [handelsbetingelser](${order.termsUrl}).`,
      'shipping_options[0][shipping_rate_data][type]': 'fixed_amount',
      'shipping_options[0][shipping_rate_data][fixed_amount][amount]': order.shippingFeeOre,
      'shipping_options[0][shipping_rate_data][fixed_amount][currency]': 'dkk',
      'shipping_options[0][shipping_rate_data][display_name]': `Levering i Danmark · ${order.shippingDays}`,
      expires_at: Math.floor(order.expiresAt / 1000), locale: 'da',
    };
    order.items.forEach((item, i) => {
      params[`line_items[${i}][price_data][currency]`] = 'dkk'; params[`line_items[${i}][price_data][unit_amount]`] = item.priceOre;
      params[`line_items[${i}][price_data][product_data][name]`] = item.name; params[`line_items[${i}][quantity]`] = item.quantity;
    });
    // Retrying an uncertain network response uses the same Stripe idempotency key: never a second payment.
    const session = await this.stripe('checkout/sessions', params, `sbb-${order.attemptKey}`);
    if (!session.id || typeof session.url !== 'string' || !session.url.startsWith('https://checkout.stripe.com/')) fail(502, 'Betalingslinket kunne ikke oprettes.');
    order.sessionId = session.id; order.checkoutUrl = session.url; order.status = 'pending';
    await this.storage.put(`shop:order:${order.id}`, order);
    return json({ url: order.checkoutUrl, orderId: order.id });
  }
  async finish(session, failed = false) {
    const id = session.metadata?.sbb_order_id || session.client_reference_id;
    if (!PRODUCT.test(id || '')) return;
    const paidOrder = await this.transaction(async store => {
      const order = await store.get(`shop:order:${id}`); if (!order) return;
      if (order.sessionId && order.sessionId !== session.id) fail(400, 'Betalingen matcher ikke ordren.');
      if (session.payment_status === 'paid' && session.status === 'complete') {
        if (session.amount_total !== order.totalOre || session.currency !== 'dkk') fail(400, 'Beløb eller valuta matcher ikke ordren.');
        if (['paid', 'fulfilled'].includes(order.status)) return;
        if (!['creating', 'pending'].includes(order.status)) fail(409, 'Ordren er allerede frigivet. Kontakt salonen.');
        order.status = 'paid'; order.paidAt = new Date(this.now()).toISOString(); order.sessionId = session.id;
        const details = session.customer_details || {};
        const shipping = session.collected_information?.shipping_details || session.shipping_details || {};
        const address = shipping.address || details.address || {};
        order.customer = { name: String(shipping.name || details.name || '').slice(0, 150), email: String(details.email || '').slice(0, 150), phone: String(details.phone || '').slice(0, 50) };
        order.shippingAddress = Object.fromEntries(['line1', 'line2', 'city', 'postal_code', 'country'].map(k => [k, String(address[k] || '').slice(0, 200)]));
        order.paymentIntent = typeof session.payment_intent === 'string' ? session.payment_intent : '';
      } else if ((session.status === 'expired' || failed) && ['creating', 'pending'].includes(order.status)) {
        for (const line of order.items) { const product = await store.get(`shop:product:${line.productId}`); if (product) { product.stock += line.quantity; product.revision = (product.revision || 0) + 1; await store.put(`shop:product:${product.id}`, product); } }
        order.status = failed ? 'cancelled' : 'expired'; order.expiredAt = new Date(this.now()).toISOString();
      } else return;
      await store.put(`shop:order:${order.id}`, order);
      return order.status === 'paid' ? order : null;
    });
    if (paidOrder) await this.notifyPaid(paidOrder);
  }
  async notifyPaid(order) {
    const money = n => new Intl.NumberFormat('da-DK', { style: 'currency', currency: 'DKK' }).format(n / 100);
    const lines = order.items.map(item => `${item.quantity} × ${item.name}: ${money(item.priceOre * item.quantity)}`).join('\n');
    const address = order.shippingAddress || {};
    const details = `Ordre: ${order.id}\n\n${lines}\nFragt: ${money(order.shippingFeeOre)}\nI alt inkl. moms: ${money(order.totalOre)}\n\nLevering til:\n${order.customer.name}\n${address.line1 || ''}\n${address.line2 || ''}\n${address.postal_code || ''} ${address.city || ''}\n${address.country || ''}`;
    // A repeated Stripe event sees status paid and cannot send a second confirmation.
    // Failed email attempts remain visible in the salon's existing mail log.
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(order.customer.email)) await this.salon.mail({ to: order.customer.email, subject: 'Din bestilling hos StyleByBrothers', text: `Tak for din bestilling. Betalingen er modtaget.\n\n${details}\n\nVi sender dine varer ${order.shippingDays ? 'inden for ' + order.shippingDays : 'hurtigst muligt'}.\nSpørgsmål? Ring til salonen på +45 61 70 70 44.\n\nStyleByBrothers` }, 'webshop (kunde)');
    const state = await this.salon.engineState();
    for (const to of this.salon.salonRecipients(state)) await this.salon.mail({ to, subject: 'Ny betalt webshopordre', text: `${details}\n\nKunde: ${order.customer.email} · ${order.customer.phone}\nSe ordren: ${this.salon.site()}/#/admin/ordrer` }, 'webshop (salon)');
  }
  async webhook(req) {
    const secret = this.env().SBB_STRIPE_WEBHOOK_SECRET; if (!secret) fail(503, 'Betalingsintegration mangler.');
    const header = req.headers.get('stripe-signature') || '', t = header.split(',').find(x => x.startsWith('t='))?.slice(2);
    const signatures = header.split(',').filter(x => x.startsWith('v1=')).map(x => x.slice(3));
    if (!/^\d+$/.test(t || '') || Math.abs(this.now() / 1000 - Number(t)) > 300 || !signatures.length) fail(400, 'Ugyldig signatur.');
    const bytes = await this.limited(req, 100000);
    const raw = new TextDecoder().decode(bytes), key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    let valid = false;
    for (const sig of signatures) {
      if (!/^[a-f0-9]{64}$/.test(sig)) continue;
      const value = new Uint8Array(sig.match(/../g).map(x => parseInt(x, 16)));
      if (await crypto.subtle.verify('HMAC', key, value, new TextEncoder().encode(`${t}.${raw}`))) valid = true;
    }
    if (!valid) fail(400, 'Ugyldig signatur.');
    let event; try { event = JSON.parse(raw); } catch { fail(400, 'Ugyldig JSON.'); }
    if (['checkout.session.completed', 'checkout.session.expired', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed'].includes(event.type)) await this.serial(() => this.finish(event.data?.object || {}, event.type === 'checkout.session.async_payment_failed'));
    return json({ received: true });
  }
  async sweep(force = false) {
    if (!this.env().SBB_STRIPE_SECRET_KEY || (!force && this.now() < this.nextSweep)) return;
    this.nextSweep = this.now() + 60000;
    const due = (await this.orders()).filter(order => ['pending', 'creating'].includes(order.status) && order.expiresAt < this.now()).slice(0, 20);
    for (const order of due) {
      try {
        if (order.sessionId) await this.finish(await this.stripe(`checkout/sessions/${encodeURIComponent(order.sessionId)}`));
        else {
          // Unknown creation result: find its session before releasing inventory (a lost response may hide a paid session).
          const sessions = await this.stripe(`checkout/sessions?created[gte]=${Math.floor(new Date(order.createdAt).getTime() / 1000) - 5}&limit=100`);
          const session = sessions.data?.find(x => x.metadata?.sbb_order_id === order.id);
          if (session) await this.finish(session);
          else if (!sessions.has_more) await this.finish({ id: '', metadata: { sbb_order_id: order.id }, status: 'expired' });
        }
      } catch { /* Keep stock reserved until Stripe provides an authoritative answer. */ }
    }
  }
}
