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

export function startMock() {
  const state = { customers: {}, subscriptions: {}, invoices: [], calls: [], emails: [], failNext: null };

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
        if (s.failNext !== undefined) state.failNext = s.failNext;
        if (s.rejectManagedPayments !== undefined) state.rejectManagedPayments = s.rejectManagedPayments;
        return json(200, { ok: true });
      }
      if (p === '/__mock/calls') return json(200, state.calls);
      if (p === '/__mock/invoices') return json(200, state.invoices);
      if (p === '/__mock/coupons') return json(200, state.coupons ?? {});
      if (p === '/__mock/emails') return json(200, state.emails);
      if (p.startsWith('/__mock/subscriptions/')) return json(200, state.subscriptions[p.split('/').pop()] ?? null);

      // --- Resend ---
      if (p === '/emails' && req.method === 'POST') {
        if (req.headers.authorization !== `Bearer ${RESEND_KEY}`) return json(401, { message: 'unauthorized' });
        const msg = JSON.parse(body);
        state.emails.push(msg);
        return json(200, { id: 'email_' + state.emails.length });
      }

      // --- Stripe ---
      if (!p.startsWith('/v1/')) return json(404, { error: { message: 'not found' } });
      if (req.headers.authorization !== `Bearer ${MOCK_KEY}`) return stripeErr(res, 401, 'Invalid API key');
      const params = req.method === 'GET' ? Object.fromEntries(url.searchParams) : parseForm(body);
      state.calls.push({ method: req.method, path: p, params, idempotencyKey: req.headers['idempotency-key'] ?? null });
      if (state.failNext && p.startsWith(state.failNext)) {
        state.failNext = null;
        return stripeErr(res, 500, 'Simuleret fejl');
      }

      let m;
      if (p === '/v1/checkout/sessions' && req.method === 'POST') {
        const id = 'cs_test_' + state.calls.length;
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
          trial_end: trialEnd, cancel_at_period_end: false, cancel_at: null, canceled_at: null, discounts: params['discounts[0][coupon]'] ? [params['discounts[0][coupon]']] : [],
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
          (params['items[0][price_data][unit_amount]'] || params['discounts[0][coupon]'] || params.discounts === '')) {
        const sub = state.subscriptions[m[1]];
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
        if (req.method === 'GET') return json(200, sub);
        if (req.method === 'POST') {
          if (params['items[0][price]']) {
            if (params['items[0][id]'] !== sub.items.data[0].id) return stripeErr(res, 400, 'Bad item');
            const price = params['items[0][price]'];
            sub.items.data[0].price = { id: price, unit_amount: PRICES[price] ?? 0, currency: 'dkk' };
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
