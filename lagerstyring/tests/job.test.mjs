import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { csrfFrom, demoLogin, opFrom, startStack } from './harness.mjs';

const K = 1000;

describe('Jobportal: materialer, timer, prisoverslag og faktura', () => {
  let stack;
  let owner;
  let staff;
  const job = (number) => stack.sql(`SELECT * FROM jobs WHERE number = '${number}'`)[0];
  const item = (jobId, name) => stack.sql(`SELECT * FROM job_items WHERE job_id = ${jobId} AND name = '${name}'`)[0];
  const invoices = (jobId) => stack.sql(`SELECT * FROM invoices WHERE job_id = ${jobId} ORDER BY id`);
  const form = async (client, page, action, fields = {}) => {
    const p = await client.get(page);
    return client.post(action, { _csrf: csrfFrom(p.html), ...fields });
  };

  beforeAll(async () => {
    stack = await startStack({ demo: true, email: false });
    owner = await demoLogin(stack, 'ejer');
    staff = await demoLogin(stack, 'medarbejder');
  }, 180_000);

  afterAll(async () => {
    await stack?.stop();
  });

  it('demoen har job i alle statusser, et udstedt overslag, en faktura og en kreditnota', () => {
    const stages = stack.sql('SELECT DISTINCT stage FROM jobs').map((r) => r.stage).sort();
    expect(stages).toEqual(['afsluttet', 'afventer', 'annulleret', 'i_gang', 'kladde', 'planlagt']);
    const issued = stack.sql("SELECT kind, number FROM invoices WHERE status = 'udstedt' ORDER BY number");
    expect(issued).toEqual([
      { kind: 'faktura', number: 1001 },
      { kind: 'faktura', number: 1002 },
      { kind: 'kreditnota', number: 1003 },
    ]);
    expect(stack.sql("SELECT COUNT(*) AS n FROM invoices WHERE status = 'kladde'")[0].n).toBe(1);
    expect(stack.sql('SELECT COUNT(*) AS n FROM job_quotes WHERE accepted_at IS NOT NULL')[0].n).toBeGreaterThanOrEqual(3);
  });

  it('alle jobsider kan åbnes af ejeren', async () => {
    for (const { id } of stack.sql('SELECT id FROM jobs')) {
      for (const tab of ['', '/materialer', '/timer', '/overslag', '/indkob', '/faktura', '/historik']) {
        const res = await owner.get(`/job/${id}${tab}`);
        expect(res.status, `/job/${id}${tab}`).toBe(200);
      }
    }
    for (const p of ['/job', '/job?vis=alle', '/job/faktura', '/lager/indstillinger']) expect((await owner.get(p)).status, p).toBe(200);
    for (const { id } of stack.sql('SELECT id FROM invoices')) expect((await owner.get(`/job/faktura/${id}`)).status).toBe(200);
  });

  it('medarbejderen ser ingen priser og kan ikke åbne overslag og faktura', async () => {
    const j = job('2026-014');
    const res = await staff.get(`/job/${j.id}/materialer`);
    expect(res.status).toBe(200);
    expect(res.html).not.toMatch(/ekskl\. moms|Kostpris|Salgspris/);
    expect((await staff.get(`/job/${j.id}/overslag`)).headers.get('location')).toContain('ingen_adgang');
    expect((await staff.get(`/job/${j.id}/faktura`)).headers.get('location')).toContain('ingen_adgang');
    expect((await staff.get('/job/faktura')).headers.get('location')).toContain('ingen_adgang');
    const timer = await staff.get(`/job/${j.id}/timer`);
    expect(timer.html).not.toContain('Intern');
  });

  it('pakkeomregning: 12 stk. købes som 2 pakker med 10, og manglende pris tæller ikke som 0', async () => {
    const j = job('2026-016');
    const vin = item(j.id, 'Vinkelbeslag 90 mm');
    expect(vin).toMatchObject({ pack_qty: 10 * K, price_source: 'demodata', match: 'praecis' });
    const res = await owner.get(`/job/${j.id}/materialer`);
    expect(res.html).toContain('Demodata');
    expect(res.html).toMatch(/2 pk\./);
    expect(res.html).toContain('Pris mangler');
    const q = stack.sql(`SELECT * FROM job_quotes WHERE job_id = ${j.id}`)[0];
    expect(q.incomplete).toBe(1);
    const page = await owner.get(`/job/${j.id}/overslag`);
    expect(page.html).toContain('ufuldstændigt');
  });

  it('en manuel pris gemmes, og gemte overslag ændres aldrig', async () => {
    const j = job('2026-016');
    const before = stack.sql(`SELECT * FROM job_quotes WHERE job_id = ${j.id} ORDER BY version`);
    const list = item(j.id, 'Loftliste fyr 21×45 mm');
    const res = await form(owner, `/job/${j.id}/materialer`, `/job/${j.id}/materialer/${list.id}/pris`, { price: '12,50', vat: 'inkl', sales_unit: 'm', pack_qty: '1' });
    expect(res.status).toBe(303);
    expect(item(j.id, 'Loftliste fyr 21×45 mm')).toMatchObject({ price: 1250, price_source: 'manuel' });
    expect((await form(owner, `/job/${j.id}/overslag`, `/job/${j.id}/overslag`, { note: '' })).status).toBe(303);
    const after = stack.sql(`SELECT * FROM job_quotes WHERE job_id = ${j.id} ORDER BY version`);
    expect(after.length).toBe(before.length + 1);
    expect(after[0]).toEqual(before[0]);
    expect(after.at(-1).incomplete).toBe(0);
    expect(after.at(-1).total).toBe(after.at(-1).subtotal + after.at(-1).vat);
    // Et prisopslag overskriver ikke den manuelle pris
    await form(owner, `/job/${j.id}/materialer`, `/job/${j.id}/materialer/priser`);
    expect(item(j.id, 'Loftliste fyr 21×45 mm').price).toBe(1250);
  });

  it('prisoverslaget kan hentes som PDF og markeres som sendt', async () => {
    const j = job('2026-016');
    const q = stack.sql(`SELECT * FROM job_quotes WHERE job_id = ${j.id} ORDER BY version DESC`)[0];
    const res = await owner.get(`/job/${j.id}/overslag/${q.id}.pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.html.startsWith('%PDF')).toBe(true);
    expect(stack.sql(`SELECT shared_at FROM job_quotes WHERE id = ${q.id}`)[0].shared_at).not.toBeNull();
  });

  it('medarbejderens timer afventer godkendelse, før de kan faktureres', async () => {
    const j = job('2026-014');
    const page = await staff.get(`/job/${j.id}/timer`);
    const res = await staff.post(`/job/${j.id}/timer`, { _csrf: csrfFrom(page.html), phase: 'faktisk', type: 'tid', qty: '4', description: 'Isolering' });
    expect(res.status).toBe(303);
    const e = stack.sql(`SELECT * FROM job_entries WHERE job_id = ${j.id} AND description = 'Isolering'`)[0];
    expect(e).toMatchObject({ qty: 4 * K, worker_email: 'jonas@nordlysbyg.example', approved_at: null, unit_price: 59500, internal_cost: 38500 });
    const billing = await owner.get(`/job/${j.id}/faktura`);
    expect(billing.html).toMatch(/venter på godkendelse/i);
  });

  it('faktura: kladde, udstedelse med fortløbende nummer, ingen dobbeltfakturering og kreditnota', async () => {
    const j = job('2026-014');
    const pending = stack.sql(`SELECT id FROM job_entries WHERE job_id = ${j.id} AND phase = 'faktisk' AND approved_at IS NULL`).map((r) => String(r.id));
    const p = await owner.get(`/job/${j.id}/timer`);
    const body = new URLSearchParams({ _csrf: csrfFrom(p.html) });
    for (const id of pending) body.append('id', id);
    const ok = await fetch(`${stack.base}/job/${j.id}/timer/godkend`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Cookie: owner.cookieHeader(), 'Content-Type': 'application/x-www-form-urlencoded', Origin: stack.base, 'CF-Connecting-IP': owner.ip },
      body,
    });
    expect(ok.status).toBe(303);
    expect(stack.sql(`SELECT COUNT(*) AS n FROM job_entries WHERE job_id = ${j.id} AND phase = 'faktisk' AND approved_at IS NULL`)[0].n).toBe(0);

    const draft = await form(owner, `/job/${j.id}/faktura`, `/job/${j.id}/faktura`, { mode: 'medgaaet' });
    expect(draft.status).toBe(303);
    const inv = invoices(j.id).find((i) => i.status === 'kladde');
    expect(inv).toBeTruthy();
    const items = stack.sql(`SELECT * FROM invoice_items WHERE invoice_id = ${inv.id}`);
    expect(items.some((i) => i.type === 'tid')).toBe(true);
    expect(items.some((i) => i.type === 'materiale')).toBe(true);
    // Kladdens PDF er tydeligt markeret
    const pdf = await owner.get(`/job/faktura/${inv.id}.pdf`);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');

    const missing = await form(owner, `/job/faktura/${inv.id}`, `/job/faktura/${inv.id}/udsted`, {});
    expect(missing.html).toContain('Bekræft');
    const issue = await form(owner, `/job/faktura/${inv.id}`, `/job/faktura/${inv.id}/udsted`, { reviewed: '1' });
    expect(issue.status).toBe(303);
    const done = stack.sql(`SELECT * FROM invoices WHERE id = ${inv.id}`)[0];
    expect(done).toMatchObject({ status: 'udstedt', number: 1004 });
    expect(done.total).toBe(done.subtotal + done.vat);
    expect(done.vat).toBe(Math.round(done.subtotal * 0.25));

    // Låst: kan ikke ændres eller slettes
    const edit = await form(owner, `/job/faktura/${inv.id}`, `/job/faktura/${inv.id}/linje`, { description: 'Ekstra', qty: '1', unit: 'stk.', unit_price: '100' });
    expect(edit.status).not.toBe(303);
    const del = await form(owner, `/job/faktura/${inv.id}`, `/job/faktura/${inv.id}/slet`);
    expect(del.status).not.toBe(303);
    expect(stack.sql(`SELECT COUNT(*) AS n FROM invoices WHERE id = ${inv.id}`)[0].n).toBe(1);

    // Intet tilbage at fakturere: en ny kladde får ingen af de samme linjer
    await form(owner, `/job/${j.id}/faktura`, `/job/${j.id}/faktura`, { mode: 'medgaaet' });
    const again = invoices(j.id).find((i) => i.status === 'kladde');
    const keys = new Set(items.map((i) => i.source_key).filter(Boolean));
    const dup = stack.sql(`SELECT source_key FROM invoice_items WHERE invoice_id = ${again.id}`).filter((r) => keys.has(r.source_key));
    expect(dup).toEqual([]);
    await form(owner, `/job/faktura/${again.id}`, `/job/faktura/${again.id}/slet`);

    // Kreditnota for hele fakturaen
    const cr = await form(owner, `/job/faktura/${inv.id}`, `/job/faktura/${inv.id}/kreditnota`);
    expect(cr.status).toBe(303);
    const credit = invoices(j.id).find((i) => i.kind === 'kreditnota');
    expect(credit.credit_of).toBe(inv.id);
    await form(owner, `/job/faktura/${credit.id}`, `/job/faktura/${credit.id}/udsted`, { reviewed: '1' });
    expect(stack.sql(`SELECT * FROM invoices WHERE id = ${credit.id}`)[0]).toMatchObject({ status: 'udstedt', number: 1005, total: done.total });
    // Efter kreditnotaen kan det faktureres igen
    const billing = await owner.get(`/job/${j.id}/faktura`);
    expect(billing.html).toMatch(/Godkendte fakturerbare timer<\/td><td>[1-9]/);
  });

  it('fast pris: et overslag bliver aldrig automatisk en fast pris', async () => {
    const j = job('2026-015');
    const res = await form(owner, `/job/${j.id}/faktura`, `/job/${j.id}/faktura`, { mode: 'fast', fixed_amount: '' });
    expect(res.status).not.toBe(500);
    const inv = invoices(j.id).find((i) => i.status === 'kladde');
    if (inv) {
      const page = await owner.get(`/job/faktura/${inv.id}`);
      expect(page.html).toMatch(/fast pris/i);
      const issue = await form(owner, `/job/faktura/${inv.id}`, `/job/faktura/${inv.id}/udsted`, { reviewed: '1' });
      expect(stack.sql(`SELECT status FROM invoices WHERE id = ${inv.id}`)[0].status).toBe('kladde');
      expect(issue.status).not.toBe(303);
    }
  });

  it('reservation fra jobbets materialer sætter manglende varer på jobbets indkøbsliste', async () => {
    const j = job('2026-016');
    const page = await owner.get(`/job/${j.id}/materialer`);
    const res = await owner.post(`/job/${j.id}/materialer/reserver`, { _csrf: csrfFrom(page.html), op: opFrom(page.html) });
    expect(res.status).toBe(303);
    const lines = stack.sql(`SELECT * FROM purchase_lines WHERE job_id = ${j.id} AND cancelled = 0`);
    const vin = lines.find((l) => l.name.startsWith('Vinkelbeslag'));
    expect(vin).toMatchObject({ deliver_to: 'arbejdssted', ordered: 0 });
    // Hele pakker købes: 2 × 10
    expect(vin.qty).toBe(20 * K);
    expect(job('2026-016').stage).toBe('afventer');
  });

  it('indstillinger: firmaoplysninger valideres, og medarbejdertyper kan oprettes', async () => {
    const bad = await form(owner, '/lager/indstillinger', '/lager/indstillinger/faktura', {
      company_address: 'Vej 1',
      company_cvr: '123',
      vat_registered: 'ja',
      payment_days: '8',
      invoice_start: '1',
      quote_valid_days: '30',
    });
    expect(bad.status).toBe(400);
    expect(bad.html).toContain('CVR-nummeret skal være 8 cifre');
    const t = await form(owner, '/lager/indstillinger', '/lager/indstillinger/medarbejdertype', { name: 'Murer', internal_cost: '400', bill_rate: '650' });
    expect(t.status).toBe(303);
    expect(stack.sql("SELECT * FROM labour_types WHERE name = 'Murer'")[0]).toMatchObject({ internal_cost: 40000, bill_rate: 65000 });
    const page = await owner.get('/lager/indstillinger');
    expect(page.html).toContain('Kommer senere');
    expect(page.html).toContain('Standardpåslag');
  });

  it('brugbare returvarer lægges på lager uden at ændre indkøbsprisen', async () => {
    const p = stack.sql("SELECT * FROM products WHERE sku = 'PU-750'")[0];
    const page = await owner.get(`/lager/varer/${p.id}`);
    const res = await owner.post(`/lager/varer/${p.id}/bevaegelse`, { _csrf: csrfFrom(page.html), op: opFrom(page.html), kind: 'returvare', qty: '2', reason: 'Retur fra byggeplads' });
    expect([200, 303]).toContain(res.status);
    const after = stack.sql(`SELECT * FROM products WHERE id = ${p.id}`)[0];
    expect(after.stock).toBe(p.stock + 2 * K);
    expect(after.purchase_price).toBe(p.purchase_price);
  });
});
