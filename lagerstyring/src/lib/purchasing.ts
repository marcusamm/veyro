// Indkøbslister pr. job og til lageropfyldning: linjer, bestilling hos leverandør og varemodtagelse.
// En sendt indkøbsliste er kun en orientering; bestilling registreres særskilt, og varer lægges
// først på lageret, når de er modtaget.

import type { JobRow, PurchaseLineRow, PurchaseListRow } from '../env';
import { formatQty } from './format';
import { Conflict, type Tx } from './ledger';

export type LineStatus = 'kladde' | 'klar' | 'delvist_bestilt' | 'bestilt' | 'delvist_modtaget' | 'modtaget' | 'annulleret';

export const LINE_STATUS_LABEL: Record<LineStatus, string> = {
  kladde: 'Kladde',
  klar: 'Klar til indkøb',
  delvist_bestilt: 'Delvist bestilt',
  bestilt: 'Bestilt',
  delvist_modtaget: 'Delvist modtaget',
  modtaget: 'Modtaget',
  annulleret: 'Annulleret',
};

export const LINE_STATUS_TAG: Record<LineStatus, string> = {
  kladde: 'tag-off',
  klar: 'tag-ready',
  delvist_bestilt: 'tag-ordered',
  bestilt: 'tag-ordered',
  delvist_modtaget: 'tag-low',
  modtaget: 'tag-ok',
  annulleret: 'tag-off',
};

type LineLike = Pick<PurchaseLineRow, 'qty' | 'ordered' | 'received' | 'ready' | 'cancelled'>;

export function lineStatus(l: LineLike): LineStatus {
  if (l.cancelled) return l.received > 0 ? 'delvist_modtaget' : 'annulleret';
  const want = Math.max(l.qty, l.ordered);
  if (l.received > 0) return l.received >= want ? 'modtaget' : 'delvist_modtaget';
  if (l.ordered > 0) return l.ordered >= l.qty ? 'bestilt' : 'delvist_bestilt';
  return l.ready ? 'klar' : 'kladde';
}

const ORDER: LineStatus[] = ['kladde', 'klar', 'delvist_bestilt', 'bestilt', 'delvist_modtaget', 'modtaget'];

/** Samlet status for en liste ud fra linjerne (annullerede linjer tæller ikke med). */
export function listStatus(lines: LineLike[]): LineStatus {
  const live = lines.filter((l) => !l.cancelled);
  if (!lines.length) return 'kladde';
  if (!live.length) return 'annulleret';
  const st = live.map(lineStatus);
  if (st.every((s) => s === 'modtaget')) return 'modtaget';
  if (live.some((l) => l.received > 0)) return 'delvist_modtaget';
  if (st.every((s) => s === 'bestilt')) return 'bestilt';
  if (live.some((l) => l.ordered > 0)) return 'delvist_bestilt';
  if (st.every((s) => s === 'klar')) return 'klar';
  return ORDER[0]!;
}

/** Det, der stadig mangler at blive modtaget på linjen. */
export function outstanding(l: Pick<PurchaseLineRow, 'qty' | 'ordered' | 'received' | 'cancelled'>): number {
  return l.cancelled ? 0 : Math.max(l.qty, l.ordered) - l.received;
}

export type LineView = PurchaseLineRow & {
  supplier_name: string | null;
  supplier_email: string | null;
  list_name: string;
  list_kind: 'job' | 'lager';
  job_number: string | null;
  job_name: string | null;
  whole_units: number | null;
};

const LINE_SQL = `SELECT l.*, s.name AS supplier_name, s.email AS supplier_email, pl.name AS list_name, pl.kind AS list_kind,
  j.number AS job_number, j.name AS job_name, p.whole_units
  FROM purchase_lines l
  JOIN purchase_lists pl ON pl.id = l.list_id
  LEFT JOIN suppliers s ON s.id = l.supplier_id
  LEFT JOIN jobs j ON j.id = l.job_id
  LEFT JOIN products p ON p.id = l.product_id`;

export async function getList(db: D1Database, id: number): Promise<(PurchaseListRow & { job_number: string | null; job_name: string | null }) | null> {
  return db
    .prepare('SELECT pl.*, j.number AS job_number, j.name AS job_name FROM purchase_lists pl LEFT JOIN jobs j ON j.id = pl.job_id WHERE pl.id = ?')
    .bind(id)
    .first();
}

export async function getLine(db: D1Database, id: number): Promise<LineView | null> {
  return db.prepare(`${LINE_SQL} WHERE l.id = ?`).bind(id).first<LineView>();
}

export async function listLines(db: D1Database, listId: number): Promise<LineView[]> {
  const { results } = await db.prepare(`${LINE_SQL} WHERE l.list_id = ? ORDER BY COALESCE(s.name, 'ÿ'), l.name`).bind(listId).all<LineView>();
  return results;
}

/** Linjer, der mangler at blive bestilt (kladde og klar), på tværs af lister, grupperet efter leverandør. */
export async function linesToOrder(db: D1Database): Promise<LineView[]> {
  const { results } = await db
    .prepare(`${LINE_SQL} WHERE l.cancelled = 0 AND l.ordered < l.qty AND pl.archived = 0 ORDER BY COALESCE(s.name, 'ÿ'), l.ready DESC, l.name`)
    .all<LineView>();
  return results;
}

/** Bestilte linjer, der ikke er modtaget fuldt ud. */
export async function linesToReceive(db: D1Database): Promise<LineView[]> {
  const { results } = await db
    .prepare(`${LINE_SQL} WHERE l.cancelled = 0 AND l.ordered > l.received ORDER BY COALESCE(s.name, 'ÿ'), l.expected_date, l.name`)
    .all<LineView>();
  return results;
}

/** Åbne indkøb af en vare (bestilt eller på en liste, ikke modtaget). */
export async function openPurchasesFor(db: D1Database, productId: number): Promise<LineView[]> {
  const { results } = await db
    .prepare(`${LINE_SQL} WHERE l.product_id = ? AND l.cancelled = 0 AND MAX(l.qty, l.ordered) > l.received ORDER BY l.expected_date, l.id`)
    .bind(productId)
    .all<LineView>();
  return results;
}

export interface ListOverview extends PurchaseListRow {
  job_number: string | null;
  job_name: string | null;
  line_count: number;
  status: LineStatus;
  total: number;
  last_sent_at: number | null;
  last_sent_version: number | null;
  last_sent_to: string | null;
  last_sent_status: string | null;
}

export async function listsOverview(db: D1Database, opts: { archived?: boolean; jobId?: number } = {}): Promise<ListOverview[]> {
  const where = [opts.archived ? 'pl.archived = 1' : 'pl.archived = 0'];
  const binds: unknown[] = [];
  if (opts.jobId) {
    where.push('pl.job_id = ?');
    binds.push(opts.jobId);
  }
  const { results: lists } = await db
    .prepare(
      `SELECT pl.*, j.number AS job_number, j.name AS job_name,
         (SELECT created_at FROM mails m WHERE m.list_id = pl.id ORDER BY m.id DESC LIMIT 1) AS last_sent_at,
         (SELECT list_version FROM mails m WHERE m.list_id = pl.id ORDER BY m.id DESC LIMIT 1) AS last_sent_version,
         (SELECT recipient FROM mails m WHERE m.list_id = pl.id ORDER BY m.id DESC LIMIT 1) AS last_sent_to,
         (SELECT status FROM mails m WHERE m.list_id = pl.id ORDER BY m.id DESC LIMIT 1) AS last_sent_status
       FROM purchase_lists pl LEFT JOIN jobs j ON j.id = pl.job_id
       WHERE ${where.join(' AND ')}
       ORDER BY pl.kind = 'job', j.number, pl.id`,
    )
    .bind(...binds)
    .all<Omit<ListOverview, 'line_count' | 'status' | 'total'>>();
  if (!lists.length) return [];
  const { results: lines } = await db
    .prepare(
      `SELECT list_id, qty, ordered, received, ready, cancelled, COALESCE(actual_price, unit_price) AS price FROM purchase_lines
       WHERE list_id IN (${lists.map(() => '?').join(',')})`,
    )
    .bind(...lists.map((l) => l.id))
    .all<LineLike & { list_id: number; price: number | null }>();
  return lists.map((l) => {
    const own = lines.filter((x) => x.list_id === l.id);
    const total = own.filter((x) => !x.cancelled).reduce((s, x) => s + Math.round(((x.price ?? 0) * Math.max(x.qty, x.ordered)) / 1000), 0);
    return { ...l, line_count: own.filter((x) => !x.cancelled).length, status: listStatus(own), total };
  });
}

export interface LineInput {
  product_id: number | null;
  sku: string;
  name: string;
  unit: string;
  supplier_id: number | null;
  qty: number;
  unit_price: number | null;
  expected_date: string;
  deliver_to: 'lager' | 'arbejdssted';
  note: string;
}

export async function createList(
  db: D1Database,
  input: { job_id: number | null; name: string; responsible: string; wanted_date: string; note: string },
  now: number,
): Promise<number> {
  const row = await db
    .prepare('INSERT INTO purchase_lists (job_id, kind, name, responsible, wanted_date, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id')
    .bind(input.job_id, input.job_id ? 'job' : 'lager', input.name, input.responsible, input.wanted_date, input.note, now, now)
    .first<{ id: number }>();
  return row!.id;
}

/** Listen til lageropfyldning (findes altid; oprettes første gang den skal bruges). */
export async function stockList(db: D1Database, now: number): Promise<number> {
  const row = await db.prepare("SELECT id FROM purchase_lists WHERE kind = 'lager' AND archived = 0 ORDER BY id LIMIT 1").first<{ id: number }>();
  if (row) return row.id;
  return createList(db, { job_id: null, name: 'Lageropfyldning', responsible: '', wanted_date: '', note: '' }, now);
}

export function addLine(tx: Tx, list: PurchaseListRow, input: LineInput): void {
  if (input.deliver_to === 'arbejdssted' && !list.job_id) throw new Conflict('Direkte levering til arbejdssted kræver, at listen hører til et job.');
  tx.add(
    tx.db
      .prepare(
        `INSERT INTO purchase_lines (list_id, job_id, product_id, sku, name, unit, supplier_id, qty, unit_price, expected_date, deliver_to, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        list.id,
        list.job_id,
        input.product_id,
        input.sku,
        input.name,
        input.unit,
        input.supplier_id,
        input.qty,
        input.unit_price,
        input.expected_date,
        input.deliver_to,
        input.note,
        tx.now,
        tx.now,
      ),
  );
  tx.touchList(list.id);
  if (list.job_id) tx.jobs.add(list.job_id);
}

/**
 * Retter en linje. En automatisk linje, som indkøberen retter, bliver en almindelig linje, så
 * systemet ikke overskriver indkøberens mængde.
 */
export function updateLine(
  tx: Tx,
  line: PurchaseLineRow,
  input: Pick<LineInput, 'qty' | 'supplier_id' | 'unit_price' | 'expected_date' | 'note' | 'deliver_to'>,
): void {
  if (line.cancelled) throw new Conflict('Linjen er annulleret.');
  if (input.qty < line.ordered) throw new Conflict(`Der er allerede bestilt ${formatQty(line.ordered)} ${line.unit}. Mængden kan ikke være mindre.`);
  if (input.deliver_to === 'arbejdssted' && !line.job_id) throw new Conflict('Direkte levering til arbejdssted kræver et job.');
  if (input.deliver_to !== line.deliver_to && line.received > 0) throw new Conflict('Leveringsstedet kan ikke ændres, når der er modtaget varer.');
  tx.add(
    tx.db
      .prepare(
        `UPDATE purchase_lines SET qty = ?, supplier_id = ?, unit_price = ?, expected_date = ?, note = ?, deliver_to = ?,
           auto = CASE WHEN qty = ? THEN auto ELSE 0 END, updated_at = ? WHERE id = ?`,
      )
      .bind(input.qty, input.supplier_id, input.unit_price, input.expected_date, input.note, input.deliver_to, input.qty, tx.now, line.id),
  );
  tx.touchList(line.list_id);
  if (line.job_id) tx.jobs.add(line.job_id);
}

export function setReady(tx: Tx, lines: PurchaseLineRow[], ready: boolean): void {
  for (const l of lines) {
    if (l.cancelled || l.ordered > 0) continue;
    tx.add(tx.db.prepare('UPDATE purchase_lines SET ready = ?, updated_at = ? WHERE id = ?').bind(ready ? 1 : 0, tx.now, l.id));
    tx.touchList(l.list_id);
    if (l.job_id) tx.jobs.add(l.job_id);
  }
}

/**
 * Annullerer resten af en linje. For en vare til et job falder jobbets behov med samme mængde,
 * så systemet ikke straks lægger den på listen igen.
 */
export function cancelLine(tx: Tx, line: PurchaseLineRow): void {
  if (line.cancelled) return;
  const rest = outstanding(line);
  tx.add(tx.db.prepare('UPDATE purchase_lines SET cancelled = 1, updated_at = ? WHERE id = ?').bind(tx.now, line.id));
  if (line.job_id && line.product_id && rest > 0) {
    tx.add(
      tx.db
        .prepare(
          `UPDATE job_materials SET planned = MAX(planned - ?1, issued - returned + site_used), updated_at = ?2 WHERE job_id = ?3 AND product_id = ?4`,
        )
        .bind(rest, tx.now, line.job_id, line.product_id),
    );
  }
  tx.move({ product_id: line.product_id, job_id: line.job_id, purchase_line_id: line.id, kind: 'annulleret', qty: rest, reason: line.name });
  tx.touchList(line.list_id);
}

/** Registrerer bestilling hos leverandøren (samlet bestilt mængde på linjen). */
export function registerOrder(
  tx: Tx,
  line: PurchaseLineRow,
  orderedTotal: number,
  expected: string,
  ref: string,
  unitPrice: number | null,
): void {
  if (line.cancelled) throw new Conflict('Linjen er annulleret.');
  if (orderedTotal < line.received) throw new Conflict(`Der er allerede modtaget ${formatQty(line.received)} ${line.unit}.`);
  if (orderedTotal === line.ordered && expected === line.expected_date && ref === line.order_ref) return;
  tx.add(
    tx.db
      .prepare(
        `UPDATE purchase_lines SET ordered = ?1, qty = MAX(qty, ?1), expected_date = ?2, order_ref = ?3, unit_price = COALESCE(?4, unit_price),
           auto = 0, updated_at = ?5 WHERE id = ?6`,
      )
      .bind(orderedTotal, expected, ref, unitPrice, tx.now, line.id),
  );
  if (orderedTotal !== line.ordered) {
    tx.move({
      product_id: line.product_id,
      job_id: line.job_id,
      purchase_line_id: line.id,
      kind: 'bestilt',
      qty: orderedTotal - line.ordered,
      reason: [line.name, ref && `ordre ${ref}`, expected && `forventet ${expected}`].filter(Boolean).join(' · '),
    });
  }
  tx.touchList(line.list_id);
}

/**
 * Varemodtagelse på en indkøbslinje (også delvis). Varer til hovedlageret lægges på den fysiske
 * beholdning; er de købt til et job, reserveres de samtidig til jobbet, så de ikke fremstår som
 * disponible for andre job. Varer leveret direkte til arbejdsstedet knyttes til jobbet uden at
 * øge hovedlageret, og de tæller først som forbrug, når de registreres som brugt.
 */
export function receiveLine(tx: Tx, line: PurchaseLineRow, q: number, actualPrice: number | null, whole: boolean): void {
  if (line.cancelled) throw new Conflict('Linjen er annulleret.');
  if (whole && q % 1000 !== 0) throw new Conflict(`${line.name} håndteres kun i hele ${line.unit}.`);
  const rest = line.ordered - line.received;
  if (q <= 0) throw new Conflict('Angiv den modtagne mængde.');
  if (q > rest) {
    throw new Conflict(
      rest > 0
        ? `Der mangler kun ${formatQty(rest)} ${line.unit} at blive modtaget på bestillingen. Ret den bestilte mængde, hvis der er kommet mere.`
        : 'Registrér bestillingen, før varerne modtages.',
    );
  }
  tx.add(
    tx.db
      .prepare('UPDATE purchase_lines SET received = received + ?, actual_price = COALESCE(?, actual_price), updated_at = ? WHERE id = ?')
      .bind(q, actualPrice, tx.now, line.id),
  );
  const price = actualPrice ?? line.actual_price ?? line.unit_price;
  const pid = line.product_id;
  if (pid && line.deliver_to === 'lager') {
    const reserve = line.job_id ? q : 0;
    tx.add(
      tx.db
        .prepare(`UPDATE products SET stock = stock + ?1, reserved = reserved + CASE WHEN EXISTS (SELECT 1 FROM jobs WHERE id = ?2 AND status = 'aktiv') THEN ?1 ELSE 0 END, updated_at = ?3 WHERE id = ?4`)
        .bind(q, line.job_id, tx.now, pid),
    );
    if (line.job_id) {
      tx.add(
        tx.db
          .prepare(
            `INSERT INTO job_materials (job_id, product_id, planned, reserved, updated_at)
             SELECT ?1, ?2, ?3, ?3, ?4 FROM jobs WHERE id = ?1 AND status = 'aktiv'
             ON CONFLICT(job_id, product_id) DO UPDATE SET reserved = reserved + ?3, planned = MAX(planned, issued - returned + reserved + ?3 + site_received - site_returned), updated_at = ?4`,
          )
          .bind(line.job_id, pid, q, tx.now),
      );
    }
    tx.move({
      product_id: pid,
      job_id: line.job_id,
      purchase_line_id: line.id,
      kind: 'modtaget',
      qty: q,
      stock_delta: q,
      reserved_delta: reserve,
      reserve_if_active: !!line.job_id,
      unit_cost: price,
      reason: line.job_id ? 'Varemodtagelse til job' : 'Lageropfyldning',
    });
  } else if (pid && line.job_id) {
    tx.add(
      tx.db
        .prepare(
          `INSERT INTO job_materials (job_id, product_id, planned, site_received, updated_at) VALUES (?1, ?2, ?3, ?3, ?4)
           ON CONFLICT(job_id, product_id) DO UPDATE SET site_received = site_received + ?3, planned = MAX(planned, issued - returned + reserved + site_received + ?3 - site_returned), updated_at = ?4`,
        )
        .bind(line.job_id, pid, q, tx.now),
    );
    tx.move({ product_id: pid, job_id: line.job_id, purchase_line_id: line.id, kind: 'arbejdssted_modtaget', qty: q, unit_cost: price, reason: 'Leveret direkte til arbejdsstedet' });
  } else {
    // Vare uden varenummer: følges kun på indkøbslinjen (og på jobbets fakturagrundlag)
    tx.move({ job_id: line.job_id, purchase_line_id: line.id, kind: 'modtaget', qty: q, unit_cost: price, reason: line.name });
  }
  tx.touchList(line.list_id);
  if (line.job_id) tx.jobs.add(line.job_id);
}

export function jobLabel(job: Pick<JobRow, 'number' | 'name'> | null): string {
  return job ? `${job.number} ${job.name}` : 'Lageropfyldning';
}
