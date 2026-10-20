// Returer: fra job tilbage til eget lager, og til leverandør. Den fysiske retur registreres her;
// den økonomiske kreditering (leverandørens kreditnota eller en kreditnota til slutkunden) er en
// selvstændig hændelse, som kun knyttes til returen.

import { Hono, type Context } from 'hono';
import { html } from 'hono/html';
import type { AppEnv } from '../env';
import { bilagNo } from '../lib/bilag';
import { formatDateTime, formatKr, formatQty, parseKr, parseQty, str } from '../lib/format';
import { adjustStock } from '../lib/inventory';
import { settled } from '../lib/invoicing';
import { getJob, getProduct, returnToStock } from '../lib/materials';
import { requireManager } from '../lib/session';
import { actorOf, idParam, newOp, render, runTx } from '../render';
import { errors, pageHead } from '../views/common';
import { alert, csrfField, opField } from '../views/layout';

const retur = new Hono<AppEnv>();
retur.use('*', requireManager);
const NAV = { portal: 'lager', tab: 'modtagelse' } as const;

const CREDIT_LABEL: Record<string, string> = {
  '': '–',
  afventer: 'Afventer kreditnota',
  modtaget: 'Kreditnota modtaget',
  ikke_relevant: 'Ingen kreditering',
  vurder: 'Vurdér kreditnota til kunden',
};

interface ReturnView {
  id: number;
  kind: 'job_lager' | 'leverandor';
  job_number: string | null;
  name: string;
  unit: string;
  qty: number;
  condition: string;
  location: string;
  credit_state: string;
  credit_bilag_id: number | null;
  amount: number | null;
  note: string;
  created_name: string;
  created_at: number;
}

async function show(c: Context<AppEnv>, errs: string[] = [], ok?: string) {
  const db = c.env.DB;
  const [{ results: rows }, { results: jobs }, { results: products }, { results: credits }] = await Promise.all([
    db.prepare('SELECT r.*, j.number AS job_number FROM returns r LEFT JOIN jobs j ON j.id = r.job_id ORDER BY r.id DESC LIMIT 200').all<ReturnView>(),
    db.prepare("SELECT id, number, name FROM jobs WHERE status <> 'annulleret' ORDER BY number DESC LIMIT 300").all<{ id: number; number: string; name: string }>(),
    db.prepare('SELECT id, sku, name, unit FROM products WHERE active = 1 ORDER BY name COLLATE NOCASE').all<{ id: number; sku: string; name: string; unit: string }>(),
    db.prepare("SELECT id, supplier_name, doc_number, total FROM bilag WHERE doc_type = 'kreditnota' AND status <> 'arkiveret' ORDER BY id DESC LIMIT 100").all<{ id: number; supplier_name: string; doc_number: string; total: number | null }>(),
  ]);
  const csrf = c.get('csrf');
  const op = newOp();
  const opt = (list: { id: number; label: string }[], empty: string) => html`<option value="">${empty}</option>${list.map((x) => html`<option value="${x.id}">${x.label}</option>`)}`;
  const prodOpts = opt(products.map((p) => ({ id: p.id, label: `${p.sku} ${p.name} (${p.unit})` })), 'Vælg vare');
  return render(
    c,
    'Returer',
    html`<div class="stack-lg">
  ${pageHead(html`<a href="/lager/modtagelse">Varemodtagelse</a>`, 'Returer', '', 'Kun brugbare varer kommer tilbage på lageret. Beskadigede varer bliver ikke salgbare igen. Krediteringen registreres for sig, når kreditnotaen kommer.')}
  ${ok ? alert('ok', ok) : ''}${errors(errs)}
  <div class="grid grid-2">
    <form class="card stack" method="post" action="/lager/retur/job">
      ${csrfField(csrf)}${opField(op)}
      <h2>Fra job til eget lager</h2>
      <div class="field"><label for="rj-j">Job</label><select id="rj-j" name="job_id" required>${opt(jobs.map((j) => ({ id: j.id, label: `${j.number} ${j.name}` })), 'Vælg job')}</select></div>
      <div class="field"><label for="rj-p">Vare</label><select id="rj-p" name="product_id" required>${prodOpts}</select></div>
      <div class="fields fields-2">
        <div class="field"><label for="rj-q">Mængde</label><input id="rj-q" name="qty" class="in-num" inputmode="decimal" required></div>
        <div class="field"><label for="rj-c">Stand</label><select id="rj-c" name="condition"><option value="brugbar">Brugbar (tilbage på lager)</option><option value="beskadiget">Beskadiget (ikke på lager)</option></select></div>
      </div>
      <div class="field"><label for="rj-n">Bemærkning</label><input id="rj-n" name="note" maxlength="200"></div>
      <button class="btn btn-primary" type="submit">Registrér retur</button>
      <p class="hint">Brugbare varer trækkes fra jobbets forbrug og lægges på lageret. Beskadigede varer bliver på jobbet som omkostning. Er varen allerede faktureret til kunden, markeres returen til vurdering af en kreditnota; der laves ikke automatisk en kreditnota.</p>
    </form>
    <form class="card stack" method="post" action="/lager/retur/leverandor">
      ${csrfField(csrf)}${opField(op)}
      <h2>Til leverandør</h2>
      <div class="field"><label for="rl-p">Vare fra lageret</label><select id="rl-p" name="product_id" required>${prodOpts}</select></div>
      <div class="fields fields-2">
        <div class="field"><label for="rl-q">Mængde</label><input id="rl-q" name="qty" class="in-num" inputmode="decimal" required></div>
        <div class="field"><label for="rl-a">Forventet kredit ekskl. moms (valgfri)</label><input id="rl-a" name="amount" class="in-num" inputmode="decimal"></div>
      </div>
      <div class="field"><label for="rl-n">Bemærkning</label><input id="rl-n" name="note" maxlength="200"></div>
      <button class="btn btn-primary" type="submit">Registrér retur til leverandør</button>
      <p class="hint">Varen trækkes fra lageret nu. Returen står som "afventer kreditnota", til leverandørens kreditnota er uploadet som bilag, knyttet og godkendt.</p>
    </form>
  </div>
  <section class="stack"><h2>Registrerede returer</h2>
  <div class="card card-flush"><div class="table-wrap"><table class="list stackable">
    <thead><tr><th>Retur</th><th>Vare</th><th class="num">Mængde</th><th>Stand</th><th>Kreditering</th><th></th></tr></thead>
    <tbody>${rows.length
      ? rows.map(
          (r) => html`<tr>
        <td class="cell-main">${r.kind === 'leverandor' ? 'Til leverandør' : `Fra job ${r.job_number ?? ''}`}<div class="muted">${formatDateTime(r.created_at)} · ${r.created_name}</div></td>
        <td data-label="Vare">${r.name}${r.note ? html`<div class="muted">${r.note}</div>` : ''}</td>
        <td class="num" data-label="Mængde">${formatQty(r.qty)} ${r.unit}</td>
        <td data-label="Stand">${r.condition === 'beskadiget' ? 'Beskadiget' : 'Brugbar'} · ${r.location}</td>
        <td data-label="Kreditering">${CREDIT_LABEL[r.credit_state] ?? r.credit_state}${r.amount ? ` (${formatKr(r.amount, { decimals: true })})` : ''}${r.credit_bilag_id ? html` · <a href="/lager/bilag/${r.credit_bilag_id}">${bilagNo(r.credit_bilag_id)}</a>` : ''}</td>
        <td>${r.kind === 'leverandor' && r.credit_state === 'afventer'
          ? html`<form method="post" action="/lager/retur/${r.id}/kreditnota" class="row">${csrfField(csrf)}<select name="bilag_id" aria-label="Kreditnota" required>${opt(credits.map((b) => ({ id: b.id, label: `${bilagNo(b.id)} ${b.supplier_name} ${b.doc_number}` })), 'Vælg kreditnota')}</select><button class="btn btn-secondary btn-small" type="submit">Knyt</button></form>`
          : r.credit_state === 'vurder'
            ? html`<form method="post" action="/lager/retur/${r.id}/vurderet" class="row">${csrfField(csrf)}<select name="state" aria-label="Afgørelse"><option value="ikke_relevant">Ingen kreditnota</option><option value="modtaget">Kreditnota lavet</option></select><button class="btn btn-ghost btn-small" type="submit">Gem</button></form>`
            : ''}</td>
      </tr>`,
        )
      : html`<tr><td colspan="6" class="empty">Ingen returer endnu.</td></tr>`}</tbody>
  </table></div></div></section>
</div>`,
    NAV,
    errs.length ? 400 : 200,
  );
}

retur.get('/', (c) => show(c));

retur.post('/job', async (c) => {
  const db = c.env.DB;
  const body = await c.req.parseBody();
  const job = await getJob(db, idParam(String(body['job_id'] ?? '')) ?? 0);
  const p = await getProduct(db, idParam(String(body['product_id'] ?? '')) ?? 0);
  const q = parseQty(body['qty']);
  const damaged = body['condition'] === 'beskadiget';
  if (!job || !p || !q || q <= 0) return show(c, ['Vælg job, vare og en mængde over 0.']);
  const issued = await db.prepare('SELECT issued - returned AS n FROM job_materials WHERE job_id = ? AND product_id = ?').bind(job.id, p.id).first<{ n: number }>();
  if (!issued || issued.n < q) return show(c, [`Jobbet har kun fået ${formatQty(issued?.n ?? 0)} ${p.unit} ${p.name} fra lageret.`]);
  const invoiced = ((await settled(db, job.id)).get(`lager:${p.id}`) ?? 0) > 0;
  const a = actorOf(c);
  const note = str(body['note'], 200);
  const res = await runTx(c, 'retur', body['op'], async (tx) => {
    if (!damaged) await returnToStock(tx, job, p, q, note || 'Retur fra job');
    tx.add(
      tx.db
        .prepare(
          `INSERT INTO returns (kind, job_id, product_id, name, unit, qty, condition, location, credit_state, note, created_by, created_name, created_at, updated_at)
           VALUES ('job_lager', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(job.id, p.id, p.name, p.unit, q, damaged ? 'beskadiget' : 'brugbar', damaged ? 'Kasseret, ikke på lager' : 'Hovedlager', invoiced ? 'vurder' : '', note, a.email, a.name, tx.now, tx.now),
    );
  });
  if (!res.ok) return show(c, [res.error]);
  return show(c, [], damaged ? 'Returen er registreret. Varen er beskadiget og er ikke lagt på lager; den bliver på jobbet som omkostning.' : `Returen er registreret, og ${formatQty(q)} ${p.unit} er lagt på lageret.${invoiced ? ' Varen er allerede faktureret: vurdér om kunden skal have en kreditnota.' : ''}`);
});

retur.post('/leverandor', async (c) => {
  const db = c.env.DB;
  const body = await c.req.parseBody();
  const p = await getProduct(db, idParam(String(body['product_id'] ?? '')) ?? 0);
  const q = parseQty(body['qty']);
  if (!p || !q || q <= 0) return show(c, ['Vælg vare og en mængde over 0.']);
  const amount = String(body['amount'] ?? '').trim() ? parseKr(body['amount']) : null;
  const a = actorOf(c);
  const note = str(body['note'], 200);
  const res = await runTx(c, 'retur', body['op'], (tx) => {
    adjustStock(tx, p, 'leverandorretur', q, note || 'Retur til leverandør');
    tx.add(
      tx.db
        .prepare(
          `INSERT INTO returns (kind, product_id, name, unit, qty, condition, location, credit_state, amount, note, created_by, created_name, created_at, updated_at)
           VALUES ('leverandor', ?, ?, ?, ?, '', 'Sendt til leverandør', 'afventer', ?, ?, ?, ?, ?, ?)`,
        )
        .bind(p.id, p.name, p.unit, q, amount, note, a.email, a.name, tx.now, tx.now),
    );
  });
  if (!res.ok) return show(c, [res.error]);
  return show(c, [], `Returen er registreret, og ${formatQty(q)} ${p.unit} er trukket fra lageret. Den afventer leverandørens kreditnota.`);
});

retur.post('/:id{[0-9]+}/kreditnota', async (c) => {
  const db = c.env.DB;
  const body = await c.req.parseBody();
  const b = await db.prepare("SELECT id, status, approved_version, version FROM bilag WHERE id = ? AND doc_type = 'kreditnota'").bind(idParam(String(body['bilag_id'] ?? '')) ?? 0).first<{ id: number; status: string; approved_version: number | null; version: number }>();
  if (!b) return show(c, ['Vælg en kreditnota, der er uploadet som bilag.']);
  const approved = b.status === 'godkendt' && b.approved_version === b.version;
  await db.prepare("UPDATE returns SET credit_bilag_id = ?, credit_state = CASE WHEN ? THEN 'modtaget' ELSE credit_state END, updated_at = ? WHERE id = ? AND kind = 'leverandor'").bind(b.id, approved ? 1 : 0, Math.floor(Date.now() / 1000), Number(c.req.param('id'))).run();
  return show(c, [], approved ? 'Kreditnotaen er knyttet, og returen er krediteret.' : 'Kreditnotaen er knyttet. Returen står som krediteret, når bilaget er godkendt.');
});

retur.post('/:id{[0-9]+}/vurderet', async (c) => {
  const body = await c.req.parseBody();
  const state = body['state'] === 'modtaget' ? 'modtaget' : 'ikke_relevant';
  await c.env.DB.prepare("UPDATE returns SET credit_state = ?, updated_at = ? WHERE id = ? AND credit_state = 'vurder'").bind(state, Math.floor(Date.now() / 1000), Number(c.req.param('id'))).run();
  return show(c, [], 'Gemt.');
});

export default retur;
