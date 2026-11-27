// Isolated LOCAL Worker + D1 + fake email/payment services. Never uses production data.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { ADMIN_EMAIL, Client, csrfFrom, login, startStack } from '../tests/harness.mjs';

const fixtures = mkdtempSync(path.join(tmpdir(), 'veyro-accounting-fixtures-'));
async function pdf(name, lines) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText('VEYRO - FICTITIOUS TEST DATA', { x: 40, y: 800, size: 15, font });
  lines.forEach((line, i) => page.drawText(line, { x: 40, y: 755 - i * 25, size: 12, font }));
  const bytes = await doc.save();
  writeFileSync(path.join(fixtures, name), bytes);
  return bytes;
}
const csv = [
  'Completed Date,Description,Amount,Currency,State,Balance,ID',
  '2026-11-23,Netto,-74.95,DKK,COMPLETED,925.05,TEST-NETTO-1',
  '2026-11-23,Apple,-125.00,DKK,COMPLETED,800.05,TEST-APPLE-1',
  '2026-11-23,Refund from Apple,125.00,DKK,COMPLETED,925.05,TEST-APPLE-REFUND-1',
  '2026-11-23,Basic plan fee,-85.00,DKK,COMPLETED,840.05,TEST-FEE-1',
  '2026-11-23,Example Webhosting,-125.00,DKK,COMPLETED,715.05,TEST-HOSTING-1',
].join('\n');
writeFileSync(path.join(fixtures, 'revolut-test.csv'), csv);
const fee = await pdf('revolut-gebyr-85.pdf', [
  'Revolut Business', 'Transaction confirmation', 'Status: Completed',
  'Completed date: 23.11.2026', 'Description: Basic plan fee', 'Money out: 85,00 DKK',
  'Currency: DKK', 'Transaction ID: TEST-FEE-1', 'Balance: 840,05 DKK',
]);
const invoice = await pdf('webhosting-125.pdf', [
  'Example Webhosting ApS', 'Faktura TEST-HOSTING-001', 'CVR: 12345678',
  'Fakturadato: 23.11.2026', 'Webhosting for november 2026',
  'Subtotal: 100,00 DKK', 'Moms 25%: 25,00 DKK', 'Total: 125,00 DKK',
]);
const multi = await pdf('revolut-flere-poster.pdf', [
  'Revolut Business', 'Account statement',
  'Date | Description | Money out | Money in | Currency | State | ID',
  '23.11.2026 | Basic plan fee | 85,00 | | DKK | Completed | TEST-FEE-1',
  '23.11.2026 | Apple | 125,00 | | DKK | Completed | TEST-APPLE-1',
]);
void multi;

console.log('Starter isoleret lokal testdatabase. Ingen produktionstjenester kontaktes.');
const stack = await startStack({ devMode: true });
let stopped = false;
async function cleanup() { if (stopped) return; stopped = true; await stack.stop(); process.exit(0); }
process.on('SIGINT', cleanup); process.on('SIGTERM', cleanup);
try {
  const { client } = await login(stack, ADMIN_EMAIL);
  const main = await client.get('/admin/bogfoering');
  if (main.status !== 200) throw new Error(`Bogføring svarede ${main.status}: ${main.html.slice(0, 500)}`);
  const csrf = csrfFrom(main.html);
  async function upload(route, name, bytes, type, values = {}) {
    const form = new FormData();
    form.set('_csrf', csrf); form.set('file', new File([bytes], name, { type }));
    for (const [k, v] of Object.entries(values)) form.set(k, v);
    const res = await fetch(stack.base + route, { method: 'POST', body: form, redirect: 'manual', headers: { Cookie: client.cookieHeader(), Origin: stack.base, 'CF-Connecting-IP': client.ip } });
    if (res.status !== 303) throw new Error(`Upload ${name}: ${res.status} ${(await res.text()).slice(-1000)}`);
    return res.headers.get('location');
  }
  const preview = await upload('/admin/bogfoering/bank/import', 'revolut-test.csv', csv, 'text/csv', { account: 'TEST-Revolut-DKK' });
  const confirmed = await client.post(`${preview}/bekraeft`, { _csrf: csrf });
  if (confirmed.status !== 303) throw new Error(`Import: ${confirmed.status} ${confirmed.html.slice(-1000)}`);
  const feeUrl = await upload('/admin/bogfoering/bilag', 'revolut-gebyr-85.pdf', fee, 'application/pdf');
  const receiptUrl = await upload('/admin/bogfoering/bilag', 'webhosting-125.pdf', invoice, 'application/pdf', { bank_line_id: '5' });
  // A fresh one-time login link for the browser (the seed client's token was consumed).
  const browserClient = new Client(stack.base);
  const loginPage = await browserClient.get('/login');
  const sent = await browserClient.post('/login', { _csrf: csrfFrom(loginPage.html), email: ADMIN_EMAIL });
  if (sent.status !== 200) throw new Error('Kunne ikke oprette lokal loginadgang.');
  const emails = await (await fetch(stack.mock.url + '/__mock/emails')).json();
  const mail = emails.filter(e => e.to[0] === ADMIN_EMAIL).at(-1);
  const link = mail.text.match(/https?:\/\/\S+\/login\/bekraeft\?token=[A-Za-z0-9_%-]+/)[0];
  console.log(`\nLokal test-login (klik derefter Bekræft login):\n${link}`);
  console.log(`\nBogføring: ${stack.base}/admin/bogfoering\nBank: ${stack.base}/admin/bogfoering?tab=bank`);
  console.log(`Gebyrkladde: ${stack.base}${feeUrl}\nWebhostingkladde: ${stack.base}${receiptUrl}`);
  console.log(`\nFiktive prøvefiler: ${fixtures}`);
  console.log('Testkonto: admin@veyro.dk. Nye loginlinks vises i det lokale loginflow. Ingen mails sendes.');
  console.log('5 banklinjer og 2 ubogførte kladder. Stop med Ctrl+C; databasen fjernes, prøvefilerne bevares.');
  setInterval(() => {}, 60_000);
} catch (error) {
  console.error(error);
  console.error(stack.logs().slice(-3000));
  await stack.stop(); process.exit(1);
}
