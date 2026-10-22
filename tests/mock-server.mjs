// Lokal mock af de Stripe- og Resend-endpoints, kundepanelet bruger.
// Kun til test – peg STRIPE_API_BASE og RESEND_API_BASE hertil.
import http from 'node:http';

export const MOCK_KEY = 'sk_test_mock';
export const RESEND_KEY = 're_test_mock';
export const PRICES = {
  price_starter_test: 29900,
  price_business_test: 59900,
  price_premium_test: 109900,
};

function parseForm(body) {
  const out = {};
  for (const [k, v] of new URLSearchParams(body)) out[k] = v;
  return out;
}

function stripeErr(res, status, message, code) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message, code, type: 'invalid_request_error' } }));
}

export function makeSubscription({ id, customer, price = 'price_business_test', status = 'active', start, periodEnd, cancelAtPeriodEnd = false }) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id,
    object: 'subscription',
    customer,
    status,
    start_date: start ?? now - 86400 * 10,
    created: start ?? now - 86400 * 10,
    cancel_at_period_end: cancelAtPeriodEnd,
    cancel_at: cancelAtPeriodEnd ? (periodEnd ?? now + 86400 * 20) : null,
    canceled_at: null,
    items: {
      data: [
        {
          id: 'si_' + id.slice(4),
          quantity: 1,
          current_period_end: periodEnd ?? now + 86400 * 20,
          price: { id: price, unit_amount: PRICES[price] ?? 0, currency: 'dkk' },
        },
      ],
    },
  };
}

export const CF_TOKEN = 'cf_test_token_mock';
export const GITHUB_TOKEN = 'gh_test_token_mock';
export const CF_ACCOUNT = 'acc0000000000000000000000000test';
/** Zoner i den simulerede Cloudflare-konto */
const CF_ZONES = [{ id: 'zone_veyro', name: 'veyro.dk', account: { id: CF_ACCOUNT } }];

function forwardWithHost(stackUrl, path, host, res) {
  const u = new URL(stackUrl);
  const r = http.request({ host: u.hostname, port: u.port, path, method: 'GET', headers: { Host: host } }, (up) => {
    let b = '';
    up.on('data', (d) => (b += d));
    up.on('end', () => {
      res.writeHead(up.statusCode, { 'Content-Type': up.headers['content-type'] ?? 'application/json' });
      res.end(b);
    });
  });
  r.on('error', (e) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  });
  r.end();
}

export function startMock() {
  const state = { customers: {}, subscriptions: {}, invoices: [], calls: [], emails: [], failNext: null };

  // Simuleret Cloudflare API: Workers Custom Domains og Cloudflare for SaaS (custom hostnames)
  function cloudflare(req, res, p, url, body) {
    const send = (status, result, errors = []) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: status < 300, errors, messages: [], result }));
    };
    (state.cfCalls ??= []).push({ method: req.method, path: p + url.search, body: body ? JSON.parse(body) : null, auth: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${CF_TOKEN}`) return send(403, null, [{ code: 10000, message: 'Authentication error' }]);
    if (state.cfFail && p.includes(state.cfFail)) return send(500, null, [{ code: 1001, message: 'Simuleret fejl hos Cloudflare' }]);
    const path = p.slice('/cf'.length);
    let m;
    const domains = (state.cfDomains ??= {});
    const hostnames = (state.cfHostnames ??= {});
    if (path === '/zones' && req.method === 'GET') return send(200, CF_ZONES.filter((z) => z.name === url.searchParams.get('name')));
    if ((m = path.match(/^\/accounts\/([^/]+)\/workers\/domains$/))) {
      if (m[1] !== CF_ACCOUNT) return send(404, null, [{ code: 7003, message: 'Could not route' }]);
      if (req.method === 'PUT') {
        const b = JSON.parse(body);
        const zone = CF_ZONES.find((z) => z.id === b.zone_id);
        if (!zone || !(b.hostname === zone.name || b.hostname.endsWith('.' + zone.name))) return send(400, null, [{ code: 100117, message: 'Hostname does not belong to zone' }]);
        // PUT: samme værtsnavn giver samme binding (ingen dubletter)
        const d = (domains[b.hostname] ??= { id: 'wd_' + (Object.keys(domains).length + 1), hostname: b.hostname, zone_id: b.zone_id, zone_name: zone.name });
        Object.assign(d, { service: b.service, environment: b.environment });
        return send(200, d);
      }
      if (req.method === 'GET') return send(200, Object.values(domains).filter((d) => !url.searchParams.get('hostname') || d.hostname === url.searchParams.get('hostname')));
    }
    if ((m = path.match(/^\/accounts\/([^/]+)\/workers\/domains\/([^/]+)$/)) && req.method === 'DELETE') {
      const d = Object.values(domains).find((x) => x.id === m[2]);
      if (!d) return send(404, null, [{ code: 100114, message: 'Domain not found' }]);
      delete domains[d.hostname];
      return send(200, null);
    }
    const chState = (ch) => {
      const active = !!state.cfActive?.[ch.hostname];
      return { ...ch, status: active ? 'active' : 'pending', ssl: { ...ch.ssl, status: active ? 'active' : 'pending_validation' } };
    };
    if ((m = path.match(/^\/zones\/([^/]+)\/custom_hostnames$/))) {
      if (req.method === 'GET') return send(200, Object.values(hostnames).filter((h) => h.zone === m[1] && h.hostname === url.searchParams.get('hostname')).map(chState));
      if (req.method === 'POST') {
        const b = JSON.parse(body);
        if (Object.values(hostnames).some((h) => h.hostname === b.hostname)) return send(409, null, [{ code: 1406, message: 'Duplicate custom hostname found.' }]);
        const id = 'ch_' + (Object.keys(hostnames).length + 1);
        hostnames[id] = { id, zone: m[1], hostname: b.hostname, ownership_verification: { type: 'txt', name: `_cf-custom-hostname.${b.hostname}`, value: `verif-${id}` },
          ssl: { method: 'txt', type: 'dv', validation_records: [{ txt_name: `_acme-challenge.${b.hostname}`, txt_value: `acme-${id}` }] } };
        return send(200, chState(hostnames[id]));
      }
    }
    if ((m = path.match(/^\/zones\/([^/]+)\/custom_hostnames\/([^/]+)$/))) {
      const ch = hostnames[m[2]];
      if (!ch) return send(404, null, [{ code: 1436, message: 'Custom hostname not found' }]);
      if (req.method === 'GET') return send(200, chState(ch));
      if (req.method === 'DELETE') {
        delete hostnames[m[2]];
        return send(200, { id: m[2] });
      }
    }
    return send(404, null, [{ code: 7003, message: `Unhandled ${req.method} ${path}` }]);
  }

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;
      const json = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      // --- Kontrol-endpoints til tests ---
      if (p === '/__mock/state' && req.method === 'POST') {
        const s = JSON.parse(body || '{}');
        Object.assign(state.customers, s.customers ?? {});
        Object.assign(state.subscriptions, s.subscriptions ?? {});
        if (s.invoices) state.invoices.push(...s.invoices);
        if (s.offerSessions) Object.assign((state.offerSessions ??= {}), s.offerSessions);
        if (s.rejectDuration !== undefined) state.rejectDuration = s.rejectDuration;
        if (s.failNext !== undefined) state.failNext = s.failNext;
        if (s.failEmailTo !== undefined) state.failEmailTo = s.failEmailTo;
        if (s.rejectManagedPayments !== undefined) state.rejectManagedPayments = s.rejectManagedPayments;
        for (const k of ['dns', 'https', 'cfActive']) if (s[k]) Object.assign((state[k] ??= {}), s[k]);
        for (const k of ['externalHtml', 'externalDown', 'githubFail', 'cfFail']) if (s[k] !== undefined) state[k] = s[k];
        return json(200, { ok: true });
      }
      if (p === '/__mock/calls') return json(200, state.calls);
      if (p === '/__mock/invoices') return json(200, state.invoices);
      if (p === '/__mock/sim') return json(200, { prices: state.prices ?? {}, offerSessions: state.offerSessions ?? {}, schedules: state.schedules ?? {}, subscriptions: state.subscriptions });
      if (p === '/__mock/coupons') return json(200, state.coupons ?? {});
      if (p === '/__mock/emails') return json(200, state.emails);
      if (p === '/__mock/kunder') return json(200, { cfCalls: state.cfCalls ?? [], cfDomains: state.cfDomains ?? {}, cfHostnames: state.cfHostnames ?? {}, dispatches: state.dispatches ?? [] });
      if (p.startsWith('/__mock/subscriptions/')) return json(200, state.subscriptions[p.split('/').pop()] ?? null);

      // --- Resend ---
      if (p === '/emails' && req.method === 'POST') {
        if (req.headers.authorization !== `Bearer ${RESEND_KEY}`) return json(401, { message: 'unauthorized' });
        const msg = JSON.parse(body);
        // Simuleret leveringsfejl til bestemte modtagere (fx en ophørsmeddelelse)
        if ((state.failEmailTo ?? []).includes(msg.to?.[0])) return json(500, { message: 'Simuleret leveringsfejl' });
        state.emails.push(msg);
        return json(200, { id: 'email_' + state.emails.length });
      }

      // --- Cloudflare API (domæner til kundehjemmesider) ---
      if (p.startsWith('/cf/')) return cloudflare(req, res, p, url, body);
      // --- DNS over HTTPS ---
      if (p === '/dns-query') {
        const name = url.searchParams.get('name');
        const type = url.searchParams.get('type');
        const hit = (state.dns ??= {})[name];
        return json(200, { Status: 0, Answer: hit && (hit === type || type === 'CNAME') ? [{ name, type: 5, data: 'kunde.veyro.dk.' }] : undefined });
      }
      // --- HTTPS-kontrol af et domæne: videresendes til stakken med domænets Host-header ---
      if (p === '/domaenetjek/_veyro/status') {
        const host = url.searchParams.get('host');
        if (!(state.https ??= {})[host]) return json(525, { error: 'SSL handshake failed' });
        return forwardWithHost(state.stackUrl, '/_veyro/status', host, res);
      }
      // --- GitHub: start "Deploy kunder" ---
      if (p.startsWith('/gh/')) {
        if (req.headers.authorization !== `Bearer ${GITHUB_TOKEN}`) return json(401, { message: 'Bad credentials' });
        if (req.method === 'POST' && /^\/gh\/repos\/[^/]+\/[^/]+\/actions\/workflows\/deploy-kunder\.yml\/dispatches$/.test(p)) {
          if (state.githubFail) return json(state.githubFail, { message: 'Simuleret fejl' });
          (state.dispatches ??= []).push({ path: p, body: JSON.parse(body || '{}') });
          res.writeHead(204);
          return res.end();
        }
        return json(404, { message: 'Not Found' });
      }
      // --- En specialbygget kundehjemmeside, som tilsluttes ---
      if (p === '/ekstern' || p === '/ekstern/') {
        if (state.externalDown) return json(503, { error: 'nede' });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(state.externalHtml ?? '<!doctype html><html><body><h1>Specialbygget side</h1></body></html>');
      }

      // --- Stripe ---
      const sim = p.startsWith('/__mock/');
      if (!p.startsWith('/v1/') && !sim) return json(404, { error: { message: 'not found' } });
      if (!sim && req.headers.authorization !== `Bearer ${MOCK_KEY}`) return stripeErr(res, 401, 'Invalid API key');
      const params = sim ? {} : req.method === 'GET' ? Object.fromEntries(url.searchParams) : parseForm(body);
      if (!sim) state.calls.push({ method: req.method, path: p, params, idempotencyKey: req.headers['idempotency-key'] ?? null });
      if (state.failNext && p.startsWith(state.failNext)) {
        state.failNext = null;
        return stripeErr(res, 500, 'Simuleret fejl');
      }

      let m;
      // --- Tilbud: priser, Checkout (abonnement), skemaer og simulerede betalinger ---
      const now = Math.floor(Date.now() / 1000);
      const idem = req.method === 'POST' ? req.headers['idempotency-key'] : null;
      state.idem ??= {};
      if (idem && state.idem[idem] && /^\/v1\/(checkout\/sessions|prices|subscription_schedules|customers)$/.test(p)) return json(200, state.idem[idem]);
      const remember = (obj) => { if (idem) state.idem[idem] = obj; return json(200, obj); };
      const addMonths = (t, k) => { const d = new Date(t * 1000); const y = d.getUTCFullYear(), mo = d.getUTCMonth() + k; const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
        return Math.floor(Date.UTC(y, mo, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()) / 1000); };
      const nextEnd = (t, interval) => addMonths(t, interval === 'year' ? 12 : 1);
      const withTax = (net, taxed) => (taxed ? Math.round(net * 1.25) : net);
      const makeInvoice = (sub, { amount, reason, paid, periodStart, periodEnd }) => {
        const inv = { id: 'in_sim' + String(state.invoices.length + 1).padStart(6, '0'), object: 'invoice', customer: sub.customer, subscription: sub.id,
          status: paid ? 'paid' : 'open', number: 'VEYRO-' + String(1000 + state.invoices.length), created: now, total: amount, amount_due: amount, amount_paid: paid ? amount : 0,
          currency: 'dkk', attempt_count: 1, billing_reason: reason, next_payment_attempt: paid ? null : now + 3 * 86400,
          hosted_invoice_url: 'https://invoice.stripe.com/i/sim' + state.invoices.length, invoice_pdf: 'https://pay.stripe.com/invoice/sim' + state.invoices.length + '/pdf',
          lines: { data: [{ period: { start: periodStart, end: periodEnd } }] } };
        state.invoices.push(inv);
        return inv;
      };
      if (p === '/v1/prices' && req.method === 'POST') {
        const id = 'price_sim' + String(state.calls.length).padStart(5, '0');
        const price = { id, object: 'price', unit_amount: Number(params.unit_amount), currency: params.currency, product: params.product ?? 'prod_onetime_' + state.calls.length,
          recurring: params['recurring[interval]'] ? { interval: params['recurring[interval]'] } : null, tax_behavior: params.tax_behavior ?? null };
        (state.prices ??= {})[id] = price;
        return remember(price);
      }
      if ((m = p.match(/^\/v1\/customers\/([^/]+)\/tax_ids$/)) && req.method === 'POST') return json(200, { id: 'txi_' + state.calls.length, type: params.type, value: params.value });
      if (p === '/v1/checkout/sessions' && req.method === 'POST' && params['metadata[veyro_offer]']) {
        const id = 'cs_offer_' + state.calls.length;
        const cs = { id, object: 'checkout.session', mode: params.mode, status: 'open', payment_status: 'unpaid', customer: params.customer, subscription: null,
          url: `https://checkout.stripe.com/c/pay/${id}`, expires_at: Number(params.expires_at), metadata: { veyro_offer: params['metadata[veyro_offer]'] }, _params: params };
        (state.offerSessions ??= {})[id] = cs;
        return remember(cs);
      }
      if ((m = p.match(/^\/v1\/checkout\/sessions\/([^/]+)\/expire$/)) && req.method === 'POST') {
        const cs = state.offerSessions?.[m[1]];
        if (!cs) return stripeErr(res, 404, 'No such session', 'resource_missing');
        if (cs.status !== 'open') return stripeErr(res, 400, 'Only open sessions can be expired');
        cs.status = 'expired';
        return json(200, cs);
      }
      if ((m = p.match(/^\/v1\/checkout\/sessions\/([^/]+)$/)) && req.method === 'GET' && state.offerSessions?.[m[1]]) {
        const { _params, ...cs } = state.offerSessions[m[1]];
        return json(200, cs);
      }
      // Simulerer at kunden gennemfører betalingen på Stripes side.
      if (p === '/__mock/checkout/complete' && req.method === 'POST') {
        const a = JSON.parse(body || '{}');
        const cs = state.offerSessions[a.session];
        const cp = cs._params;
        const rec = state.prices[cp['line_items[0][price]']];
        const setup = cp['line_items[1][price]'] ? state.prices[cp['line_items[1][price]']] : null;
        const taxed = !!cp['line_items[0][tax_rates][0]'];
        const trialEnd = cp['subscription_data[trial_end]'] ? Number(cp['subscription_data[trial_end]']) : null;
        const subId = 'sub_sim' + String(Object.keys(state.subscriptions).length + 1).padStart(6, '0');
        const periodEnd = trialEnd ?? nextEnd(now, rec.recurring.interval);
        const ok = a.paymentStatus !== 'unpaid';
        const sub = { id: subId, object: 'subscription', customer: cs.customer, status: !ok ? 'incomplete' : trialEnd ? 'trialing' : 'active', created: now, start_date: now,
          trial_end: trialEnd, billing_cycle_anchor: periodEnd, collection_method: 'charge_automatically', cancel_at_period_end: false, cancel_at: null, canceled_at: null, schedule: null,
          metadata: { veyro_offer: cp['subscription_data[metadata][veyro_offer]'], source: 'veyro-tilbud' },
          items: { data: [{ id: 'si_sim' + subId.slice(7), quantity: 1, current_period_start: now, current_period_end: periodEnd, tax_rates: taxed ? [{ id: cp['line_items[0][tax_rates][0]'] }] : [],
            price: { ...rec } }] } };
        state.subscriptions[subId] = sub;
        const amount = withTax((trialEnd ? 0 : rec.unit_amount) + (setup ? setup.unit_amount : 0), taxed);
        const invoice = makeInvoice(sub, { amount, reason: 'subscription_create', paid: ok, periodStart: now, periodEnd });
        Object.assign(cs, { status: 'complete', subscription: subId, payment_status: ok ? (amount ? 'paid' : 'no_payment_required') : 'unpaid' });
        const { _params, ...pub } = cs;
        return json(200, { session: pub, subscription: sub, invoice });
      }
      // Simulerer en fornyelse: næste periode faktureres (og et evt. skema skifter pris).
      if (p === '/__mock/renew' && req.method === 'POST') {
        const a = JSON.parse(body || '{}');
        const sub = state.subscriptions[a.subscription];
        const it = sub.items.data[0];
        const start = it.current_period_end;
        const sched = sub.schedule ? state.schedules[sub.schedule] : null;
        if (sched && sched.phases[1] && Number(sched.phases[0].end_date) <= start) {
          it.price = { ...state.prices[sched.phases[1].price] };
          sched.status = 'released'; sub.schedule = null;
        }
        const end = nextEnd(start, it.price.recurring.interval);
        Object.assign(it, { current_period_start: start, current_period_end: end });
        const invoice = makeInvoice(sub, { amount: withTax(it.price.unit_amount * (it.quantity ?? 1), it.tax_rates?.length > 0), reason: 'subscription_cycle', paid: !a.fail, periodStart: start, periodEnd: end });
        if (sub.status === 'trialing') sub.status = 'active';
        if (a.fail) sub.status = 'past_due'; else if (sub.status === 'past_due') sub.status = 'active';
        if (sub.cancel_at_period_end && start >= (sub.cancel_at ?? Infinity)) { sub.status = 'canceled'; sub.canceled_at = now; }
        return json(200, { subscription: sub, invoice });
      }
      if (p === '/__mock/end' && req.method === 'POST') {
        const a = JSON.parse(body || '{}');
        const sub = state.subscriptions[a.subscription];
        Object.assign(sub, { status: 'canceled', canceled_at: now, ended_at: now });
        return json(200, sub);
      }
      if (p === '/v1/subscription_schedules' && req.method === 'POST') {
        const sub = state.subscriptions[params.from_subscription];
        if (!sub) return stripeErr(res, 400, 'No such subscription');
        if (sub.schedule) return stripeErr(res, 400, 'Subscription already has a schedule');
        const id = 'sub_sched_' + state.calls.length;
        const it = sub.items.data[0];
        (state.schedules ??= {})[id] = { id, object: 'subscription_schedule', subscription: sub.id, status: 'active',
          phases: [{ start_date: it.current_period_start ?? sub.start_date, end_date: it.current_period_end, items: [{ price: it.price.id, quantity: it.quantity }] }] };
        sub.schedule = id;
        return remember(state.schedules[id]);
      }
      if ((m = p.match(/^\/v1\/subscription_schedules\/([^/]+)(\/release)?$/)) && req.method === 'POST') {
        const sc = state.schedules?.[m[1]];
        if (!sc) return stripeErr(res, 404, 'No such schedule', 'resource_missing');
        if (m[2]) {
          sc.status = 'released';
          state.subscriptions[sc.subscription].schedule = null;
          return json(200, sc);
        }
        if (state.rejectDuration && params['phases[1][duration][interval]']) return stripeErr(res, 400, 'Received unknown parameter: phases[1][duration]', 'parameter_unknown');
        sc.phases = [
          { start_date: Number(params['phases[0][start_date]']), end_date: Number(params['phases[0][end_date]']), price: params['phases[0][items][0][price]'] },
          { price: params['phases[1][items][0][price]'], iterations: params['phases[1][iterations]'] ?? null, duration: params['phases[1][duration][interval]'] ?? null },
        ];
        sc._params = params;
        // Første fase gælder fra nu: abonnementet får fasens pris (uden efterregning).
        const sub = state.subscriptions[sc.subscription];
        if (state.prices?.[sc.phases[0].price]) sub.items.data[0].price = { ...state.prices[sc.phases[0].price] };
        return json(200, sc);
      }
      if ((m = p.match(/^\/v1\/subscriptions\/([^/]+)$/)) && req.method === 'DELETE') {
        const sub = state.subscriptions[m[1]];
        if (!sub) return stripeErr(res, 404, 'No such subscription', 'resource_missing');
        Object.assign(sub, { status: 'canceled', canceled_at: now });
        return json(200, sub);
      }
      if (p === '/v1/subscriptions' && req.method === 'GET' && params.customer) {
        return json(200, { object: 'list', data: Object.values(state.subscriptions).filter((x) => x.customer === params.customer) });
      }
      if (p === '/v1/checkout/sessions' && req.method === 'POST') {
        const id = 'cs_test_' + state.calls.length;
        (state.sessions ??= {})[id] = params;
        return json(200, { id, object: 'checkout.session', url: `https://checkout.stripe.com/c/pay/${id}` });
      }
      if (p === '/v1/billing_portal/sessions' && req.method === 'POST') {
        return json(200, { id: 'bps_test', url: 'https://billing.stripe.com/p/session/test_123' });
      }
      if (p === '/v1/invoices/create_preview' && req.method === 'POST') {
        const price = params['subscription_details[items][0][price]'];
        return json(200, { object: 'invoice', amount_due: (PRICES[price] ?? 0) + 12345, next_payment_attempt: null, period_end: null });
      }
      if (p === '/v1/invoices' && req.method === 'GET') {
        const data = params.customer ? state.invoices.filter((i) => i.customer === params.customer) : [...state.invoices].reverse();
        return json(200, { object: 'list', data, has_more: false });
      }
      // --- Manuelle fakturaer (admin) ---
      if (p === '/v1/customers' && req.method === 'GET') {
        return json(200, { object: 'list', data: Object.values(state.customers).filter((c) => c.email === params.email) });
      }
      if (p === '/v1/customers' && req.method === 'POST') {
        const id = 'cus_new_' + state.calls.length;
        state.customers[id] = { id, object: 'customer', email: params.email, name: params.name ?? null };
        if (idem) state.idem[idem] = state.customers[id];
        return json(200, state.customers[id]);
      }
      if (p === '/v1/tax_rates' && req.method === 'GET') return json(200, { object: 'list', data: state.taxRates ?? [] });
      if (p === '/v1/tax_rates' && req.method === 'POST') {
        const rate = { id: 'txr_vat', percentage: Number(params.percentage), inclusive: params.inclusive === 'true', country: params.country };
        state.taxRates = [rate];
        return json(200, rate);
      }
      if (p === '/v1/invoices' && req.method === 'POST') {
        if (params['managed_payments[enabled]'] !== undefined && state.rejectManagedPayments) {
          return stripeErr(res, 400, 'Received unknown parameter: managed_payments', 'parameter_unknown');
        }
        const cust = state.customers[params.customer];
        if (!cust) return stripeErr(res, 400, 'No such customer', 'resource_missing');
        const inv = {
          id: 'in_test' + String(state.invoices.length + 1).padStart(6, '0'), object: 'invoice', customer: params.customer,
          customer_email: cust.email, customer_name: cust.name, status: 'draft', number: null, created: Math.floor(Date.now() / 1000),
          due_date: null, total: 0, amount_remaining: 0, currency: 'dkk', hosted_invoice_url: null, invoice_pdf: null, livemode: false,
          _tax: params['default_tax_rates[0]'] ? 25 : 0, _params: params,
        };
        state.invoices.push(inv);
        return json(200, inv);
      }
      if (p === '/v1/invoiceitems' && req.method === 'POST') {
        const inv = state.invoices.find((i) => i.id === params.invoice);
        if (!inv || inv.status !== 'draft') return stripeErr(res, 400, 'Invoice is not a draft');
        const net = Number(params.unit_amount_decimal) * Number(params.quantity ?? 1);
        inv.total += Math.round(net * (1 + inv._tax / 100));
        inv.amount_remaining = inv.total;
        return json(200, { id: 'ii_' + state.calls.length, object: 'invoiceitem' });
      }
      if ((m = p.match(/^\/v1\/invoices\/(in_[^/]+)(?:\/(finalize|send|pay|void))?$/))) {
        const inv = state.invoices.find((i) => i.id === m[1]);
        if (!inv) return stripeErr(res, 404, 'No such invoice', 'resource_missing');
        const act = m[2];
        if (req.method === 'GET' && !act) return json(200, inv);
        if (req.method === 'DELETE' && !act) {
          if (inv.status !== 'draft') return stripeErr(res, 400, 'Only drafts can be deleted');
          state.invoices.splice(state.invoices.indexOf(inv), 1);
          return json(200, { id: inv.id, deleted: true });
        }
        if (act === 'finalize') {
          if (inv.status !== 'draft') return stripeErr(res, 400, 'Invoice is already finalized');
          Object.assign(inv, { status: 'open', number: 'VEYRO-' + inv.id.slice(-4), due_date: inv.created + 8 * 86400,
            hosted_invoice_url: 'https://invoice.stripe.com/i/' + inv.id, invoice_pdf: 'https://pay.stripe.com/invoice/' + inv.id + '/pdf' });
          return json(200, inv);
        }
        if (act === 'send') {
          if (inv.status !== 'open') return stripeErr(res, 400, 'Invoice is not open');
          inv._sent = (inv._sent ?? 0) + 1;
          return json(200, inv);
        }
        if (act === 'pay' || act === 'void') {
          if (inv.status !== 'open') return stripeErr(res, 400, 'Invoice is not open');
          inv.status = act === 'pay' ? 'paid' : 'void';
          return json(200, inv);
        }
      }
      if ((m = p.match(/^\/v1\/checkout\/sessions\/([^/]+)$/)) && req.method === 'GET') {
        const sp = state.sessions?.[m[1]];
        if (!sp) return stripeErr(res, 404, 'No such session', 'resource_missing');
        return json(200, { id: m[1], mode: sp.mode, status: 'complete', customer: sp.customer,
          metadata: { veyro_subscription: sp['metadata[veyro_subscription]'] }, setup_intent: { id: 'seti_' + m[1], status: 'succeeded', payment_method: 'pm_card_' + m[1] } });
      }
      if ((m = p.match(/^\/v1\/customers\/([^/]+)$/)) && req.method === 'POST') {
        const c = state.customers[m[1]];
        if (!c) return stripeErr(res, 404, 'No such customer', 'resource_missing');
        if (params['invoice_settings[default_payment_method]']) c.invoice_settings = { default_payment_method: params['invoice_settings[default_payment_method]'] };
        if (params.name) c.name = params.name;
        return json(200, c);
      }
      if ((m = p.match(/^\/v1\/customers\/([^/]+)$/)) && req.method === 'GET') {
        const c = state.customers[m[1]];
        return c ? json(200, c) : stripeErr(res, 404, 'No such customer', 'resource_missing');
      }
      // --- Abonnementer oprettet af admin ---
      if (p === '/v1/products' && req.method === 'POST') {
        const id = 'prod_' + state.calls.length;
        (state.products ??= {})[id] = { id, name: params.name };
        return json(200, state.products[id]);
      }
      if (p === '/v1/coupons' && req.method === 'POST') {
        const c = { id: 'co_' + state.calls.length, name: params.name, duration: params.duration, duration_in_months: params.duration_in_months ? Number(params.duration_in_months) : null,
          percent_off: params.percent_off ? Number(params.percent_off) : null, amount_off: params.amount_off ? Number(params.amount_off) : null };
        (state.coupons ??= {})[c.id] = c;
        return json(200, c);
      }
      if (p === '/v1/subscriptions' && req.method === 'POST') {
        if (params['managed_payments[enabled]'] !== undefined && state.rejectManagedPayments) {
          return stripeErr(res, 400, 'Received unknown parameter: managed_payments', 'parameter_unknown');
        }
        if (!state.customers[params.customer]) return stripeErr(res, 400, 'No such customer', 'resource_missing');
        const id = 'sub_adm' + String(state.calls.length).padStart(6, '0');
        const now = Math.floor(Date.now() / 1000);
        const items = [];
        for (let i = 0; params[`items[${i}][price_data][product]`]; i++) {
          items.push({ id: `si_adm${state.calls.length}x${i}abc`, quantity: Number(params[`items[${i}][quantity]`] ?? 1), current_period_end: now + 30 * 86400,
            price: { id: 'price_adhoc_' + i, unit_amount: Number(params[`items[${i}][price_data][unit_amount]`]), currency: 'dkk', product: params[`items[${i}][price_data][product]`] } });
        }
        const trialEnd = params.trial_end ? Number(params.trial_end) : null;
        state.subscriptions[id] = { id, object: 'subscription', customer: params.customer, status: trialEnd ? 'trialing' : 'active', created: now, start_date: now,
          trial_end: trialEnd, collection_method: params.collection_method, default_payment_method: null, cancel_at_period_end: false, cancel_at: null, canceled_at: null, discounts: params['discounts[0][coupon]'] ? [params['discounts[0][coupon]']] : [],
          metadata: { source: params['metadata[source]'] }, items: { data: items }, _params: params };
        return json(200, state.subscriptions[id]);
      }
      if (p === '/v1/subscriptions' && req.method === 'GET') {
        const expand = Object.entries(params).filter(([k]) => k.startsWith('expand')).map(([, v]) => v);
        if (expand.some((e) => e.split('.').length > 4)) return stripeErr(res, 400, 'You cannot expand more than 4 levels of a property.', 'property_expansion_max_depth');
        const data = Object.values(state.subscriptions).map((sub) => ({
          ...sub,
          customer: state.customers[sub.customer] ?? sub.customer,
          // Nyere API-versioner: discount.source.coupon er et id
          discounts: (sub.discounts ?? []).map((d) => ({ id: 'di_' + d, source: { type: 'coupon', coupon: d } })),
          items: { data: sub.items.data.map((it) => ({ ...it, price: { ...it.price, product: it.price.product ?? 'prod_x' } })) },
        }));
        return json(200, { object: 'list', data: data.reverse() });
      }
      if (p === '/v1/products' && req.method === 'GET') {
        const ids = Object.entries(params).filter(([k]) => k.startsWith('ids')).map(([, v]) => v);
        return json(200, { object: 'list', data: ids.map((id) => state.products?.[id]).filter(Boolean) });
      }
      if ((m = p.match(/^\/v1\/coupons\/([^/]+)$/)) && req.method === 'GET') {
        const c = state.coupons?.[m[1]];
        return c ? json(200, c) : stripeErr(res, 404, 'No such coupon', 'resource_missing');
      }
      if ((m = p.match(/^\/v1\/subscriptions\/([^/]+)$/)) && req.method === 'POST' && state.subscriptions[m[1]] &&
          (params['items[0][price_data][unit_amount]'] || params['discounts[0][coupon]'] || params.discounts === '' || params.collection_method)) {
        const sub = state.subscriptions[m[1]];
        if (params.collection_method) {
          sub.collection_method = params.collection_method;
          sub.default_payment_method = params.default_payment_method ?? null;
        }
        if (params['items[0][price_data][unit_amount]']) {
          const it = sub.items.data.find((x) => x.id === params['items[0][id]']);
          if (!it) return stripeErr(res, 400, 'Bad item');
          it.price = { ...it.price, id: 'price_new_' + state.calls.length, unit_amount: Number(params['items[0][price_data][unit_amount]']), product: params['items[0][price_data][product]'] };
          sub._proration = params.proration_behavior;
        }
        if (params['discounts[0][coupon]']) sub.discounts = [params['discounts[0][coupon]']];
        if (params.discounts === '') sub.discounts = [];
        return json(200, sub);
      }
      if ((m = p.match(/^\/v1\/subscriptions\/([^/]+)$/))) {
        const sub = state.subscriptions[m[1]];
        if (!sub) return stripeErr(res, 404, 'No such subscription', 'resource_missing');
        if (req.method === 'GET') return json(200, params['expand[0]'] === 'customer' ? { ...sub, customer: state.customers[sub.customer] } : sub);
        if (req.method === 'POST') {
          if (params['items[0][price]']) {
            if (params['items[0][id]'] !== sub.items.data[0].id) return stripeErr(res, 400, 'Bad item');
            const price = params['items[0][price]'];
            sub.items.data[0].price = state.prices?.[price] ? { ...state.prices[price] } : { id: price, unit_amount: PRICES[price] ?? 0, currency: 'dkk' };
            sub._proration = params.proration_behavior;
          }
          if (params.cancel_at_period_end === 'true') {
            sub.cancel_at_period_end = true;
            sub.cancel_at = sub.items.data[0].current_period_end;
          } else if (params.cancel_at_period_end === 'false') {
            sub.cancel_at_period_end = false;
            sub.cancel_at = null;
          }
          return json(200, sub);
        }
      }
      return stripeErr(res, 404, `Unhandled ${req.method} ${p}`);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, url: `http://127.0.0.1:${port}`, state, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
