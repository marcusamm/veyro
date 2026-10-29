// One real HTTP workflow in a temporary company database. All names/prices are TESTDATA;
// e-mails go only to the local Resend mock, never to a customer or a supplier.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, csrfFrom, demoLogin, opFrom, startStack } from './harness.mjs';

const K = 1000;
describe('Sammenhængende logistikforløb med tydeligt mærkede testdata', () => {
  let stack, owner, staff;
  beforeAll(async () => {
    stack = await startStack({ demo: true, email: true });
    owner = await demoLogin(stack, 'ejer');
    staff = await demoLogin(stack, 'medarbejder');
  }, 180000);
  afterAll(async () => { await stack?.stop(); });
  const one = query => stack.sql(query)[0];
  async function post(client, pagePath, action, values = {}) {
    const page = await client.get(pagePath);
    expect(page.status, pagePath).toBe(200);
    const form = { _csrf: csrfFrom(page.html), ...(/name="op"/.test(page.html) ? { op: opFrom(page.html) } : {}), ...values };
    const response = await client.post(action, form);
    expect(response.status, `${action}: ${response.html.slice(0, 200)}`).toBe(303);
    return { response, form };
  }

  it('job → estimat → præcist ét lagertræk → notifikation → indkøb → modtagelse → fakturaudkast', async () => {
    await post(owner, '/lager/varer/ny', '/lager/varer/ny', {
      sku: 'TEST-LOGISTIK-001', name: 'TESTDATA – Montagebeslag', description: 'Fiktiv testvare; ikke en leverandørpris.',
      unit: 'stk.', whole_units: '1', active: '1', initial_stock: '100',
      safety_method: 'antal', safety_qty: '20', reorder_point: '70',
      avg_daily_usage: '10', lead_time_days: '5', max_stock: '100', purchase_price: '10', sale_price: '20',
    });
    const p = one("SELECT * FROM products WHERE sku = 'TEST-LOGISTIK-001'");
    expect(p).toMatchObject({ stock: 100*K, reserved: 0, reorder_point: 70*K, purchase_price: 1000, sale_price: 2000 });
    await post(owner, '/job/ny', '/job/ny', {
      number: 'TEST-LOGISTIK-2026', name: 'TESTDATA – Samlet forløb', description: 'Automatisk lokal accepttest; ingen rigtig kunde.',
      customer_name: 'TESTDATA – Kunde', customer_address: 'Testvej 1, 0000 Testby', customer_email: 'kunde@example.invalid',
      start_date: '2026-10-29', stage: 'planlagt', hour_rate: '500', markup_pct: '20',
    });
    const j = one("SELECT * FROM jobs WHERE number = 'TEST-LOGISTIK-2026'");
    const selected = `/job/${j.id}/materialer/vare/${p.id}`;
    await post(owner, selected, selected, { qty: '20', unit: 'stk.', handling: 'forventet' });
    expect(one(`SELECT stock, reserved FROM products WHERE id=${p.id}`)).toEqual({ stock: 100*K, reserved: 0 });
    await post(owner, `/job/${j.id}/timer`, `/job/${j.id}/timer`, {
      phase: 'forventet', type: 'tid', qty: '2', description: 'TESTDATA – Forventet montage', billable: '1', unit_price: '500', internal_cost: '300',
    });
    await post(owner, `/job/${j.id}/overslag`, `/job/${j.id}/overslag`, { note: 'TESTDATA – vejledende, ikke fast pris.' });
    const quote = one(`SELECT * FROM job_quotes WHERE job_id=${j.id} ORDER BY version DESC LIMIT 1`);
    expect(quote).toMatchObject({ materials: 40000, labour: 100000, subtotal: 140000, incomplete: 0 });
    expect((await owner.get(`/job/${j.id}/overslag/${quote.id}.pdf`)).headers.get('content-type')).toBe('application/pdf');
    // Reservations are optional and reversible without touching physical stock.
    const planned = await post(staff, `/job/${j.id}/registrer?type=plan`, `/job/${j.id}/registrer`, { type: 'plan', [`q_${p.id}`]: '5', note: 'TESTDATA – reservation' });
    expect(one(`SELECT stock, reserved FROM products WHERE id=${p.id}`)).toEqual({ stock: 100*K, reserved: 5*K });
    await staff.post(`/job/${j.id}/registrer`, planned.form);
    expect(one(`SELECT reserved FROM products WHERE id=${p.id}`).reserved).toBe(5*K);
    await post(staff, `/job/${j.id}`, `/job/${j.id}/materiale/${p.id}`, { action: 'frigiv', qty: '5' });
    // Actual usage differs from the immutable estimate. Resubmission cannot consume twice.
    const consumption = await post(staff, `/job/${j.id}/registrer?type=forbrug`, `/job/${j.id}/registrer`, { type: 'forbrug', [`q_${p.id}`]: '30', note: 'TESTDATA – faktisk forbrug' });
    await staff.post(`/job/${j.id}/registrer`, consumption.form);
    expect(one(`SELECT stock, reserved, alert_level FROM products WHERE id=${p.id}`)).toEqual({ stock: 70*K, reserved: 0, alert_level: 1 });
    expect(one(`SELECT COUNT(*) n FROM movements WHERE product_id=${p.id} AND kind='forbrug'`).n).toBe(1);
    expect(one(`SELECT COUNT(*) n FROM notices WHERE product_id=${p.id} AND open=1`).n).toBe(1);
    const alerts = stack.sql("SELECT recipient,status FROM mails WHERE subject LIKE '%TESTDATA – Montagebeslag%'");
    expect(alerts).toHaveLength(2); // one message to each selected owner/buyer, not twice per action
    expect(alerts.every(m => m.status === 'simuleret' && m.recipient.endsWith('@nordlysbyg.example'))).toBe(true);
    expect(stack.mail.emails).toEqual([]);
    // A stock-refill list is separate from job lists. Neither sending nor ordering adds stock.
    await post(owner, `/lager/varer/${p.id}`, `/lager/varer/${p.id}/genbestil`, { qty: '30' });
    const line = one(`SELECT l.* FROM purchase_lines l JOIN purchase_lists pl ON pl.id=l.list_id WHERE l.product_id=${p.id} AND pl.kind='lager'`);
    expect(line).toMatchObject({ qty: 30*K, ordered: 0, received: 0 });
    const buyer = one("SELECT * FROM users WHERE role='indkober' LIMIT 1");
    await post(owner, `/lager/indkob/${line.list_id}`, `/lager/indkob/${line.list_id}/send`, { user_id: String(buyer.id) });
    expect(one(`SELECT stock FROM products WHERE id=${p.id}`).stock).toBe(70*K);
    await post(owner, '/lager/indkob', '/lager/indkob/bestil', { [`o_${line.id}`]: '30', [`d_${line.id}`]: '' });
    expect(one(`SELECT stock FROM products WHERE id=${p.id}`).stock).toBe(70*K);
    expect(one(`SELECT ordered, received FROM purchase_lines WHERE id=${line.id}`)).toEqual({ ordered: 30*K, received: 0 });
    const receipt = await post(owner, '/lager/modtagelse', '/lager/modtagelse', { [`r_${line.id}`]: '30' });
    await owner.post('/lager/modtagelse', receipt.form);
    expect(one(`SELECT stock, reserved, alert_level FROM products WHERE id=${p.id}`)).toEqual({ stock: 100*K, reserved: 0, alert_level: 0 });
    expect(one(`SELECT ordered, received FROM purchase_lines WHERE id=${line.id}`)).toEqual({ ordered: 30*K, received: 30*K });
    await post(owner, `/job/${j.id}/timer`, `/job/${j.id}/timer`, {
      phase: 'faktisk', type: 'tid', qty: '3', description: 'TESTDATA – Faktisk montage', work_date: '2026-10-29',
      billable: '1', unit_price: '500', internal_cost: '300', approve: '1',
    });
    await post(owner, `/job/${j.id}`, `/job/${j.id}/status`, { stage: 'afsluttet' });
    expect(one(`SELECT status FROM jobs WHERE id=${j.id}`).status).toBe('afsluttet');
    const draft = await post(owner, `/job/${j.id}/faktura`, `/job/${j.id}/faktura`, { mode: 'medgaaet' });
    const invoiceId = Number(draft.response.headers.get('location').match(/faktura\/(\d+)/)[1]);
    const invoice = one(`SELECT * FROM invoices WHERE id=${invoiceId}`);
    expect(invoice).toMatchObject({ status: 'kladde', number: null, quote_id: quote.id });
    const items = stack.sql(`SELECT * FROM invoice_items WHERE invoice_id=${invoiceId}`);
    // Draft totals are calculated from editable lines; stored invoice totals
    // are frozen only when an invoice is actually issued.
    const actual = items.filter(x => x.include && !x.covered).reduce((sum,x) => sum + Math.round(x.qty*x.unit_price/K),0);
    expect(actual).toBe(210000);
    expect(actual - quote.subtotal).toBe(70000);
    expect(items.find(x => x.type==='materiale')).toMatchObject({ qty: 30*K, unit_price: 2000, unit_cost: 1000 });
    expect(items.find(x => x.type==='tid')).toMatchObject({ qty: 3*K, unit_price: 50000, unit_cost: 30000 });
    const draftPage = await owner.get(`/job/faktura/${invoiceId}`);
    expect(draftPage.html).toContain('2.100');
    expect(draftPage.html).toContain('700');
    const pdf = await owner.get(`/job/faktura/${invoiceId}.pdf`);
    expect(pdf.status).toBe(200); expect(pdf.headers.get('content-type')).toBe('application/pdf'); expect(pdf.html.startsWith('%PDF')).toBe(true);
    expect(one(`SELECT data FROM job_quotes WHERE id=${quote.id}`).data).toBe(quote.data);
    const staffInvoice = await staff.get(`/job/faktura/${invoiceId}.pdf`);
    expect(staffInvoice.status).toBe(303);
    // An unauthenticated client cannot address either portal's records by ID.
    const outsider = new Client(stack.base);
    expect((await outsider.get(`/lager/varer/${p.id}`)).headers.get('location')).toContain('/login');
    expect((await outsider.get(`/job/${j.id}`)).headers.get('location')).toContain('/login');
  }, 180000);

  it('en anden virksomheds database og sessioner giver ingen adgang til testjobbet', async () => {
    const other = await startStack({ demo: true, email: false });
    try {
      const otherOwner = await demoLogin(other, 'ejer');
      expect(other.sql("SELECT COUNT(*) n FROM products WHERE sku='TEST-LOGISTIK-001'")[0].n).toBe(0);
      expect(other.sql("SELECT COUNT(*) n FROM jobs WHERE number='TEST-LOGISTIK-2026'")[0].n).toBe(0);
      const copiedSession = new Client(other.base);
      copiedSession.cookies = new Map(owner.cookies);
      expect((await copiedSession.get('/lager/varer')).headers.get('location')).toContain('/login');
      const job = one("SELECT id FROM jobs WHERE number='TEST-LOGISTIK-2026'");
      expect((await otherOwner.get(`/job/${job.id}`)).status).toBe(404);
      expect((await owner.get(`/job/${job.id}`)).status).toBe(200);
    } finally { await other.stop(); }
  }, 180000);
});
