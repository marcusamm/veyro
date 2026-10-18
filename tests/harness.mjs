// Starter mock-Stripe/Resend + `wrangler dev --local` med en midlertidig lokal D1.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOCK_KEY, RESEND_KEY, startMock } from './mock-server.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WEBHOOK_SECRET = 'whsec_test_secret_123';
export const ADMIN_EMAIL = 'admin@veyro.dk';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

function childEnv() {
  const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', CI: '1' };
  return env;
}

export async function startStack({ minMonths = 12, devMode = false, resend = true } = {}) {
  const mock = await startMock();
  const port = await freePort();
  const persist = mkdtempSync(path.join(os.tmpdir(), 'vk-d1-'));
  const wrangler = path.join(ROOT, 'node_modules', '.bin', 'wrangler');

  execFileSync(wrangler, ['d1', 'migrations', 'apply', 'veyro-kundepanel', '--local', '--persist-to', persist], {
    cwd: ROOT,
    env: childEnv(),
    stdio: 'pipe',
  });

  const vars = {
    APP_URL: `http://127.0.0.1:${port}`,
    STRIPE_API_BASE: mock.url,
    RESEND_API_BASE: mock.url,
    STRIPE_SECRET_KEY: MOCK_KEY,
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    RESEND_API_KEY: resend ? RESEND_KEY : '',
    PRICE_STARTER: 'price_starter_test',
    PRICE_BUSINESS: 'price_business_test',
    PRICE_PREMIUM: 'price_premium_test',
    MIN_MONTHS: String(minMonths),
    ADMIN_EMAILS: ADMIN_EMAIL,
    NOTIFY_EMAIL: 'kontakt@veyro.dk',
    DEV_MODE: devMode ? '1' : '0',
  };
  const args = ['dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', persist,
    '--show-interactive-dev-session=false', '--log-level', 'log'];
  for (const [k, v] of Object.entries(vars)) args.push('--var', `${k}:${v}`);

  const proc = spawn(wrangler, args, { cwd: ROOT, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  proc.stdout.on('data', (d) => (logs += d));
  proc.stderr.on('data', (d) => (logs += d));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error('wrangler dev stoppede:\n' + logs);
    try {
      const r = await fetch(base + '/healthz');
      if (r.ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error('wrangler dev startede ikke:\n' + logs);
    await new Promise((r) => setTimeout(r, 300));
  }

  return {
    base,
    mock,
    logs: () => logs,
    async stop() {
      proc.kill('SIGTERM');
      await new Promise((r) => (proc.exitCode !== null ? r() : proc.once('exit', r)));
      await mock.close();
      rmSync(persist, { recursive: true, force: true });
    },
  };
}

// ---------- Hjælpere ----------

/** Enkel cookie-jar-klient (manuel redirect-håndtering). */
export class Client {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
    // Hver klient får sin egen (test-)IP, så IP-rate-limit ikke rammer på tværs af tests
    this.ip = `198.51.100.${Math.floor(Math.random() * 250) + 1}`;
  }
  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  store(res) {
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      const expired = attrs.some((a) => /max-age=0/i.test(a.trim())) || value === '';
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  async get(p, headers = {}) {
    const res = await fetch(this.base + p, { redirect: 'manual', headers: { Cookie: this.cookieHeader(), 'CF-Connecting-IP': this.ip, ...headers } });
    this.store(res);
    return Object.assign(res, { html: await res.text() });
  }
  async post(p, form = {}, headers = {}) {
    const res = await fetch(this.base + p, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Cookie: this.cookieHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: this.base,
        'CF-Connecting-IP': this.ip,
        ...headers,
      },
      body: new URLSearchParams(form).toString(),
    });
    this.store(res);
    return Object.assign(res, { html: await res.text() });
  }
}

export function csrfFrom(html) {
  const m = html.match(/name="_csrf" value="([^"]+)"/);
  if (!m) throw new Error('Ingen CSRF-token fundet');
  return m[1];
}

export async function signedWebhook(base, event, secret = WEBHOOK_SECRET, { timestamp } = {}) {
  const { createHmac } = await import('node:crypto');
  const payload = JSON.stringify(event);
  const t = timestamp ?? Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return fetch(base + '/stripe/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${sig}` },
    body: payload,
  });
}

export async function setMockState(mock, state) {
  await fetch(mock.url + '/__mock/state', { method: 'POST', body: JSON.stringify(state) });
}

export async function waitFor(fn, timeout = 5000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor: timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Opretter en kunde + abonnement via en signeret checkout.session.completed-webhook. */
export async function seedCustomer(stack, { email, name, cus, sub, price, start, status, periodEnd, cancelAtPeriodEnd }) {
  const { makeSubscription } = await import('./mock-server.mjs');
  const subscription = makeSubscription({ id: sub, customer: cus, price, start, status, periodEnd, cancelAtPeriodEnd });
  await setMockState(stack.mock, {
    customers: { [cus]: { id: cus, object: 'customer', email, name } },
    subscriptions: { [sub]: subscription },
  });
  const res = await signedWebhook(stack.base, {
    id: 'evt_checkout_' + sub,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_' + sub,
        object: 'checkout.session',
        mode: 'subscription',
        customer: cus,
        subscription: sub,
        customer_details: { email, name },
      },
    },
  });
  if (res.status !== 200) throw new Error('seed webhook fejlede: ' + res.status + ' ' + (await res.text()));
  return subscription;
}

/** Fuldt magic-link-login via mock-Resend. Returnerer en logget-ind klient. */
export async function login(stack, email) {
  const client = new Client(stack.base);
  const page = await client.get('/login');
  const before = (await (await fetch(stack.mock.url + '/__mock/emails')).json()).length;
  const res = await client.post('/login', { _csrf: csrfFrom(page.html), email });
  if (res.status !== 200) throw new Error('login POST ' + res.status);
  const mail = await waitFor(async () => {
    const emails = await (await fetch(stack.mock.url + '/__mock/emails')).json();
    return emails.slice(before).find((e) => e.to[0] === email);
  });
  const link = mail.text.match(/https?:\/\/\S+\/login\/bekraeft\?token=[A-Za-z0-9_%-]+/)[0];
  const confirm = await client.get(link.replace(stack.base, ''));
  const done = await client.post('/login/bekraeft', {
    _csrf: csrfFrom(confirm.html),
    token: decodeURIComponent(new URL(link).searchParams.get('token')),
  });
  if (done.status !== 303) throw new Error('bekraeft ' + done.status + done.html);
  return { client, link, redirect: done.headers.get('location') };
}
