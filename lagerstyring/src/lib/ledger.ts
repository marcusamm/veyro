// Fælles motor for alle registreringer: hver registrering samles i én databasebatch, som enten
// gennemføres helt eller slet ikke. Batchen indledes med formularens engangsnøgle, så samme
// registrering aldrig kan trække varer to gange (dobbeltklik, genindlæsning eller tilbage-knap).
// Databasens CHECK-regler sørger for, at to samtidige registreringer ikke kan disponere over de
// samme varer: den, der kommer sidst, afvises, hvis der ikke længere er nok.

import { nowSec } from './crypto';

export interface Actor {
  email: string;
  name: string;
}

/** Registreringen ville bryde lagerreglerne (fx mere end der er disponibelt). */
export class Conflict extends Error {}
/** Lageret blev ændret af en anden registrering imens; kan prøves igen med friske tal. */
export class RaceConflict extends Conflict {}
/** Formularen er allerede gennemført (samme engangsnøgle). */
export class Duplicate extends Error {}

export interface MoveInput {
  product_id?: number | null;
  job_id?: number | null;
  purchase_line_id?: number | null;
  kind: string;
  qty: number;
  stock_delta?: number;
  reserved_delta?: number;
  unit_cost?: number | null;
  reason?: string;
  /** Sæt til et tal for at gemme beholdningen efter bevægelsen direkte (ellers læses den fra varen) */
  stock_after?: number;
}

export const MOVE_LABEL: Record<string, string> = {
  oprettet: 'Vare oprettet',
  modtagelse: 'Varemodtagelse',
  optaelling: 'Optælling',
  svind: 'Svind',
  leverandorretur: 'Returneret til leverandør',
  forbrug: 'Direkte forbrug',
  planlagt: 'Planlagt og reserveret',
  behov: 'Behov ændret',
  udlevering: 'Udleveret fra reservation',
  frigivelse: 'Reservation frigivet',
  retur: 'Returneret til lager',
  arbejdssted_modtaget: 'Modtaget på arbejdsstedet',
  arbejdssted_forbrug: 'Brugt fra arbejdsstedet',
  arbejdssted_retur: 'Flyttet fra arbejdssted til lager',
  bestilt: 'Bestilt hos leverandør',
  modtaget: 'Modtaget fra indkøb',
  annulleret: 'Indkøb annulleret',
  job_afsluttet: 'Job afsluttet, reservation frigivet',
};

export class Tx {
  readonly stmts: D1PreparedStatement[] = [];
  readonly products = new Set<number>();
  readonly jobs = new Set<number>();
  readonly lists = new Set<number>();

  constructor(
    readonly db: D1Database,
    readonly actor: Actor,
    readonly op: string | null = null,
    readonly now = nowSec(),
  ) {}

  add(...s: D1PreparedStatement[]): this {
    this.stmts.push(...s);
    return this;
  }

  /** Lagerbevægelse til historikken. Beholdning og reservationer efter læses fra varen. */
  move(m: MoveInput): this {
    const pid = m.product_id ?? null;
    if (pid) this.products.add(pid);
    if (m.job_id) this.jobs.add(m.job_id);
    this.stmts.push(
      this.db
        .prepare(
          `INSERT INTO movements (product_id, job_id, purchase_line_id, kind, qty, stock_delta, reserved_delta, stock_after, reserved_after, unit_cost, reason, actor, actor_name, op, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7,
             COALESCE(?8, (SELECT stock FROM products WHERE id = ?1)), (SELECT reserved FROM products WHERE id = ?1),
             ?9, ?10, ?11, ?12, ?13, ?14)`,
        )
        .bind(
          pid,
          m.job_id ?? null,
          m.purchase_line_id ?? null,
          m.kind,
          m.qty,
          m.stock_delta ?? 0,
          m.reserved_delta ?? 0,
          m.stock_after ?? null,
          m.unit_cost ?? null,
          m.reason ?? '',
          this.actor.email,
          this.actor.name,
          this.op,
          this.now,
        ),
    );
    return this;
  }

  /** Markerer en indkøbsliste som ændret (versionen vises ved afsendelse). */
  touchList(listId: number): this {
    if (!this.lists.has(listId)) {
      this.lists.add(listId);
      this.stmts.push(this.db.prepare('UPDATE purchase_lists SET version = version + 1, updated_at = ? WHERE id = ?').bind(this.now, listId));
    }
    return this;
  }

  async commit(kind = 'registrering'): Promise<void> {
    if (!this.stmts.length) return;
    const all = this.op
      ? [this.db.prepare('INSERT INTO ops (token, kind, actor, created_at) VALUES (?, ?, ?, ?)').bind(this.op, kind, this.actor.email, this.now), ...this.stmts]
      : this.stmts;
    try {
      await this.db.batch(all);
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (msg.includes('ops.token')) throw new Duplicate('Registreringen er allerede gennemført.');
      if (msg.includes('CHECK constraint failed') || msg.includes('UNIQUE constraint failed')) {
        throw new RaceConflict('Lageret er ændret imens. Der er ikke længere nok varer til registreringen.');
      }
      throw err;
    }
  }
}

/** Gyldig engangsnøgle fra en formular (ellers null). */
export function opToken(raw: unknown): string | null {
  return typeof raw === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(raw) ? raw : null;
}
