// Demodata og et 14-trins forløb for bilag, betalinger, returer og eksport. Alle leverandører,
// bilag og beløb er fiktive. Forløbet bruger de samme funktioner som brugerfladen.

import type { Env, JobRow, ProductRow } from '../env';
import { execTx } from '../render';
import {
  addAllocation,
  allocations,
  approveBilag,
  bilagLines,
  checkBilag,
  createBilag,
  eventStmt,
  exportState,
  getBilag,
  jobBilagCost,
  performAllocation,
  readBilag,
  saveBilag,
  setStatus,
  type BilagRow,
} from './bilag';
import { buildExport } from './bilagexport';
import { randomToken } from './crypto';
import { storeFile } from './files';
import { formatKr, formatQty, todayDk } from './format';
import { adjustStock } from './inventory';
import type { Actor } from './ledger';
import { creditedTotal, invoicePayments, payStatus, PAY_STATE_LABEL } from './payments';
import { samplePdf, sampleTotals, type SampleDoc } from './samplepdf';
import type { Settings } from './settings';
import type { DemoCheck, DemoStep } from './demo';

const K = 1000;
const kr = (o: number | null) => (o === null ? '–' : formatKr(o, { decimals: true }));
const chk = (label: string, expected: string | number, actual: string | number | null): DemoCheck => {
  const e = String(expected);
  const a = actual === null ? '–' : String(actual);
  return { label, expected: e, actual: a, ok: e === a };
};

export const DEMO_SUPPLIER = { name: 'Fiktiv Grossist A/S', address: 'Demovej 1, 8000 Aarhus C', cvr: '29990001' };

async function uploadPdf(env: Env, s: Settings, doc: SampleDoc, actor: Actor, opts: { payment?: BilagRow['payment']; paid_by?: string; job?: number | null; name: string }, now: number): Promise<number> {
  const bytes = await samplePdf(doc);
  const st = await storeFile(env.DB, bytes, actor.email, now);
  if (!st.ok) throw new Error(st.error);
  const id = await createBilag(
    env.DB,
    st.file,
    opts.name,
    { doc_type: doc.kind, payment: opts.payment ?? 'ikke_betalt', paid_by: opts.paid_by ?? '', job_hint: opts.job ?? null, origin: 'demo', note: '', preview_file_id: null },
    actor,
    now,
  );
  await readBilag(env, s, id, actor, now);
  return id;
}

/** Brugeren bekræfter de foreslåede varematch på linjerne (som når formularen gemmes). */
async function acceptMatches(db: D1Database, id: number, actor: Actor, now: number): Promise<void> {
  const b = (await getBilag(db, id))!;
  await db.batch([
    db.prepare("UPDATE bilag_lines SET product_state = 'godkendt' WHERE bilag_id = ? AND product_state = 'forslag'").bind(id),
    eventStmt(db, id, b.version, 'rettelse', 'Foreslåede varematch er kontrolleret og godkendt.', actor, now),
  ]);
}

const stockOf = async (db: D1Database, pid: number) => (await db.prepare('SELECT stock FROM products WHERE id = ?').bind(pid).first<{ stock: number }>())?.stock ?? 0;

/** Lidt fiktive bilag og en betaling i demodata (kaldes når demoen oprettes eller nulstilles). */
export async function seedBilag(env: Env, s: Settings, owner: Actor, staff: Actor, now: number): Promise<void> {
  const db = env.DB;
  const job = await db.prepare("SELECT id FROM jobs WHERE status = 'aktiv' ORDER BY id LIMIT 1").first<{ id: number }>();
  const today = todayDk(now * 1000);
  const a = await uploadPdf(
    env,
    s,
    { kind: 'faktura', supplier: DEMO_SUPPLIER.name, address: DEMO_SUPPLIER.address, cvr: DEMO_SUPPLIER.cvr, number: 'DEMO-5001', date: today, due: today, buyer: s.company_name, lines: [{ sku: 'D-100', name: 'Lejeudstyr stillads (dagsleje)', qty: 2 * K, unit: 'dag', price: 45000 }], payment: 'Fiktiv betaling til demokonto' },
    owner,
    { name: 'demo-faktura-5001.pdf', job: job?.id ?? null },
    now,
  );
  if (job) {
    const b = (await getBilag(db, a))!;
    await addAllocation(db, b, { line_id: null, target: 'job', job_id: job.id, amount: b.net ?? 0, action: 'udgift', purchase_line_id: null, product_id: null, qty: null, note: 'Stilladsleje' }, owner, now);
    await approveBilag(db, s, (await getBilag(db, a))!, owner, now);
  }
  // Et udlæg fra en medarbejder, der venter på gennemgang
  await uploadPdf(
    env,
    s,
    { kind: 'kvittering', supplier: 'Fiktivt Byggemarked', address: 'Testgade 9, 8600 Silkeborg', cvr: '29990002', number: 'K-88123', date: today, buyer: s.company_name, lines: [{ name: 'Bor 6 mm (sæt)', qty: K, unit: 'stk.', price: 7960 }] },
    staff,
    { name: 'kvittering-byggemarked.pdf', payment: 'medarbejder', paid_by: staff.email, job: job?.id ?? null },
    now,
  );
  // En delvis betaling på den første udstedte faktura
  const inv = await db.prepare("SELECT id, total FROM invoices WHERE kind = 'faktura' AND status = 'udstedt' ORDER BY number LIMIT 1").first<{ id: number; total: number }>();
  if (inv && inv.total > 100) {
    await db
      .prepare("INSERT INTO invoice_payments (invoice_id, paid_on, amount, currency, method, reference, note, created_by, created_at) VALUES (?, ?, ?, 'DKK', 'bankoverforsel', 'DEMO-OVF-1', 'Demodata', ?, ?)")
      .bind(inv.id, today, Math.floor(inv.total / 2), owner.name, now)
      .run();
  }
}

/** 14-trins bilagsforløb: upload → kontrollér → fordel → godkend → eksportér, med returer og betalinger. */
export async function runBilagScenario(env: Env, s: Settings, actor: Actor, staff: Actor): Promise<DemoStep[]> {
  const db = env.DB;
  const now = Math.floor(Date.now() / 1000);
  const steps: DemoStep[] = [];
  const step = (title: string, text: string, checks: DemoCheck[], link?: { href: string; label: string }) => steps.push({ title, text, checks, link });
  const tag = String(now).slice(-6);
  const today = todayDk();
  const product = await db.prepare("SELECT * FROM products WHERE active = 1 AND whole_units = 1 AND category <> 'Demoforløb' ORDER BY id LIMIT 1").first<ProductRow>();
  const job = await db.prepare("SELECT * FROM jobs WHERE status = 'aktiv' ORDER BY id LIMIT 1").first<JobRow>();
  if (!product || !job) return [{ title: 'Forløbet kan ikke køres', text: 'Demoen mangler varer eller et aktivt job. Nulstil demodata.', checks: [chk('Data findes', 'ja', 'nej')] }];
  const run = (build: Parameters<typeof execTx>[5]) => execTx(env, s, actor, 'bilag', randomToken(18), build);
  const stockTotal = async () => (await db.prepare('SELECT SUM(stock) AS n FROM products').first<{ n: number }>())?.n ?? 0;

  // 1. Upload af leverandørfaktura (PDF)
  const fakDoc: SampleDoc = {
    kind: 'faktura',
    supplier: DEMO_SUPPLIER.name,
    address: DEMO_SUPPLIER.address,
    cvr: DEMO_SUPPLIER.cvr,
    number: `F-${tag}`,
    date: today,
    due: today,
    buyer: s.company_name,
    lines: [{ sku: product.sku, name: product.name, qty: 10 * K, unit: product.unit, price: 5000 }],
    payment: 'Fiktiv: betales til reg. 0000 konto 0000000',
  };
  const t = sampleTotals(fakDoc);
  const stock0 = await stockTotal();
  const fId = await uploadPdf(env, s, fakDoc, actor, { name: `faktura-${tag}.pdf` }, now);
  let f = (await getBilag(db, fId))!;
  step('Upload leverandørfaktura', "En PDF-faktura uploades. Den indbyggede PDF-læser aflæser felterne fra PDF'ens tekst; originalen gemmes uændret.", [
    chk('Status', 'Klar til gennemgang', f.status === 'klar' ? 'Klar til gennemgang' : f.status),
    chk('Leverandør', DEMO_SUPPLIER.name, f.supplier_name),
    chk('Nummer', fakDoc.number, f.doc_number),
    chk('Total', kr(t.total), kr(f.total)),
  ], { href: `/lager/bilag/${fId}`, label: 'Se bilaget' });

  // 2. Digital visning kontrolleres
  const lines = await bilagLines(db, fId);
  const c0 = checkBilag(f, lines, [], s);
  step('Kontrollér den digitale visning', 'Ekskl. moms + moms skal give totalen, og varelinjerne skal summe til beløbet. Systemet opfinder ingen værdier og lægger ikke selv moms på.', [
    chk('Ekskl. moms + moms = total', 'ja', f.net !== null && f.vat !== null && f.net + f.vat + f.rounding === f.total ? 'ja' : 'nej'),
    chk('Varelinjer', 1, lines.length),
    chk('Linjesum', kr(t.net), kr(c0.linesSum)),
  ]);

  // 3. Samme fil igen: dublet
  const dId = await uploadPdf(env, s, fakDoc, actor, { name: `faktura-${tag}-kopi.pdf` }, now);
  const d = (await getBilag(db, dId))!;
  step('Upload samme faktura igen', 'Dubletten markeres, men slås aldrig sammen automatisk.', [chk('Mulig dublet af', `B-${String(fId).padStart(6, '0')}`, d.dup_of ? `B-${String(d.dup_of).padStart(6, '0')}` : 'ingen')]);

  // 4. Dubletten arkiveres
  await setStatus(db, d, 'arkiveret', '', actor, now);
  step('Arkivér dubletten', 'Dubletten arkiveres og tælles ikke med.', [chk('Status', 'arkiveret', (await getBilag(db, dId))!.status)]);

  // 5. Medarbejderudlæg (manuel registrering)
  const kvDoc: SampleDoc = { kind: 'kvittering', supplier: 'Fiktivt Byggemarked', address: 'Testgade 9', cvr: '29990002', number: `K-${tag}`, date: today, buyer: s.company_name, lines: [{ name: 'Skruetvinger (2 stk.)', qty: 2 * K, unit: 'stk.', price: 9960 }] };
  const kt = sampleTotals(kvDoc);
  const kId = await uploadPdf(env, s, kvDoc, staff, { name: `kvittering-${tag}.pdf`, payment: 'medarbejder', paid_by: staff.email, job: job.id }, now);
  const k = (await getBilag(db, kId))!;
  step('Medarbejderudlæg', 'En medarbejder uploader en kvittering, som vedkommende selv har betalt. Den står under Udlæg, indtil den er refunderet.', [
    chk('Betaling', 'medarbejder', k.payment),
    chk('Udlæg af', staff.email, k.paid_by),
    chk('Total', kr(kt.total), kr(k.total)),
  ], { href: '/lager/bilag/udlaeg', label: 'Se udlæg' });

  // 6. Upload ændrer aldrig lageret
  step('Upload ændrer ikke lageret', 'Tre uploads og en aflæsning har ikke flyttet noget på lageret.', [chk('Samlet lagerbeholdning', formatQty(stock0), formatQty(await stockTotal()))]);

  // 7. Fordeling til lageret (ny varemodtagelse), uden at lageret ændres
  await acceptMatches(db, fId, actor, now);
  f = (await getBilag(db, fId))!;
  await addAllocation(db, f, { line_id: lines[0]?.id ?? null, target: 'lager', job_id: null, amount: f.net ?? 0, action: 'ny_modtagelse', purchase_line_id: null, product_id: product.id, qty: 10 * K, note: '' }, actor, now);
  const p0 = await stockOf(db, product.id);
  step('Fordel fakturaen til lageret', 'Fakturaen fordeles som en ny varemodtagelse. Selve fordelingen ændrer ikke lageret.', [chk(`Lager ${product.name}`, formatQty(p0), formatQty(await stockOf(db, product.id)))]);

  // 8. Varemodtagelsen registreres ved et bevidst tryk, kun én gang
  const alloc = (await allocations(db, fId))[0]!;
  const e1 = await performAllocation(env, s, f, alloc.id, actor, now, run);
  const e2 = await performAllocation(env, s, f, alloc.id, actor, now, run);
  step('Registrér varemodtagelsen', 'Varerne lægges på lageret, når der trykkes på knappen. Et dobbeltklik registrerer ikke to gange.', [
    chk('Første registrering', 'gennemført', e1 ?? 'gennemført'),
    chk(`Lager ${product.name}`, formatQty(p0 + 10 * K), formatQty(await stockOf(db, product.id))),
    chk('Anden registrering', 'afvist', e2 ? 'afvist' : 'gennemført'),
  ]);

  // 9. Udlægget fordeles på jobbet som udgift og godkendes
  const cost0 = await jobBilagCost(db, job.id);
  await addAllocation(db, k, { line_id: null, target: 'job', job_id: job.id, amount: k.net ?? 0, action: 'udgift', purchase_line_id: null, product_id: null, qty: null, note: '' }, actor, now);
  const ke = await approveBilag(db, s, (await getBilag(db, kId))!, actor, now);
  step('Udgift på job', `Udlægget fordeles på job ${job.number} som en udgift uden lagerpåvirkning og godkendes. Jobbets interne omkostning stiger med beløbet ekskl. moms.`, [
    chk('Godkendt', 'ja', ke.length ? ke.join(' ') : 'ja'),
    chk('Bilagsudgift på jobbet', kr(cost0 + (k.net ?? 0)), kr(await jobBilagCost(db, job.id))),
  ], { href: `/job/${job.id}`, label: 'Se jobbet' });

  // 10. Fakturaen godkendes; godkendelsen ændrer ikke lageret
  const p1 = await stockOf(db, product.id);
  const fe = await approveBilag(db, s, (await getBilag(db, fId))!, actor, now);
  step('Godkend fakturaen', 'Godkendelsen låser versionen til eksport. Den ændrer ikke lageret, salgspriser eller udstedte fakturaer.', [
    chk('Godkendt', 'ja', fe.length ? fe.join(' ') : 'ja'),
    chk(`Lager ${product.name}`, formatQty(p1), formatQty(await stockOf(db, product.id))),
  ]);

  // 11. Retur til leverandør og kreditnota
  const r0 = await stockOf(db, product.id);
  const rr = await run((tx) => {
    adjustStock(tx, product, 'leverandorretur', 2 * K, `Retur ${tag}`);
    tx.add(
      tx.db
        .prepare("INSERT INTO returns (kind, product_id, name, unit, qty, location, credit_state, amount, note, created_by, created_name, created_at, updated_at) VALUES ('leverandor', ?, ?, ?, ?, 'Sendt til leverandør', 'afventer', ?, ?, ?, ?, ?, ?)")
        .bind(product.id, product.name, product.unit, 2 * K, 10000, `Demo ${tag}`, actor.email, actor.name, now, now),
    );
  });
  const ret = await db.prepare('SELECT id FROM returns WHERE note = ? ORDER BY id DESC LIMIT 1').bind(`Demo ${tag}`).first<{ id: number }>();
  const crDoc: SampleDoc = { kind: 'kreditnota', supplier: DEMO_SUPPLIER.name, address: DEMO_SUPPLIER.address, cvr: DEMO_SUPPLIER.cvr, number: `KN-${tag}`, date: today, buyer: s.company_name, lines: [{ sku: product.sku, name: product.name, qty: 2 * K, unit: product.unit, price: 5000 }] };
  const cId = await uploadPdf(env, s, crDoc, actor, { name: `kreditnota-${tag}.pdf` }, now);
  const cr = (await getBilag(db, cId))!;
  if (ret) await db.prepare('UPDATE returns SET credit_bilag_id = ? WHERE id = ?').bind(cId, ret.id).run();
  await acceptMatches(db, cId, actor, now);
  await addAllocation(db, cr, { line_id: null, target: 'lager', job_id: null, amount: cr.net ?? 0, action: 'udgift', purchase_line_id: null, product_id: null, qty: null, note: 'Kredit for retur' }, actor, now);
  await approveBilag(db, s, (await getBilag(db, cId))!, actor, now);
  const retState = ret ? (await db.prepare('SELECT credit_state FROM returns WHERE id = ?').bind(ret.id).first<{ credit_state: string }>())?.credit_state : null;
  step('Retur til leverandør og kreditnota', 'To stk. sendes retur og trækkes fra lageret. Leverandørens kreditnota uploades, knyttes til returen og godkendes; først da står returen som krediteret.', [
    chk('Retur registreret', 'ja', rr.ok ? 'ja' : rr.error),
    chk(`Lager ${product.name}`, formatQty(r0 - 2 * K), formatQty(await stockOf(db, product.id))),
    chk('Kreditering', 'modtaget', retState ?? '–'),
  ], { href: '/lager/retur', label: 'Se returer' });

  // 12. Betaling på en udstedt faktura og udkast til påmindelse
  const inv = await db.prepare("SELECT * FROM invoices WHERE kind = 'faktura' AND status = 'udstedt' ORDER BY number LIMIT 1").first<import('../env').InvoiceRow>();
  if (inv) {
    const before = payStatus(inv, await creditedTotal(db, inv.id), await invoicePayments(db, inv.id));
    const amount = Math.max(1, Math.floor(before.outstanding / 4));
    if (before.outstanding > 0)
      await db
        .prepare("INSERT INTO invoice_payments (invoice_id, paid_on, amount, currency, method, reference, note, created_by, created_at) VALUES (?, ?, ?, 'DKK', 'mobilepay', ?, 'Demoforløb', ?, ?)")
        .bind(inv.id, today, amount, `DEMO-${tag}`, actor.name, now)
        .run();
    const after = payStatus(inv, await creditedTotal(db, inv.id), await invoicePayments(db, inv.id));
    if (after.outstanding > 0) await db.prepare('INSERT INTO invoice_reminders (invoice_id, outstanding, created_by, created_at) VALUES (?, ?, ?, ?)').bind(inv.id, after.outstanding, actor.email, now).run();
    step('Betaling og påmindelse', `En delvis betaling registreres manuelt på faktura ${inv.number}. Resten beregnes, og et udkast til påmindelse dannes som PDF (sendes ikke).`, [
      chk('Rest efter betaling', kr(before.outstanding - (before.outstanding > 0 ? amount : 0)), kr(after.outstanding)),
      chk('Status', after.outstanding > 0 ? (after.pay === 'forfalden' ? PAY_STATE_LABEL.forfalden : PAY_STATE_LABEL.delvist_betalt) : PAY_STATE_LABEL.betalt, PAY_STATE_LABEL[after.pay]),
    ], { href: `/job/faktura/${inv.id}#betalinger`, label: 'Se fakturaen' });
  } else step('Betaling og påmindelse', 'Der er ingen udstedt faktura i demoen.', [chk('Udstedt faktura', 'findes', 'mangler')]);

  // 13. Eksport til bogholder
  const ex = await db.prepare("INSERT INTO exports (scope, with_views, created_by, created_at) VALUES ('periode', 1, ?, ?) RETURNING id").bind(actor.name, now).first<{ id: number }>();
  const out = await buildExport(env, s, { from: '', to: '', jobId: null, views: true, all: false }, ex!.id, true);
  const stored = await storeFile(db, out.bytes, actor.email, now, ['zip'], 90 * 1024 * 1024);
  const stmts: D1PreparedStatement[] = [db.prepare('UPDATE exports SET file_id = ?, bilag_count = ?, invoice_count = ? WHERE id = ?').bind(stored.ok ? stored.file.id : null, out.bilag.length, out.invoices.length, ex!.id)];
  for (const b of out.bilag)
    stmts.push(
      db.prepare("INSERT INTO export_items (export_id, kind, ref_id, version, data) VALUES (?, 'bilag', ?, ?, '{}')").bind(ex!.id, b.id, b.version),
      db.prepare('UPDATE bilag SET exported_version = version, exported_at = ?, export_id = ?, export_failed = 0 WHERE id = ?').bind(now, ex!.id, b.id),
      eventStmt(db, b.id, b.version, 'eksport', `Eksporteret til bogholder (eksport #${ex!.id}). Ikke bogført.`, actor, now),
    );
  for (const i of out.invoices) stmts.push(db.prepare('UPDATE invoices SET exported_at = ?, export_id = ? WHERE id = ?').bind(now, ex!.id, i.id));
  await db.batch(stmts);
  step('Eksport til bogholder', 'En ZIP med originaler, digitale visninger, fakturaer og CSV-oversigter dannes. Den sendes ikke nogen steder hen, og intet markeres som bogført.', [
    chk('Fakturaen er med', 'ja', out.bilag.some((b) => b.id === fId) ? 'ja' : 'nej'),
    chk('Eksportstatus', 'Eksporteret', exportState((await getBilag(db, fId))!) === 'eksporteret' ? 'Eksporteret' : exportState((await getBilag(db, fId))!)),
    chk('ZIP gemt', 'ja', stored.ok ? 'ja' : 'nej'),
  ], { href: '/lager/bilag/eksport', label: 'Se eksporten' });

  // 14. Rettelse efter eksport: ny version
  f = (await getBilag(db, fId))!;
  await saveBilag(db, f, { doc_type: f.doc_type, supplier_name: f.supplier_name, supplier_cvr: f.supplier_cvr, doc_number: f.doc_number, doc_date: f.doc_date, due_date: f.due_date, currency: f.currency, net: f.net, vat: f.vat, total: f.total, rounding: f.rounding, line_prices: f.line_prices, payment_info: `${f.payment_info} (rettet)`, payment: f.payment, paid_by: f.paid_by, note: f.note }, null, actor, now);
  f = (await getBilag(db, fId))!;
  step('Ret et eksporteret bilag', 'En rettelse giver en ny version, som skal godkendes igen. Bilaget står som ændret siden seneste eksport, og historikken viser begge versioner.', [
    chk('Version', 2, f.version),
    chk('Status', 'klar', f.status),
    chk('Eksportstatus', 'aendret', exportState(f)),
  ], { href: `/lager/bilag/${fId}`, label: 'Se historikken' });

  return steps;
}
