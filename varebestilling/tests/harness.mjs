// Starter en mock af Resend + `wrangler dev --local` med en midlertidig lokal D1.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ADMIN_EMAIL = 'lager@butik.dk';
const RESEND_KEY = 're_test_mock';

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
  return { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', CI: '1' };
}

/** Lokal mock af Resends /emails-endpoint. */
function startMail() {
  const emails = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/emails') {
        if (req.headers.authorization !== `Bearer ${RESEND_KEY}`) {
          res.writeHead(401).end();
          return;
        }
        emails.push(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 'em_' + emails.length }));
        return;
      }
      if (req.url === '/__emails') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(emails));
        return;
      }
      res.writeHead(404).end();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}`, emails, close: () => new Promise((r) => server.close(r)) }),
    ),
  );
}

export async function startStack({ devMode = false } = {}) {
  const mail = await startMail();
  const port = await freePort();
  const persist = mkdtempSync(path.join(os.tmpdir(), 'vb-d1-'));
  const wrangler = path.join(ROOT, 'node_modules', '.bin', 'wrangler');
  execFileSync(wrangler, ['d1', 'migrations', 'apply', 'varebestilling', '--local', '--persist-to', persist], {
    cwd: ROOT,
    env: childEnv(),
    stdio: 'pipe',
  });
  const vars = {
    APP_URL: `http://127.0.0.1:${port}`,
    RESEND_API_BASE: mail.url,
    RESEND_API_KEY: RESEND_KEY,
    ADMIN_EMAILS: ADMIN_EMAIL,
    EMAIL_FROM: 'Testbutik <ordre@butik.dk>',
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
      if ((await fetch(base + '/healthz')).ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error('wrangler dev startede ikke:\n' + logs);
    await new Promise((r) => setTimeout(r, 300));
  }
  return {
    base,
    mail,
    persist,
    logs: () => logs,
    /** Kører SQL direkte mod den lokale database (til kontrol i tests). */
    sql(query) {
      const out = execFileSync(wrangler, ['d1', 'execute', 'varebestilling', '--local', '--persist-to', persist, '--json', '--command', query], {
        cwd: ROOT,
        env: childEnv(),
        stdio: 'pipe',
      });
      return JSON.parse(out.toString())[0].results;
    },
    async stop() {
      proc.kill('SIGTERM');
      await new Promise((r) => (proc.exitCode !== null ? r() : proc.once('exit', r)));
      await mail.close();
      rmSync(persist, { recursive: true, force: true });
    },
  };
}

/**
 * fetch med ét nyt forsøg, hvis serveren har lukket en genbrugt keep-alive-forbindelse
 * (sker, når testen har ventet på en langsom SQL-kontrol). Anmodningen er da aldrig modtaget.
 */
async function request(url, init) {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (err?.cause?.code !== 'UND_ERR_SOCKET') throw err;
    return fetch(url, init);
  }
}

/** Enkel cookie-jar-klient (manuel redirect-håndtering). */
export class Client {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
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
      if (attrs.some((a) => /max-age=0/i.test(a.trim())) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  async get(p, headers = {}) {
    const res = await request(this.base + p, { redirect: 'manual', headers: { Cookie: this.cookieHeader(), 'CF-Connecting-IP': this.ip, ...headers } });
    this.store(res);
    return Object.assign(res, { html: await res.text() });
  }
  async post(p, form = {}, headers = {}) {
    const res = await request(this.base + p, {
      method: 'POST',
      redirect: 'manual',
      headers: { Cookie: this.cookieHeader(), 'Content-Type': 'application/x-www-form-urlencoded', Origin: this.base, 'CF-Connecting-IP': this.ip, ...headers },
      body: new URLSearchParams(form).toString(),
    });
    this.store(res);
    return Object.assign(res, { html: await res.text() });
  }
  async postMultipart(p, formData) {
    const res = await request(this.base + p, {
      method: 'POST',
      redirect: 'manual',
      headers: { Cookie: this.cookieHeader(), Origin: this.base, 'CF-Connecting-IP': this.ip },
      body: formData,
    });
    this.store(res);
    return Object.assign(res, { html: await res.text() });
  }
  /** Henter en side og poster en formular med sidens CSRF-token. */
  async submit(pagePath, action, form = {}) {
    const page = await this.get(pagePath);
    return this.post(action, { _csrf: csrfFrom(page.html), ...form });
  }
}

export function csrfFrom(html) {
  const m = html.match(/name="_csrf" value="([^"]+)"/);
  if (!m) throw new Error('Ingen CSRF-token fundet');
  return m[1];
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

/** Fuldt magic-link-login via mock-Resend. Returnerer en logget-ind klient. */
export async function login(stack, email = ADMIN_EMAIL) {
  const client = new Client(stack.base);
  const before = stack.mail.emails.length;
  const res = await client.submit('/admin/login', '/admin/login', { email });
  if (res.status !== 200) throw new Error('login POST ' + res.status);
  const mail = await waitFor(() => stack.mail.emails.slice(before).find((e) => e.to[0] === email));
  const link = mail.text.match(/https?:\/\/\S+\/admin\/login\/bekraeft\?token=[A-Za-z0-9_%-]+/)[0];
  const confirm = await client.get(link.replace(stack.base, ''));
  const done = await client.post('/admin/login/bekraeft', { _csrf: csrfFrom(confirm.html), token: decodeURIComponent(new URL(link).searchParams.get('token')) });
  if (done.status !== 303) throw new Error('bekraeft ' + done.status + done.html);
  return client;
}

/** Importerer en CSV-tekst som admin (forhåndsvisning + udfør). */
export async function importCsv(admin, text) {
  const page = await admin.get('/admin/import');
  const preview = await admin.post('/admin/import', { _csrf: csrfFrom(page.html), text });
  if (preview.status !== 200) throw new Error('preview ' + preview.status + preview.html);
  const res = await admin.post('/admin/import/udfoer', { _csrf: csrfFrom(preview.html), text });
  return { preview, res };
}

/** Lægger varer i kurven og bestiller. Returnerer svaret fra kassen. */
export async function placeOrder(stack, items, details = {}) {
  const shopper = new Client(stack.base);
  for (const [id, qty] of items) {
    const res = await shopper.submit('/', '/kurv', { id: String(id), qty: String(qty), back: '/' });
    if (res.status !== 303) throw new Error('kurv ' + res.status);
  }
  const res = await shopper.submit('/kassen', '/kassen', {
    customer_name: 'Mette Kunde',
    customer_email: 'mette@example.dk',
    customer_phone: '12 34 56 78',
    delivery: 'afhentning',
    ...details,
  });
  return { shopper, res };
}
