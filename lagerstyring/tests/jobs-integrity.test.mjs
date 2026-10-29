// Explicit TEST fixtures exercise corrections through real HTTP routes and local D1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { csrfFrom, demoLogin, opFrom, startStack } from './harness.mjs';

const K = 1000;
let stack, owner, staff, sequence = 0;
const row = (table, id) => stack.sql(`SELECT * FROM ${table} WHERE id = ${Number(id)}`)[0];
const rows = sql => stack.sql(sql);
const selectForm = (html, action, match = () => true) => {
  const forms = [...html.matchAll(/<form\b[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)];
  const form = forms.find(m => m[1] === action && match(m[2]));
  if (!form) throw new Error(`Missing form ${action}`);
  return form[2];
};
async function payload(client, page, action, fields = {}, match) {
  const p = await client.get(page);
  expect(p.status).toBe(200);
  const form = selectForm(p.html, action, match);
  return { _csrf: csrfFrom(p.html), op: opFrom(form), ...fields };
}
async function post(client, page, action, fields = {}, match) {
  return client.post(action, await payload(client, page, action, fields, match));
}
function fixture({ stock = null, qty = 5, pack = 1 } = {}) {
  const n = ++sequence;
  const now = Math.floor(Date.now() / 1000);
  rows(`INSERT INTO jobs(number,name,customer_name,customer_address,description,status,stage,hour_rate,created_at,updated_at)
    VALUES('TEST-INTEGRITY-${n}','TEST – job integrity ${n}','TEST Customer','TEST Address','Synthetic test job','aktiv','planlagt',65000,${now},${now})`);
  const job = rows(`SELECT * FROM jobs WHERE number='TEST-INTEGRITY-${n}'`)[0];
  let product = null;
  if (stock !== null) {
    rows(`INSERT INTO products(sku,name,unit,whole_units,stock,purchase_price,sale_price,created_at,updated_at)
      VALUES('TEST-INTEGRITY-${n}','TEST material ${n}','stk.',1,${stock * K},1000,1500,${now},${now})`);
    product = rows(`SELECT * FROM products WHERE sku='TEST-INTEGRITY-${n}'`)[0];
  }
  rows(`INSERT INTO job_items(job_id,product_id,cost_basis,name,unit,qty,pack_qty,min_qty,sales_unit,price,vat,price_source,match,approved_at,checked_at,sale_mode,created_by,created_at,updated_at)
    VALUES(${job.id},${product?.id ?? 'NULL'},'${product ? 'lager' : 'byggemarked'}','TEST material ${n}','stk.',${qty * K},${pack * K},1000,'${pack === 1 ? 'stk.' : 'pk.'}',12500,'inkl','manuel','praecis',${now},${now},'paaslag','test@fixture.example',${now},${now})`);
  const item = rows(`SELECT * FROM job_items WHERE job_id=${job.id}`)[0];
  return { job, product, item, page: `/job/${job.id}/materialer`, edit: `/job/${job.id}/materialer/${item.id}` };
}
async function edit(f, qty, extra = {}) {
  return post(owner, f.page, f.edit, { qty: String(qty), pack_qty: String(row('job_items', f.item.id).pack_qty / K), sale_mode: 'paaslag', cost_basis: f.product ? 'lager' : 'byggemarked', ...extra });
}
const livePurchases = job => rows(`SELECT * FROM purchase_lines WHERE job_id=${job.id} AND cancelled=0`);

beforeAll(async () => {
  stack = await startStack({ demo: true, email: false });
  owner = await demoLogin(stack, 'ejer');
  staff = await demoLogin(stack, 'medarbejder');
}, 180_000);
afterAll(async () => { await stack?.stop(); });

describe('Job corrections and exactly-once registrations', () => {
  it('releases a reduced stock reservation and recalculates the draft shortage atomically', async () => {
    const f = fixture({ stock: 10, qty: 15 });
    expect((await post(owner, f.page, `/job/${f.job.id}/materialer/reserver`)).status).toBe(303);
    expect(row('products', f.product.id)).toMatchObject({ stock: 10*K, reserved: 10*K });
    expect(livePurchases(f.job)).toHaveLength(1);
    expect(livePurchases(f.job)[0].qty).toBe(5*K);
    const fields = await payload(owner, f.page, f.edit, { qty:'4', pack_qty:'1', sale_mode:'paaslag', cost_basis:'lager' });
    const response = await owner.post(f.edit, fields);
    expect(response.status).toBe(303);
    expect(row('products', f.product.id)).toMatchObject({ stock:10*K, reserved:4*K });
    expect(rows(`SELECT * FROM job_materials WHERE job_id=${f.job.id} AND product_id=${f.product.id}`)[0]).toMatchObject({ planned:4*K, reserved:4*K });
    expect(livePurchases(f.job)).toHaveLength(0);
    await owner.post(f.edit, fields); // Replay must not release another six units.
    expect(row('products', f.product.id).reserved).toBe(4*K);
    expect((await edit(f, 8)).status).toBe(303);
    expect(row('products', f.product.id)).toMatchObject({ stock:10*K, reserved:8*K });
    expect((await edit(f, '0,5')).status).toBe(409);
    expect(row('products', f.product.id).reserved).toBe(8*K);
  });

  it('updates the same non-stock purchase draft in whole packs and protects committed quantities', async () => {
    const f = fixture({ qty:12, pack:10 });
    expect((await post(owner, f.page, `/job/${f.job.id}/materialer/reserver`)).status).toBe(303);
    const first = livePurchases(f.job)[0];
    expect(first).toMatchObject({ qty:20*K, ordered:0, received:0 });
    expect((await edit(f, 25)).status).toBe(303);
    const changed = livePurchases(f.job);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ id:first.id, qty:30*K, ordered:0, received:0 });
    rows(`UPDATE purchase_lines SET ordered=30000, received=10000, ready=1 WHERE id=${first.id}`);
    const invalid = await edit(f, 12);
    expect(invalid.status).toBe(409);
    expect(invalid.html).toContain('allerede bestilt eller modtaget');
    expect(row('job_items',f.item.id).qty).toBe(25*K);
    expect(row('purchase_lines',first.id)).toMatchObject({ qty:30*K, ordered:30*K, received:10*K });
    expect((await edit(f, 25, { unit:'m' })).status).toBe(409);
    expect(row('purchase_lines',first.id).unit).toBe('stk.');
    rows(`UPDATE purchase_lines SET cancelled=1 WHERE id=${first.id}`);
    expect((await post(owner,f.page,`/job/${f.job.id}/materialer/reserver`)).status).toBe(409);
    expect(row('job_items',f.item.id).purchase_line_id).toBe(first.id);
    expect(rows(`SELECT * FROM purchase_lines WHERE job_id=${f.job.id}`)).toHaveLength(1);
  });

  it('rounds packs even without a price, while keeping the missing price null', async () => {
    const f = fixture({ qty:12, pack:10 });
    rows(`UPDATE job_items SET price=NULL, vat=NULL, approved_at=NULL, price_source='', match=NULL WHERE id=${f.item.id}`);
    expect((await post(owner,f.page,`/job/${f.job.id}/materialer/reserver`)).status).toBe(303);
    expect(livePurchases(f.job)[0]).toMatchObject({ qty:20*K, unit_price:null });
    const page=await owner.get(f.page);
    expect(page.html).toContain('Pris mangler');
  });

  it('consumes and reverses a non-stock material once, then exports only net actual consumption', async () => {
    const f = fixture();
    const action = `${f.edit}/forbrug`;
    const fields = await payload(staff,f.page,action,{qty:'3',retning:'brugt'});
    const responses = await Promise.all([staff.post(action,fields),staff.post(action,fields)]);
    expect(responses.map(r=>r.status)).toEqual([303,303]);
    expect(row('job_items',f.item.id).used_qty).toBe(3*K);
    expect(rows(`SELECT * FROM job_log WHERE job_id=${f.job.id} AND kind='forbrug'`)).toHaveLength(1);
    const reverse = await payload(staff,f.page,action,{qty:'2',retning:'retur'});
    await staff.post(action,reverse); await staff.post(action,reverse);
    expect(row('job_items',f.item.id).used_qty).toBe(K);
    expect((await post(staff,f.page,action,{qty:'2',retning:'retur'})).status).toBe(409);
    expect(row('job_items',f.item.id).used_qty).toBe(K);
    const billingPage = await owner.get(`/job/${f.job.id}/faktura`);
    expect((await owner.post(`/job/${f.job.id}/faktura`,{_csrf:csrfFrom(billingPage.html),mode:'medgaaet'})).status).toBe(303);
    const invoice = rows(`SELECT * FROM invoices WHERE job_id=${f.job.id} AND status='kladde'`)[0];
    const line = rows(`SELECT * FROM invoice_items WHERE invoice_id=${invoice.id} AND source_key='item:${f.item.id}'`)[0];
    expect(line).toMatchObject({ qty:K, type:'materiale' });
    const pdf = await owner.get(`/job/faktura/${invoice.id}.pdf`);
    expect(pdf.status).toBe(200); expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect(pdf.html.startsWith('%PDF')).toBe(true);
  });

  it('serializes simultaneous non-stock returns with different keys without negative quantities or false history', async () => {
    const f=fixture(); const action=`${f.edit}/forbrug`;
    await post(staff,f.page,action,{qty:'1',retning:'brugt'});
    const a=await payload(staff,f.page,action,{qty:'1',retning:'retur'}),b=await payload(owner,f.page,action,{qty:'1',retning:'retur'});
    const responses=await Promise.all([staff.post(action,a),owner.post(action,b)]);
    expect(responses.map(r=>r.status).sort()).toEqual([303,409]);
    expect(row('job_items',f.item.id).used_qty).toBe(0);
    expect(rows(`SELECT * FROM job_log WHERE job_id=${f.job.id} AND kind='forbrug'`)).toHaveLength(2);
  });

  it('registers labor exactly once and ignores staff attempts to alter billing or internal rates', async () => {
    const f=fixture(); const page=`/job/${f.job.id}/timer`,action=page;
    const fields=await payload(staff,page,action,{phase:'faktisk',type:'tid',qty:'2',description:'TEST staff hours',unit_price:'1',internal_cost:'1',approve:'1',billable:'0',worker:'ejer@nordlysbyg.example'},form=>form.includes('value="faktisk"'));
    const results=await Promise.all([staff.post(action,fields),staff.post(action,fields)]);
    expect(results.map(r=>r.status)).toEqual([303,303]);
    const entries=rows(`SELECT * FROM job_entries WHERE job_id=${f.job.id}`);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({qty:2*K,unit_price:65000,internal_cost:38500,approved_at:null,billable:1,worker_email:'jonas@nordlysbyg.example'});
    expect(rows(`SELECT * FROM job_log WHERE job_id=${f.job.id} AND kind='timer'`)).toHaveLength(1);
    const noKey = await staff.post(action,{...fields,op:''});
    expect(noKey.status).toBe(400);
    expect(rows(`SELECT * FROM job_entries WHERE job_id=${f.job.id}`)).toHaveLength(1);
  });

  it('preserves a real zero historical cost and keeps mixed unknown historical costs unknown', async () => {
    for (const zero of [true,false]) {
      const f=fixture({stock:5,qty:2});
      rows(`UPDATE products SET purchase_price=${zero ? '0' : 'NULL'}, sale_price=NULL WHERE id=${f.product.id}`);
      rows(`UPDATE job_items SET markup_pct=0, sale_mode='paaslag' WHERE id=${f.item.id}`);
      const action=`/job/${f.job.id}/registrer`,page=`${action}?type=forbrug`;
      const first=await owner.get(page);
      expect((await owner.post(action,{_csrf:csrfFrom(first.html),op:opFrom(first.html),type:'forbrug',[`q_${f.product.id}`]:'1',note:'TEST historical cost'})).status).toBe(303);
      if(!zero) rows(`UPDATE products SET purchase_price=1000 WHERE id=${f.product.id}`);
      const second=await owner.get(page);
      expect((await owner.post(action,{_csrf:csrfFrom(second.html),op:opFrom(second.html),type:'forbrug',[`q_${f.product.id}`]:'1',note:'TEST second cost'})).status).toBe(303);
      const billing=await owner.get(`/job/${f.job.id}/faktura`);
      expect((await owner.post(`/job/${f.job.id}/faktura`,{_csrf:csrfFrom(billing.html),mode:'medgaaet'})).status).toBe(303);
      const invoice=rows(`SELECT * FROM invoices WHERE job_id=${f.job.id} AND status='kladde'`)[0];
      const line=rows(`SELECT * FROM invoice_items WHERE invoice_id=${invoice.id} AND source_key='lager:${f.product.id}'`)[0];
      expect(line.qty).toBe(2*K);
      expect(line.unit_cost).toBe(zero ? 0 : null);
      if(zero) expect(line.unit_price).toBe(0);
      if(!zero) rows(`INSERT INTO job_entries(job_id,type,phase,description,qty,unit,unit_price,internal_cost,created_by,created_at,updated_at)
        VALUES(${f.job.id},'omkostning','faktisk','TEST unknown extra cost',1000,'stk.',12300,NULL,'test@fixture.example',1,1)`);
      const overview=await owner.get(`/job/${f.job.id}`);
      if(!zero) expect(overview.html).toContain('2 registreringer mangler kostpris eller intern sats');
    }
  });

  it('never reuses a cached page price after page access is removed, while file prices still work', async () => {
    const f=fixture(); const now=Math.floor(Date.now()/1000);
    rows(`INSERT INTO retailers(key,name,website,access,active,created_at) VALUES('test-file-only','TEST file supplier','https://example.invalid','prisfil',1,${now})`);
    const retailer=rows("SELECT * FROM retailers WHERE key='test-file-only'")[0];
    rows(`UPDATE job_items SET retailer_id=${retailer.id},price=NULL,vat=NULL,price_source='',approved_at=NULL,ean='05700000000011' WHERE id=${f.item.id}`);
    rows(`INSERT INTO retailer_products(retailer_id,retailer_sku,ean,name,url,sales_unit,pack_qty,content_unit,min_qty,divisible,price,vat,source,checked_at)
      VALUES(${retailer.id},'TEST-PAGE','05700000000011','TEST page material','https://example.invalid/test','stk.',1000,'stk.',1000,0,9900,'ekskl','side',${now})`);
    let page=await owner.get(f.page);
    expect((await owner.post(`/job/${f.job.id}/materialer/priser`,{_csrf:csrfFrom(page.html)})).status).toBe(200);
    expect(row('job_items',f.item.id).price).toBeNull();
    rows(`UPDATE job_items SET price=9900,vat='ekskl',price_source='side',match='praecis',price_retailer_id=${retailer.id},checked_at=${now},approved_at=${now} WHERE id=${f.item.id}`);
    page=await owner.get(f.page);
    expect(page.html).toContain('Kilden er ikke bekræftet');
    expect(page.html).toContain('99 kr.');
    const quotes=await owner.get(`/job/${f.job.id}/overslag`);
    expect((await owner.post(`/job/${f.job.id}/overslag`,{_csrf:csrfFrom(quotes.html)})).status).toBe(303);
    const q=rows(`SELECT * FROM job_quotes WHERE job_id=${f.job.id} ORDER BY version DESC`)[0];
    expect(q).toMatchObject({incomplete:1,materials:0});
    expect(row('job_items',f.item.id)).toMatchObject({price:9900,price_source:'side',checked_at:now});
    rows(`INSERT INTO retailer_products(retailer_id,retailer_sku,ean,name,url,sales_unit,pack_qty,content_unit,min_qty,divisible,price,vat,source,checked_at)
      VALUES(${retailer.id},'TEST-FILE','05700000000011','TEST file material','https://example.invalid/test-file','stk.',1000,'stk.',1000,0,7700,'ekskl','prisfil',${now})`);
    page=await owner.get(f.page);
    expect((await owner.post(`/job/${f.job.id}/materialer/priser`,{_csrf:csrfFrom(page.html)})).status).toBe(200);
    expect(row('job_items',f.item.id)).toMatchObject({price:7700,price_source:'prisfil'});
  });

});
