import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROOT, csrfFrom, demoLogin, opFrom, startStack } from './harness.mjs';

const K = 1000;

describe('Bilag: upload, aflæsning, fordeling, godkendelse og eksport', () => {
  let stack, owner, staff, sample;
  const bilag = (id) => stack.sql(`SELECT * FROM bilag WHERE id = ${id}`)[0];
  const stock = (pid) => stack.sql(`SELECT stock FROM products WHERE id = ${pid}`)[0]?.on_hand;

  beforeAll(async () => {
    const out = path.join(mkdtempSync(path.join(os.tmpdir(), 'samplepdf-')), 's.mjs');
    execFileSync('npx', ['esbuild', path.join(ROOT, 'src/lib/samplepdf.ts'), '--bundle', '--platform=node', '--format=esm', `--outfile=${out}`, '--log-level=error'], { cwd: ROOT });
    sample = await import(out);
    stack = await startStack({ demo: true, email: false });
    owner = await demoLogin(stack, 'ejer');
    staff = await demoLogin(stack, 'medarbejder');
  }, 240_000);
  afterAll(async () => stack?.stop());

  async function upload(client, base, bytes, name, fields = {}) {
    const page = await client.get(`${base}/ny`);
    const fd = new FormData();
    fd.set('_csrf', csrfFrom(page.html));
    fd.set('op', opFrom(page.html));
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    fd.append('files', new Blob([bytes], { type: 'application/pdf' }), name);
    return client.postMultipart(`${base}/ny`, fd);
  }

  let id;
  it('en PDF-faktura uploades, aflæses automatisk og ændrer ikke lageret', async () => {
    const before = stack.sql('SELECT SUM(stock) AS n FROM products')[0].n;
    const pdf = await sample.samplePdf({ kind: 'faktura', supplier: 'Testgrossisten ApS', address: 'Vej 1', cvr: '12345678', number: 'F-7781', date: '2026-10-01', due: '2026-10-15', buyer: 'Demo', lines: [{ sku: 'X1', name: 'Kabel 3x1,5', qty: 10 * K, unit: 'm', price: 1250 }], payment: 'Betales til konto 1234 5678901' });
    const res = await upload(owner, '/lager/bilag', pdf, 'faktura.pdf', { doc_type: 'faktura', payment: 'ikke_betalt' });
    expect(res.status).toBe(303);
    id = Number(res.headers.get('location').match(/bilag\/(\d+)/)[1]);
    const b = bilag(id);
    expect(b.status).toBe('klar');
    expect(b.supplier_name).toBe('Testgrossisten ApS');
    expect(b.doc_number).toBe('F-7781');
    expect(b.net).toBe(12500);
    expect(b.vat).toBe(3125);
    expect(b.total).toBe(15625);
    expect(stack.sql('SELECT SUM(stock) AS n FROM products')[0].n).toBe(before);
    const page = await owner.get(`/lager/bilag/${id}`);
    expect(page.status).toBe(200);
    expect(page.html).toContain('Digital visning af originalbilag');
    const f = await owner.get(`/lager/bilag/${id}/fil`);
    expect(f.headers.get('content-type')).toBe('application/pdf');
    expect(f.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    const v = await owner.get(`/lager/bilag/${id}/visning.pdf`);
    expect(v.html.startsWith('%PDF')).toBe(true);
  });

  it('samme fil igen markeres som mulig dublet', async () => {
    const pdf = await sample.samplePdf({ kind: 'faktura', supplier: 'Testgrossisten ApS', address: 'Vej 1', cvr: '12345678', number: 'F-7781', date: '2026-10-01', buyer: 'Demo', lines: [{ name: 'Kabel', qty: K, unit: 'm', price: 100 }] });
    const res = await upload(owner, '/lager/bilag', pdf, 'kopi.pdf', { doc_type: 'faktura', payment: 'ikke_betalt' });
    const id2 = Number(res.headers.get('location').match(/bilag\/(\d+)/)[1]);
    expect(bilag(id2).dup_of).toBe(id);
  });

  it('kan ikke godkendes før fordeling; godkendelse ændrer ikke lageret', async () => {
    let r = await owner.submit(`/lager/bilag/${id}`, `/lager/bilag/${id}`, { do: 'godkend' });
    expect(r.status).toBe(400);
    const job = stack.sql("SELECT id FROM jobs WHERE status = 'aktiv' LIMIT 1")[0].id;
    r = await owner.submit(`/lager/bilag/${id}`, `/lager/bilag/${id}`, { do: 'fordel', target: 'job', job_id: String(job), amount: '125,00', action: 'udgift' });
    expect(r.status).toBe(303);
    const before = stack.sql('SELECT SUM(stock) AS n FROM products')[0].n;
    r = await owner.submit(`/lager/bilag/${id}`, `/lager/bilag/${id}`, { do: 'godkend' });
    expect(r.status).toBe(303);
    expect(bilag(id).status).toBe('godkendt');
    expect(stack.sql('SELECT SUM(stock) AS n FROM products')[0].n).toBe(before);
  });

  it('medarbejderen ser kun egne bilag og kan ikke godkende', async () => {
    const pdf = await sample.samplePdf({ kind: 'kvittering', supplier: 'Byggemarked', address: 'Gade 2', cvr: '87654321', number: 'K-1', date: '2026-10-02', buyer: 'Demo', lines: [{ name: 'Skruer', qty: K, unit: 'pk', price: 4000 }] });
    const res = await upload(staff, '/job/bilag', pdf, 'kvit.pdf', { doc_type: 'kvittering', payment: 'medarbejder' });
    const sid = Number(res.headers.get('location').match(/bilag\/(\d+)/)[1]);
    expect(bilag(sid).payment).toBe('medarbejder');
    expect((await staff.get(`/job/bilag/${id}`)).status).toBe(404);
    expect((await staff.get('/lager/bilag')).status).toBe(303);
    const r = await staff.submit(`/job/bilag/${sid}`, `/job/bilag/${sid}`, { do: 'godkend' });
    expect(r.status).toBe(400);
    expect(bilag(sid).status).not.toBe('godkendt');
  });

  it('eksporten danner en ZIP og markerer bilaget som eksporteret (ikke bogført)', async () => {
    const page = await owner.get('/lager/bilag/eksport');
    const r = await owner.post('/lager/bilag/eksport', { _csrf: csrfFrom(page.html), op: opFrom(page.html), views: '1' });
    expect(r.status).toBe(303);
    const ex = stack.sql('SELECT * FROM exports ORDER BY id DESC LIMIT 1')[0];
    expect(ex.bilag_count).toBeGreaterThanOrEqual(1);
    expect(bilag(id).exported_version).toBe(1);
    const z = await owner.get(`/lager/bilag/eksport/${ex.id}.zip`);
    expect(z.headers.get('content-type')).toBe('application/zip');
    expect(z.html.slice(0, 2)).toBe('PK');
    // Rettes bilaget bagefter, er det ændret siden eksport og skal godkendes igen
    await owner.submit(`/lager/bilag/${id}`, `/lager/bilag/${id}`, { do: 'gem', doc_type: 'faktura', supplier_name: 'Testgrossisten A/S', supplier_cvr: '12345678', doc_number: 'F-7781', doc_date: '2026-10-01', currency: 'DKK', net: '125,00', vat: '31,25', total: '156,25', line_prices: 'ekskl', payment: 'ikke_betalt' });
    const b = bilag(id);
    expect(b.version).toBe(2);
    expect(b.status).toBe('klar');
  });
});
