// Vareforbrug på job: direkte forbrug, planlagte materialer (reservationer), udlevering,
// frigivelse og returnering, samt automatisk indkøbsbehov, når lageret ikke rækker.

import type { JobMaterialRow, JobRow, ProductRow } from '../env';
import { formatQty } from './format';
import { Conflict, type Tx } from './ledger';

export type ProductWithSupplier = ProductRow & { supplier_name: string | null; supplier_lead_time: number | null };

export const PRODUCT_SQL = `SELECT p.*, s.name AS supplier_name, s.lead_time_days AS supplier_lead_time
  FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id`;

export async function getProduct(db: D1Database, id: number): Promise<ProductWithSupplier | null> {
  return db.prepare(`${PRODUCT_SQL} WHERE p.id = ?`).bind(id).first<ProductWithSupplier>();
}

export async function getJob(db: D1Database, id: number): Promise<JobRow | null> {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first<JobRow>();
}

const EMPTY = { planned: 0, reserved: 0, issued: 0, returned: 0, site_received: 0, site_used: 0, site_returned: 0 };
export type MaterialState = Pick<JobMaterialRow, keyof typeof EMPTY>;

export async function getMaterial(db: D1Database, jobId: number, productId: number): Promise<MaterialState> {
  const row = await db.prepare('SELECT * FROM job_materials WHERE job_id = ? AND product_id = ?').bind(jobId, productId).first<JobMaterialRow>();
  return row ?? { ...EMPTY };
}

/** Indkøb, der dækker et jobs behov for en vare (ikke-annullerede linjer). */
export interface Coverage {
  /** Alt, der er på indkøbslister og endnu ikke modtaget (kladde, klar og bestilt) */
  pending: number;
  /** Heraf bestilt hos leverandøren og endnu ikke modtaget */
  onOrder: number;
  /** Den automatiske kladdelinje (opdateres af systemet) */
  autoDraft: { id: number; list_id: number; qty: number } | null;
  /** Bestilt eller markeret klar til indkøb (røres ikke automatisk) */
  committed: number;
}

export async function coverage(db: D1Database, jobId: number, productId: number): Promise<Coverage> {
  const { results } = await db
    .prepare(
      `SELECT id, list_id, qty, ordered, received, ready, auto FROM purchase_lines
       WHERE job_id = ? AND product_id = ? AND cancelled = 0`,
    )
    .bind(jobId, productId)
    .all<{ id: number; list_id: number; qty: number; ordered: number; received: number; ready: number; auto: number }>();
  let pending = 0;
  let onOrder = 0;
  let committed = 0;
  let autoDraft: Coverage['autoDraft'] = null;
  for (const l of results) {
    const open = Math.max(l.qty, l.ordered) - l.received;
    pending += open;
    onOrder += l.ordered - l.received;
    if (l.auto && !l.ordered && !l.ready) autoDraft = { id: l.id, list_id: l.list_id, qty: l.qty };
    else committed += open;
  }
  return { pending, onOrder, autoDraft, committed };
}

/** Det, der er dækket af lager og arbejdssted (uden indkøb). */
export function coveredByStock(m: MaterialState): number {
  return m.issued - m.returned + m.reserved + m.site_received - m.site_returned;
}

/** Det, jobbet allerede har brugt (kan ikke fortrydes ved at ændre behovet). */
export function usedSoFar(m: MaterialState): number {
  return m.issued - m.returned + m.site_used;
}

function upsertMaterial(tx: Tx, jobId: number, productId: number, set: Partial<Record<keyof typeof EMPTY, number>>): void {
  const cols = Object.keys(set) as (keyof typeof EMPTY)[];
  const insertCols = cols.join(', ');
  const insertVals = cols.map(() => '?').join(', ');
  const updates = cols.map((c) => `${c} = ${c} + excluded.${c}`).join(', ');
  tx.add(
    tx.db
      .prepare(
        `INSERT INTO job_materials (job_id, product_id, ${insertCols}, updated_at) VALUES (?, ?, ${insertVals}, ?)
         ON CONFLICT(job_id, product_id) DO UPDATE SET ${updates}, updated_at = excluded.updated_at`,
      )
      .bind(jobId, productId, ...cols.map((c) => set[c]!), tx.now),
  );
}

function requireActiveJob(job: JobRow): void {
  if (job.status !== 'aktiv') throw new Conflict('Jobbet er afsluttet. Genåbn jobbet for at registrere materialer.');
}

function wholeCheck(p: ProductRow, q: number): void {
  if (p.whole_units && q % 1000 !== 0) throw new Conflict(`${p.name} håndteres kun i hele ${p.unit}.`);
}

function noStock(p: ProductRow, q: number, available: number): Conflict {
  return new Conflict(
    `Der er kun ${formatQty(Math.max(0, available))} ${p.unit} ${p.name} disponibelt, så ${formatQty(q)} ${p.unit} kan ikke tages fra lageret. ` +
      'Registrér det som planlagt forbrug, så resten kommer på jobbets indkøbsliste.',
  );
}

/**
 * Direkte forbrug: materialet bruges eller udleveres med det samme og trækkes straks fra den
 * fysiske beholdning. Kan kun tage det, der er disponibelt (reservationer til andre job røres ikke).
 */
export function consumeDirect(tx: Tx, job: JobRow, p: ProductRow, q: number, reason = ''): void {
  requireActiveJob(job);
  wholeCheck(p, q);
  const available = p.stock - p.reserved;
  if (q > available) throw noStock(p, q, available);
  tx.add(tx.db.prepare('UPDATE products SET stock = stock - ?, updated_at = ? WHERE id = ?').bind(q, tx.now, p.id));
  upsertMaterial(tx, job.id, p.id, { planned: q, issued: q });
  tx.move({ product_id: p.id, job_id: job.id, kind: 'forbrug', qty: q, stock_delta: -q, unit_cost: p.purchase_price, reason });
}

/**
 * Planlagt forbrug: behovet øges, og det, der kan, reserveres fra lageret. Den fysiske beholdning
 * er uændret, men den disponible falder. Det, der ikke kan reserveres, bliver til indkøbsbehov
 * (se reconcile), uden at lageret nogensinde bliver negativt.
 */
export async function planMaterial(tx: Tx, job: JobRow, p: ProductRow, add: number, reason = ''): Promise<{ reserved: number; short: number }> {
  requireActiveJob(job);
  wholeCheck(p, add);
  const m = await getMaterial(tx.db, job.id, p.id);
  const cov = await coverage(tx.db, job.id, p.id);
  const planned = m.planned + add;
  // Varer, der allerede er bestilt til jobbet, kommer; resten tages fra lageret, så langt det rækker
  const uncovered = planned - coveredByStock(m) - cov.committed;
  const available = Math.max(0, p.stock - p.reserved);
  const r = Math.max(0, Math.min(uncovered, available));
  if (r) tx.add(tx.db.prepare('UPDATE products SET reserved = reserved + ?, updated_at = ? WHERE id = ?').bind(r, tx.now, p.id));
  upsertMaterial(tx, job.id, p.id, { planned: add, reserved: r });
  tx.move({ product_id: p.id, job_id: job.id, kind: 'planlagt', qty: add, reserved_delta: r, reason });
  return { reserved: r, short: Math.max(0, uncovered - r) };
}

/** Ændrer det samlede behov. Et lavere behov frigiver først overskydende reservationer. */
export async function setPlanned(tx: Tx, job: JobRow, p: ProductRow, next: number): Promise<void> {
  const m = await getMaterial(tx.db, job.id, p.id);
  if (next === m.planned) return;
  if (next > m.planned) {
    await planMaterial(tx, job, p, next - m.planned, `Behov ændret fra ${formatQty(m.planned)} til ${formatQty(next)}`);
    return;
  }
  requireActiveJob(job);
  wholeCheck(p, next);
  if (next < usedSoFar(m)) throw new Conflict(`Behovet kan ikke være mindre end de ${formatQty(usedSoFar(m))} ${p.unit}, der allerede er brugt på jobbet.`);
  const cov = await coverage(tx.db, job.id, p.id);
  const excess = coveredByStock(m) + cov.committed - next;
  const release = Math.max(0, Math.min(excess, m.reserved));
  if (release) tx.add(tx.db.prepare('UPDATE products SET reserved = reserved - ?, updated_at = ? WHERE id = ?').bind(release, tx.now, p.id));
  tx.add(
    tx.db
      .prepare('UPDATE job_materials SET planned = ?, reserved = reserved - ?, updated_at = ? WHERE job_id = ? AND product_id = ?')
      .bind(next, release, tx.now, job.id, p.id),
  );
  tx.move({
    product_id: p.id,
    job_id: job.id,
    kind: release ? 'frigivelse' : 'behov',
    qty: m.planned - next,
    reserved_delta: -release,
    reason: `Behov ændret fra ${formatQty(m.planned)} til ${formatQty(next)}`,
  });
}

/** Udlevering af reserverede varer: trækkes fra det fysiske lager, og reservationen fjernes samtidig. */
export async function issueReserved(tx: Tx, job: JobRow, p: ProductRow, q: number, reason = ''): Promise<void> {
  requireActiveJob(job);
  wholeCheck(p, q);
  const m = await getMaterial(tx.db, job.id, p.id);
  if (q > m.reserved) throw new Conflict(`Der er kun ${formatQty(m.reserved)} ${p.unit} reserveret til jobbet.`);
  tx.add(
    tx.db.prepare('UPDATE products SET stock = stock - ?1, reserved = reserved - ?1, updated_at = ?2 WHERE id = ?3').bind(q, tx.now, p.id),
    tx.db
      .prepare('UPDATE job_materials SET reserved = reserved - ?1, issued = issued + ?1, updated_at = ?2 WHERE job_id = ?3 AND product_id = ?4')
      .bind(q, tx.now, job.id, p.id),
  );
  tx.move({ product_id: p.id, job_id: job.id, kind: 'udlevering', qty: q, stock_delta: -q, reserved_delta: -q, unit_cost: p.purchase_price, reason });
}

/** Annullerer (en del af) en reservation: varerne bliver disponible igen, og behovet falder tilsvarende. */
export async function releaseReservation(tx: Tx, job: JobRow, p: ProductRow, q: number, reason = ''): Promise<void> {
  wholeCheck(p, q);
  const m = await getMaterial(tx.db, job.id, p.id);
  if (q > m.reserved) throw new Conflict(`Der er kun ${formatQty(m.reserved)} ${p.unit} reserveret til jobbet.`);
  tx.add(
    tx.db.prepare('UPDATE products SET reserved = reserved - ?, updated_at = ? WHERE id = ?').bind(q, tx.now, p.id),
    tx.db
      .prepare(
        `UPDATE job_materials SET reserved = reserved - ?1, planned = MAX(planned - ?1, issued - returned + site_used), updated_at = ?2
         WHERE job_id = ?3 AND product_id = ?4`,
      )
      .bind(q, tx.now, job.id, p.id),
  );
  tx.move({ product_id: p.id, job_id: job.id, kind: 'frigivelse', qty: q, reserved_delta: -q, reason });
}

/** Ubrugte, brugbare materialer føres tilbage til lageret og trækkes fra jobbets forbrug. */
export async function returnToStock(tx: Tx, job: JobRow, p: ProductRow, q: number, reason = ''): Promise<void> {
  wholeCheck(p, q);
  const m = await getMaterial(tx.db, job.id, p.id);
  const net = m.issued - m.returned;
  if (q > net) throw new Conflict(`Jobbet har kun fået ${formatQty(net)} ${p.unit} fra lageret, så der kan højst returneres ${formatQty(net)}.`);
  tx.add(
    tx.db.prepare('UPDATE products SET stock = stock + ?, updated_at = ? WHERE id = ?').bind(q, tx.now, p.id),
    tx.db
      .prepare(
        `UPDATE job_materials SET returned = returned + ?1, planned = MAX(planned - ?1, issued - returned - ?1 + site_used), updated_at = ?2
         WHERE job_id = ?3 AND product_id = ?4`,
      )
      .bind(q, tx.now, job.id, p.id),
  );
  tx.move({ product_id: p.id, job_id: job.id, kind: 'retur', qty: q, stock_delta: q, unit_cost: p.purchase_price, reason });
}

/** Forbrug af varer, der er leveret direkte til arbejdsstedet (påvirker ikke hovedlageret). */
export async function useFromSite(tx: Tx, job: JobRow, p: ProductRow, q: number, reason = ''): Promise<void> {
  requireActiveJob(job);
  wholeCheck(p, q);
  const m = await getMaterial(tx.db, job.id, p.id);
  const onSite = m.site_received - m.site_used - m.site_returned;
  if (q > onSite) throw new Conflict(`Der er kun ${formatQty(onSite)} ${p.unit} på arbejdsstedet.`);
  tx.add(
    tx.db.prepare('UPDATE job_materials SET site_used = site_used + ?, updated_at = ? WHERE job_id = ? AND product_id = ?').bind(q, tx.now, job.id, p.id),
  );
  tx.move({ product_id: p.id, job_id: job.id, kind: 'arbejdssted_forbrug', qty: q, unit_cost: p.purchase_price, reason });
}

/** Overskydende varer fra arbejdsstedet lægges på hovedlageret. */
export async function siteToStock(tx: Tx, job: JobRow, p: ProductRow, q: number, reason = ''): Promise<void> {
  wholeCheck(p, q);
  const m = await getMaterial(tx.db, job.id, p.id);
  const onSite = m.site_received - m.site_used - m.site_returned;
  if (q > onSite) throw new Conflict(`Der er kun ${formatQty(onSite)} ${p.unit} på arbejdsstedet.`);
  tx.add(
    tx.db.prepare('UPDATE products SET stock = stock + ?, updated_at = ? WHERE id = ?').bind(q, tx.now, p.id),
    tx.db
      .prepare(
        `UPDATE job_materials SET site_returned = site_returned + ?1, planned = MAX(planned - ?1, issued - returned + site_used), updated_at = ?2
         WHERE job_id = ?3 AND product_id = ?4`,
      )
      .bind(q, tx.now, job.id, p.id),
  );
  tx.move({ product_id: p.id, job_id: job.id, kind: 'arbejdssted_retur', qty: q, stock_delta: q, reason });
}

/** Afslutter et job: reservationer, der ikke er udleveret, frigives, og automatiske kladder fjernes. */
export async function closeJob(tx: Tx, job: JobRow, status: 'afsluttet' | 'annulleret'): Promise<void> {
  const { results } = await tx.db
    .prepare('SELECT product_id, reserved FROM job_materials WHERE job_id = ? AND reserved > 0')
    .bind(job.id)
    .all<{ product_id: number; reserved: number }>();
  for (const r of results) {
    tx.add(
      tx.db.prepare('UPDATE products SET reserved = reserved - ?, updated_at = ? WHERE id = ?').bind(r.reserved, tx.now, r.product_id),
      tx.db
        .prepare('UPDATE job_materials SET reserved = 0, planned = issued - returned + site_used, updated_at = ? WHERE job_id = ? AND product_id = ?')
        .bind(tx.now, job.id, r.product_id),
    );
    tx.move({ product_id: r.product_id, job_id: job.id, kind: 'job_afsluttet', qty: r.reserved, reserved_delta: -r.reserved });
  }
  tx.add(
    tx.db.prepare(`UPDATE job_materials SET planned = issued - returned + site_used, updated_at = ? WHERE job_id = ?`).bind(tx.now, job.id),
    tx.db.prepare('DELETE FROM purchase_lines WHERE job_id = ? AND auto = 1 AND ordered = 0 AND ready = 0 AND cancelled = 0').bind(job.id),
    tx.db.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?').bind(status, tx.now, job.id),
  );
  tx.jobs.add(job.id);
}

/** Jobbets første aktive indkøbsliste (oprettes, hvis jobbet ikke har nogen). */
export async function defaultJobList(db: D1Database, job: JobRow, now: number): Promise<number> {
  const row = await db
    .prepare("SELECT id FROM purchase_lists WHERE job_id = ? AND kind = 'job' AND archived = 0 ORDER BY id LIMIT 1")
    .bind(job.id)
    .first<{ id: number }>();
  if (row) return row.id;
  const created = await db
    .prepare("INSERT INTO purchase_lists (job_id, kind, name, created_at, updated_at) VALUES (?, 'job', ?, ?, ?) RETURNING id")
    .bind(job.id, `Materialer til ${job.number}`, now, now)
    .first<{ id: number }>();
  return created!.id;
}

/**
 * Automatisk indkøbsbehov: for hver vare på jobbet beregnes, hvad der hverken er dækket af lager,
 * arbejdssted eller indkøb, der allerede er klar eller bestilt. Den mængde står på jobbets
 * automatiske kladdelinje, som opdateres i stedet for at blive oprettet igen. Er der bestilt mere,
 * end jobbet nu skal bruge, ændres bestillingen ikke; indkøberen får i stedet en afvigelse.
 * Beregningen bygger altid på den aktuelle tilstand, så den kan køres igen uden at skabe dubletter.
 */
export async function reconcileJob(db: D1Database, jobId: number, now: number): Promise<{ added: number; lists: number[] }> {
  const job = await getJob(db, jobId);
  if (!job) return { added: 0, lists: [] };
  const { results: mats } = await db
    .prepare(`SELECT m.*, p.sku, p.name, p.unit, p.supplier_id, p.purchase_price FROM job_materials m JOIN products p ON p.id = m.product_id WHERE m.job_id = ?`)
    .bind(jobId)
    .all<JobMaterialRow & Pick<ProductRow, 'sku' | 'name' | 'unit' | 'supplier_id' | 'purchase_price'>>();
  const stmts: D1PreparedStatement[] = [];
  const touched = new Set<number>();
  let added = 0;
  let listId: number | null = null;
  for (const m of mats) {
    const cov = await coverage(db, jobId, m.product_id);
    const target = job.status === 'aktiv' ? m.planned - coveredByStock(m) - cov.committed : 0;
    const draft = cov.autoDraft;
    if (target > 0) {
      if (draft) {
        if (draft.qty !== target) {
          stmts.push(db.prepare('UPDATE purchase_lines SET qty = ?, updated_at = ? WHERE id = ?').bind(target, now, draft.id));
          touched.add(draft.list_id);
          added += Math.max(0, target - draft.qty);
        }
      } else {
        listId ??= await defaultJobList(db, job, now);
        stmts.push(
          db
            .prepare(
              `INSERT INTO purchase_lines (list_id, job_id, product_id, sku, name, unit, supplier_id, qty, unit_price, auto, note, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'Mangler til jobbet', ?, ?)
               ON CONFLICT(job_id, product_id) WHERE auto = 1 AND ordered = 0 AND ready = 0 AND cancelled = 0
               DO UPDATE SET qty = excluded.qty, updated_at = excluded.updated_at`,
            )
            .bind(listId, jobId, m.product_id, m.sku, m.name, m.unit, m.supplier_id, target, m.purchase_price, now, now),
        );
        touched.add(listId);
        added += target;
      }
    } else if (draft) {
      stmts.push(db.prepare('DELETE FROM purchase_lines WHERE id = ?').bind(draft.id));
      touched.add(draft.list_id);
    }
    // Afvigelse: der er klar eller bestilt mere end behovet (bestillinger ændres aldrig automatisk)
    const excess = coveredByStock(m) + cov.committed - m.planned;
    if (job.status === 'aktiv' && excess > 0 && cov.committed > 0) {
      const msg = `${job.number} ${job.name}: Der er bestilt eller klar til indkøb ${formatQty(Math.min(excess, cov.committed))} ${m.unit} ${m.name} mere end jobbets behov. Bestillingen er ikke ændret.`;
      stmts.push(
        db
          .prepare(
            `INSERT INTO notices (kind, level, product_id, job_id, message, created_at) VALUES ('afvigelse', 1, ?, ?, ?, ?)
             ON CONFLICT(job_id, product_id) WHERE kind = 'afvigelse' AND open = 1 DO UPDATE SET message = excluded.message`,
          )
          .bind(m.product_id, jobId, msg, now),
      );
    } else {
      stmts.push(
        db
          .prepare("UPDATE notices SET open = 0, resolved_at = ? WHERE kind = 'afvigelse' AND open = 1 AND job_id = ? AND product_id = ?")
          .bind(now, jobId, m.product_id),
      );
    }
  }
  for (const id of touched) stmts.push(db.prepare('UPDATE purchase_lists SET version = version + 1, updated_at = ? WHERE id = ?').bind(now, id));
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  return { added, lists: [...touched] };
}

/** Materialestatus pr. vare på et job (til visning). */
export interface MaterialView extends MaterialState {
  product_id: number;
  sku: string;
  name: string;
  unit: string;
  whole_units: number;
  stock: number;
  product_reserved: number;
  purchase_price: number | null;
  sale_price: number | null;
  pending: number;
  onOrder: number;
  /** Mangler, der ikke er dækket af lager eller arbejdssted (venter på indkøb) */
  waiting: number;
  /** Mangler, der heller ikke er på en indkøbsliste */
  uncovered: number;
}

export async function jobMaterials(db: D1Database, jobId: number): Promise<MaterialView[]> {
  const { results } = await db
    .prepare(
      `SELECT m.*, p.sku, p.name, p.unit, p.whole_units, p.stock, p.reserved AS product_reserved, p.purchase_price, p.sale_price,
         COALESCE((SELECT SUM(MAX(l.qty, l.ordered) - l.received) FROM purchase_lines l WHERE l.job_id = m.job_id AND l.product_id = m.product_id AND l.cancelled = 0), 0) AS pending,
         COALESCE((SELECT SUM(l.ordered - l.received) FROM purchase_lines l WHERE l.job_id = m.job_id AND l.product_id = m.product_id AND l.cancelled = 0), 0) AS onOrder
       FROM job_materials m JOIN products p ON p.id = m.product_id
       WHERE m.job_id = ?
       ORDER BY p.name`,
    )
    .bind(jobId)
    .all<Omit<MaterialView, 'waiting' | 'uncovered'> & { id: number }>();
  return results.map((r) => {
    const waiting = Math.max(0, r.planned - coveredByStock(r));
    return { ...r, waiting, uncovered: Math.max(0, waiting - r.pending) };
  });
}

/** "Afventer materialer", når noget af behovet endnu ikke er på lager eller arbejdsstedet. */
export function materialStatus(mats: Pick<MaterialView, 'waiting'>[]): 'klar' | 'afventer' | 'ingen' {
  if (!mats.length) return 'ingen';
  return mats.some((m) => m.waiting > 0) ? 'afventer' : 'klar';
}

/**
 * Forbrug registreret af en medarbejder: tages først fra jobbets reservation (udlevering) og
 * resten direkte fra den disponible beholdning. Mere end det kan ikke tages fra lageret.
 */
export async function registerUse(tx: Tx, job: JobRow, p: ProductRow, q: number, reason = ''): Promise<void> {
  requireActiveJob(job);
  wholeCheck(p, q);
  const m = await getMaterial(tx.db, job.id, p.id);
  const fromReserved = Math.min(q, m.reserved);
  const rest = q - fromReserved;
  const available = p.stock - p.reserved;
  if (rest > available) {
    throw new Conflict(
      `${p.name}: der er ${formatQty(m.reserved)} ${p.unit} reserveret til jobbet og ${formatQty(Math.max(0, available))} ${p.unit} disponibelt, så ${formatQty(q)} ${p.unit} kan ikke tages fra lageret. ` +
        'Registrér resten som planlagt forbrug, så det kommer på jobbets indkøbsliste.',
    );
  }
  if (fromReserved) await issueReserved(tx, job, p, fromReserved, reason);
  if (rest) consumeDirect(tx, job, p, rest, reason);
}
