// Værkstedets data og API. Alt ligger i én Durable Object med SQLite, så hver booking
// kontrolleres og gemmes i ét hug: to kunder kan ikke få den samme tid.
import { DurableObject } from 'cloudflare:workers';
import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { ledigeTider, ledighedForPeriode, type OptagetTid } from '../shared/ledighed';
import { STANDARD_AABNINGSTIDER, STANDARD_REGLER, STANDARD_YDELSER } from '../shared/standard';
import { dageMellem, erDato, kbhTid, kbhTilUtc, klok, plusDage, datoLang } from '../shared/tid';
import {
  AKTIVE_STATUSSER,
  STATUS_TEKST,
  type Aabningstider,
  type Blokering,
  type Booking,
  type BookingRegler,
  type BookingStatus,
  type Interval,
  type Lukkeperiode,
  type Ydelse,
} from '../shared/typer';
import { EMAIL_RE, normalTelefon, rens, validerKunde, type Kundeoplysninger } from '../shared/validering';
import { URTYPER } from '../shared/virksomhed';
import * as mails from './email';
import { billedType, hashAdgangskode, nyId, nyRef, sha256, tilfaeldigToken, tjekAdgangskode } from './sikkerhed';

export interface Env {
  VAERKSTED: DurableObjectNamespace<Vaerksted>;
  ASSETS: Fetcher;
  DEMO_MODE?: string;
  APP_URL?: string;
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD_HASH?: string;
  NOTIFY_EMAIL?: string;
  EMAIL_FROM?: string;
  RESEND_API_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
}

type Raekke = Record<string, SqlStorageValue>;
type Bruger = { id: string; email: string; navn: string };
type HonoEnv = { Bindings: Env; Variables: { bruger: Bruger } };

const SESSION_COOKIE = 'um_s';
const SESSION_TIMER = 24 * 14;
const BILLEDE_MAX = 2 * 1024 * 1024;

class Fejl extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 413 | 429,
    besked: string,
    public felter?: Record<string, string>,
  ) {
    super(besked);
  }
}

function nuIso(): string {
  return new Date().toISOString();
}

export class Vaerksted extends DurableObject<Env> {
  private sql: SqlStorage;
  private app: Hono<HonoEnv>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.migrer();
      await this.seed();
      if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(this.naesteOprydning());
    });
    this.app = this.byggApi();
  }

  override async fetch(req: Request): Promise<Response> {
    return this.app.fetch(req, this.env);
  }

  // ---------- Database ----------

  private q<T = Raekke>(sql: string, ...args: SqlStorageValue[]): T[] {
    return this.sql.exec(sql, ...args).toArray() as T[];
  }

  private en<T = Raekke>(sql: string, ...args: SqlStorageValue[]): T | undefined {
    return this.q<T>(sql, ...args)[0];
  }

  private migrer(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (noegle TEXT PRIMARY KEY, vaerdi TEXT NOT NULL)`);
    const version = Number(this.en<{ vaerdi: string }>(`SELECT vaerdi FROM meta WHERE noegle = 'version'`)?.vaerdi ?? 0);
    if (version < 1) {
      this.sql.exec(`
        CREATE TABLE indstillinger (noegle TEXT PRIMARY KEY, vaerdi TEXT NOT NULL);
        CREATE TABLE ydelser (id TEXT PRIMARY KEY, navn TEXT NOT NULL, beskrivelse TEXT NOT NULL, varighed INTEGER NOT NULL,
          buffer INTEGER NOT NULL, aktiv INTEGER NOT NULL, sortering INTEGER NOT NULL);
        CREATE TABLE lukkeperioder (id TEXT PRIMARY KEY, fra TEXT NOT NULL, til TEXT NOT NULL, note TEXT NOT NULL);
        CREATE TABLE blokeringer (id TEXT PRIMARY KEY, dato TEXT NOT NULL, fra INTEGER NOT NULL, til INTEGER NOT NULL, note TEXT NOT NULL);
        CREATE INDEX blokeringer_dato ON blokeringer (dato);
        CREATE TABLE bookinger (id TEXT PRIMARY KEY, ref TEXT NOT NULL UNIQUE, token TEXT NOT NULL UNIQUE,
          ydelse_id TEXT NOT NULL, ydelse_navn TEXT NOT NULL, dato TEXT NOT NULL, start INTEGER NOT NULL, slut INTEGER NOT NULL,
          buffer INTEGER NOT NULL, status TEXT NOT NULL, navn TEXT NOT NULL, telefon TEXT NOT NULL, email TEXT NOT NULL,
          urtype TEXT NOT NULL, maerke TEXT NOT NULL, beskrivelse TEXT NOT NULL, har_billede INTEGER NOT NULL DEFAULT 0,
          kilde TEXT NOT NULL, samtykke TEXT, oprettet TEXT NOT NULL, opdateret TEXT NOT NULL, anonymiseret INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX bookinger_dato ON bookinger (dato, status);
        CREATE INDEX bookinger_email ON bookinger (email);
        CREATE TABLE noter (id TEXT PRIMARY KEY, booking_id TEXT NOT NULL, tekst TEXT NOT NULL, oprettet TEXT NOT NULL);
        CREATE INDEX noter_booking ON noter (booking_id);
        CREATE TABLE historik (id INTEGER PRIMARY KEY AUTOINCREMENT, booking_id TEXT NOT NULL, handling TEXT NOT NULL, tekst TEXT NOT NULL, tid TEXT NOT NULL);
        CREATE INDEX historik_booking ON historik (booking_id);
        CREATE TABLE billeder (booking_id TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL);
        CREATE TABLE beskeder (id TEXT PRIMARY KEY, navn TEXT NOT NULL, email TEXT NOT NULL, telefon TEXT NOT NULL, besked TEXT NOT NULL,
          oprettet TEXT NOT NULL, laest INTEGER NOT NULL DEFAULT 0, kilde TEXT NOT NULL DEFAULT 'kunde');
        CREATE TABLE udbakke (id INTEGER PRIMARY KEY AUTOINCREMENT, booking_id TEXT, til TEXT NOT NULL, emne TEXT NOT NULL, tekst TEXT NOT NULL,
          status TEXT NOT NULL, oprettet TEXT NOT NULL);
        CREATE TABLE brugere (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, navn TEXT NOT NULL, hash TEXT NOT NULL, oprettet TEXT NOT NULL);
        CREATE TABLE sessioner (hash TEXT PRIMARY KEY, bruger_id TEXT NOT NULL, udloeber INTEGER NOT NULL);
        CREATE TABLE begraensning (noegle TEXT PRIMARY KEY, antal INTEGER NOT NULL, start INTEGER NOT NULL);
      `);
      this.sql.exec(`INSERT OR REPLACE INTO meta VALUES ('version', '1')`);
    }
  }

  private get demo(): boolean {
    return this.env.DEMO_MODE === '1';
  }

  private async seed(): Promise<void> {
    if (!this.en(`SELECT 1 FROM meta WHERE noegle = 'seedet'`)) {
      this.ctx.storage.transactionSync(() => {
        this.gemIndstilling('aabningstider', STANDARD_AABNINGSTIDER);
        this.gemIndstilling('regler', STANDARD_REGLER);
        for (const y of STANDARD_YDELSER) this.gemYdelse(y);
        if (this.demo) this.lavDemodata();
        this.sql.exec(`INSERT INTO meta VALUES ('seedet', ?)`, nuIso());
      });
    }
    // Første administrator fra indstillingerne (kun hvis der ingen brugere er)
    const { ADMIN_EMAIL, ADMIN_PASSWORD_HASH } = this.env;
    if (ADMIN_EMAIL && ADMIN_PASSWORD_HASH && !this.en(`SELECT 1 FROM brugere`)) {
      this.sql.exec(`INSERT INTO brugere VALUES (?, ?, ?, ?, ?)`, nyId(), ADMIN_EMAIL.toLowerCase(), 'Mette', ADMIN_PASSWORD_HASH, nuIso());
    }
  }

  /** Testbookinger fordelt på de kommende dage. Alle er markeret som demo. */
  private lavDemodata(): void {
    const nu = kbhTid();
    const kunder = [
      { navn: 'Lise Demo', urtype: 'Bornholmerur', ydelse: 'bornholmerur', maerke: 'Ukendt, ca. 1850', beskrivelse: 'Uret er stoppet og slår ikke længere hele timer.' },
      { navn: 'Henrik Demo', urtype: 'Armbåndsur', ydelse: 'armbaandsur', maerke: 'Automatisk dykkerur', beskrivelse: 'Uret går for hurtigt, ca. 2 minutter om dagen.' },
      { navn: 'Birgit Demo', urtype: 'Lommeur', ydelse: 'lommeur', maerke: 'Arvestykke efter morfar', beskrivelse: 'Glasset er revnet, og uret skal trækkes op flere gange om dagen.' },
      { navn: 'Peter Demo', urtype: 'Stueur', ydelse: 'stueur', maerke: 'Standur', beskrivelse: 'Pendulet stopper efter et par timer.' },
      { navn: 'Karen Demo', urtype: 'Taffelur', ydelse: 'taffelur', maerke: 'Fransk taffelur', beskrivelse: 'Uret mangler nøgle og har ikke gået i flere år. Ønsker en vurdering.' },
      { navn: 'Ole Demo', urtype: 'Vintageur', ydelse: 'vintageur', maerke: 'Håndoptrukket fra 1960erne', beskrivelse: 'Uret stopper, når det ligger stille om natten.' },
      { navn: 'Maja Demo', urtype: 'Armbåndsur', ydelse: 'armbaandsur', maerke: '', beskrivelse: 'Kronen er løs, og uret kan ikke stilles.' },
      { navn: 'Jens Demo', urtype: 'Andet', ydelse: 'andet', maerke: 'Køkkenur', beskrivelse: 'Vil gerne høre, om det kan betale sig at reparere.' },
    ];
    const statusser: BookingStatus[] = ['anmodet', 'bekraeftet', 'anmodet', 'bekraeftet', 'bekraeftet', 'anmodet', 'bekraeftet', 'anmodet'];
    const regler = this.regler();
    const aab = this.aabningstider();
    let dag = 1;
    kunder.forEach((k, i) => {
      const y = STANDARD_YDELSER.find((x) => x.id === k.ydelse)!;
      for (let forsoeg = 0; forsoeg < 14; forsoeg++, dag++) {
        const dato = plusDage(nu.dato, dag);
        const tider = ledigeTider({
          dato, varighed: y.varighed, buffer: y.buffer, regler, aabningstider: aab, lukkeperioder: [], blokeringer: [],
          optaget: this.optaget(dato, dato), tidligst: nu, senesteDato: plusDage(nu.dato, 90),
        });
        if (tider.length) {
          const start = tider[(i * 3) % tider.length]!;
          this.indsaetBooking({ ydelse: y, dato, start, status: statusser[i]!, kilde: 'demo', samtykke: null, kunde: {
            navn: k.navn, telefon: `+45 00 00 00 ${String(10 + i)}`, email: `${k.navn.split(' ')[0]!.toLowerCase()}.demo@example.com`,
            urtype: k.urtype, maerke: k.maerke, beskrivelse: k.beskrivelse } });
          if (i % 2 === 1) dag++;
          break;
        }
      }
    });
    // Tidligere, gennemførte aftaler
    const tidligere = [
      { navn: 'Anna Demo', ydelse: 'armbaandsur', urtype: 'Armbåndsur', dage: -6, start: 11 * 60, status: 'gennemfoert' as const, beskrivelse: 'Batteriskift og kontrol af tætning.' },
      { navn: 'Erik Demo', ydelse: 'bornholmerur', urtype: 'Bornholmerur', dage: -12, start: 14 * 60, status: 'gennemfoert' as const, beskrivelse: 'Uret går langsomt.' },
      { navn: 'Sofie Demo', ydelse: 'lommeur', urtype: 'Lommeur', dage: -3, start: 10 * 60 + 30, status: 'aflyst' as const, beskrivelse: 'Visere sidder løst.' },
    ];
    for (const t of tidligere) {
      const y = STANDARD_YDELSER.find((x) => x.id === t.ydelse)!;
      const id = this.indsaetBooking({ ydelse: y, dato: plusDage(nu.dato, t.dage), start: t.start, status: t.status, kilde: 'demo', samtykke: null, kunde: {
        navn: t.navn, telefon: '+45 00 00 00 01', email: `${t.navn.split(' ')[0]!.toLowerCase()}.demo@example.com`, urtype: t.urtype, maerke: '', beskrivelse: t.beskrivelse } });
      if (t.status === 'gennemfoert') this.sql.exec(`INSERT INTO noter VALUES (?, ?, ?, ?)`, nyId(), id, 'Demo-note: Uret er afhentet.', nuIso());
    }
    // En ferieperiode og en blokeret tid som eksempel
    const ferie = plusDage(nu.dato, 35);
    this.sql.exec(`INSERT INTO lukkeperioder VALUES (?, ?, ?, ?)`, nyId(), ferie, plusDage(ferie, 6), 'Ferie (demo)');
    this.sql.exec(`INSERT INTO blokeringer VALUES (?, ?, ?, ?, ?)`, nyId(), plusDage(nu.dato, 2), 12 * 60, 13 * 60, 'Frokost / ærinde (demo)');
    this.sql.exec(
      `INSERT INTO beskeder VALUES (?, ?, ?, ?, ?, ?, 0, 'demo')`,
      nyId(), 'Hanne Demo', 'hanne.demo@example.com', '', 'Hej. Reparerer I også gøgeure? Mvh. Hanne (demobesked)', nuIso(),
    );
  }

  private nulstilDemo(): void {
    this.ctx.storage.transactionSync(() => {
      for (const t of ['bookinger', 'noter', 'historik', 'billeder', 'beskeder', 'udbakke', 'lukkeperioder', 'blokeringer', 'ydelser', 'indstillinger']) this.sql.exec(`DELETE FROM ${t}`);
      this.gemIndstilling('aabningstider', STANDARD_AABNINGSTIDER);
      this.gemIndstilling('regler', STANDARD_REGLER);
      for (const y of STANDARD_YDELSER) this.gemYdelse(y);
      this.lavDemodata();
    });
  }

  // ---------- Indstillinger ----------

  private indstilling<T>(noegle: string, standard: T): T {
    const r = this.en<{ vaerdi: string }>(`SELECT vaerdi FROM indstillinger WHERE noegle = ?`, noegle);
    return r ? (JSON.parse(r.vaerdi) as T) : standard;
  }

  private gemIndstilling(noegle: string, v: unknown): void {
    this.sql.exec(`INSERT OR REPLACE INTO indstillinger VALUES (?, ?)`, noegle, JSON.stringify(v));
  }

  private regler(): BookingRegler {
    return { ...STANDARD_REGLER, ...this.indstilling<Partial<BookingRegler>>('regler', {}) };
  }

  private aabningstider(): Aabningstider {
    return this.indstilling<Aabningstider>('aabningstider', STANDARD_AABNINGSTIDER);
  }

  private ydelser(kunAktive = false): Ydelse[] {
    return this.q(`SELECT * FROM ydelser ${kunAktive ? 'WHERE aktiv = 1' : ''} ORDER BY sortering, navn`).map((r) => ({
      id: String(r.id), navn: String(r.navn), beskrivelse: String(r.beskrivelse), varighed: Number(r.varighed),
      buffer: Number(r.buffer), aktiv: r.aktiv === 1, sortering: Number(r.sortering),
    }));
  }

  private gemYdelse(y: Ydelse): void {
    this.sql.exec(`INSERT OR REPLACE INTO ydelser VALUES (?, ?, ?, ?, ?, ?, ?)`, y.id, y.navn, y.beskrivelse, y.varighed, y.buffer, y.aktiv ? 1 : 0, y.sortering);
  }

  private lukkeperioder(): Lukkeperiode[] {
    return this.q(`SELECT * FROM lukkeperioder ORDER BY fra`).map((r) => ({ id: String(r.id), fra: String(r.fra), til: String(r.til), note: String(r.note) }));
  }

  private blokeringer(fra: string, til: string): Blokering[] {
    return this.q(`SELECT * FROM blokeringer WHERE dato BETWEEN ? AND ? ORDER BY dato, fra`, fra, til).map((r) => ({
      id: String(r.id), dato: String(r.dato), fra: Number(r.fra), til: Number(r.til), note: String(r.note),
    }));
  }

  private optaget(fra: string, til: string): OptagetTid[] {
    return this.q(
      `SELECT id, dato, start, slut, buffer FROM bookinger WHERE dato BETWEEN ? AND ? AND status IN ('anmodet', 'bekraeftet')`,
      fra, til,
    ).map((r) => ({ id: String(r.id), dato: String(r.dato), start: Number(r.start), slut: Number(r.slut), buffer: Number(r.buffer) }));
  }

  /** Ledige tider. For kunder gælder minimumsvarsel og hvor langt frem, der kan bookes. */
  private ledighed(ydelse: Ydelse, fra: string, dage: number, opts: { admin?: boolean; ignorerId?: string } = {}): Record<string, number[]> {
    const regler = this.regler();
    const nu = new Date();
    const idag = kbhTid(nu).dato;
    const tidligst = opts.admin ? kbhTid(nu) : kbhTid(new Date(nu.getTime() + regler.minVarselTimer * 3600_000));
    const til = plusDage(fra, dage - 1);
    return ledighedForPeriode(
      {
        varighed: ydelse.varighed, buffer: ydelse.buffer, regler, aabningstider: this.aabningstider(), lukkeperioder: this.lukkeperioder(),
        blokeringer: this.blokeringer(fra, til), optaget: this.optaget(fra, til), tidligst,
        senesteDato: plusDage(idag, opts.admin ? 365 : regler.maxDageFrem), ignorerId: opts.ignorerId,
      },
      fra, dage,
    );
  }

  // ---------- Bookinger ----------

  private tilBooking(r: Raekke): Booking & { token: string } {
    return {
      id: String(r.id), ref: String(r.ref), token: String(r.token), ydelseId: String(r.ydelse_id), ydelseNavn: String(r.ydelse_navn),
      dato: String(r.dato), start: Number(r.start), slut: Number(r.slut), buffer: Number(r.buffer), status: r.status as BookingStatus,
      navn: String(r.navn), telefon: String(r.telefon), email: String(r.email), urtype: String(r.urtype), maerke: String(r.maerke),
      beskrivelse: String(r.beskrivelse), harBillede: r.har_billede === 1, kilde: r.kilde as Booking['kilde'], oprettet: String(r.oprettet),
      opdateret: String(r.opdateret), anonymiseret: r.anonymiseret === 1,
    };
  }

  private hentBooking(id: string): (Booking & { token: string }) | undefined {
    const r = this.en(`SELECT * FROM bookinger WHERE id = ?`, id);
    return r ? this.tilBooking(r) : undefined;
  }

  private log(bookingId: string, handling: string, tekst = ''): void {
    this.sql.exec(`INSERT INTO historik (booking_id, handling, tekst, tid) VALUES (?, ?, ?, ?)`, bookingId, handling, tekst, nuIso());
  }

  private indsaetBooking(b: {
    ydelse: Ydelse; dato: string; start: number; status: BookingStatus; kilde: Booking['kilde']; samtykke: string | null; kunde: Kundeoplysninger;
  }): string {
    const id = nyId();
    let ref = nyRef();
    while (this.en(`SELECT 1 FROM bookinger WHERE ref = ?`, ref)) ref = nyRef();
    const nu = nuIso();
    this.sql.exec(
      `INSERT INTO bookinger (id, ref, token, ydelse_id, ydelse_navn, dato, start, slut, buffer, status, navn, telefon, email, urtype, maerke,
        beskrivelse, har_billede, kilde, samtykke, oprettet, opdateret) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      id, ref, tilfaeldigToken(), b.ydelse.id, b.ydelse.navn, b.dato, b.start, b.start + b.ydelse.varighed, b.ydelse.buffer, b.status,
      b.kunde.navn, b.kunde.telefon, b.kunde.email.toLowerCase(), b.kunde.urtype, b.kunde.maerke, b.kunde.beskrivelse, b.kilde, b.samtykke, nu, nu,
    );
    const hvem = b.kilde === 'kunde' ? 'Kunden' : b.kilde === 'admin' ? 'Værkstedet' : 'Demodata';
    this.log(id, 'oprettet', `${hvem} oprettede ${b.status === 'anmodet' ? 'anmodningen' : 'aftalen'} (${STATUS_TEKST[b.status].toLowerCase()})`);
    return id;
  }

  private link(token: string): string {
    return `${(this.env.APP_URL || '').replace(/\/$/, '')}/booking/${token}`;
  }

  private async mail(bookingId: string | null, m: mails.Mail): Promise<void> {
    const status = await mails.sendMail(this.env, m);
    this.sql.exec(`INSERT INTO udbakke (booking_id, til, emne, tekst, status, oprettet) VALUES (?, ?, ?, ?, ?, ?)`, bookingId, m.til, m.emne, m.tekst, status, nuIso());
  }

  private kundeFraInput(f: Record<string, unknown>): Kundeoplysninger {
    return {
      navn: rens(f.navn, 100), telefon: rens(f.telefon, 30), email: rens(f.email, 200).toLowerCase(),
      urtype: rens(f.urtype, 40), maerke: rens(f.maerke, 120), beskrivelse: rens(f.beskrivelse, 2000),
    };
  }

  /** Simpel begrænsning af antal forsøg pr. nøgle (fx IP) inden for et tidsvindue. */
  private begraens(noegle: string, max: number, vinduesSek: number): void {
    const nu = Math.floor(Date.now() / 1000);
    const r = this.en<{ antal: number; start: number }>(`SELECT antal, start FROM begraensning WHERE noegle = ?`, noegle);
    if (!r || nu - r.start > vinduesSek) {
      this.sql.exec(`INSERT OR REPLACE INTO begraensning VALUES (?, 1, ?)`, noegle, nu);
      return;
    }
    if (r.antal >= max) throw new Fejl(429, 'Der har været for mange forsøg. Prøv igen lidt senere, eller ring til os.');
    this.sql.exec(`UPDATE begraensning SET antal = antal + 1 WHERE noegle = ?`, noegle);
  }

  private async tjekTurnstile(token: unknown, ip: string): Promise<void> {
    if (!this.env.TURNSTILE_SECRET) return;
    const body = new FormData();
    body.set('secret', this.env.TURNSTILE_SECRET);
    body.set('response', typeof token === 'string' ? token : '');
    body.set('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    const data = (await res.json()) as { success?: boolean };
    if (!data.success) throw new Fejl(400, 'Spamkontrollen fejlede. Genindlæs siden og prøv igen.');
  }

  /** Honeypot-felt og tid brugt på formularen. Robotter udfylder skjulte felter og er hurtige. */
  private tjekSpam(f: Record<string, unknown>): void {
    if (rens(f.firma, 200)) throw new Fejl(400, 'Anmodningen kunne ikke modtages.');
    const startet = Number(f.startet);
    if (!Number.isFinite(startet) || Date.now() - startet < 3000) throw new Fejl(400, 'Anmodningen kunne ikke modtages. Prøv igen.');
  }

  // ---------- Oprydning (dagligt) ----------

  private naesteOprydning(): number {
    const imorgen = plusDage(kbhTid().dato, 1);
    return kbhTilUtc(imorgen, 3 * 60).getTime();
  }

  override async alarm(): Promise<void> {
    this.oprydning();
    await this.ctx.storage.setAlarm(this.naesteOprydning());
  }

  private oprydning(): void {
    const nu = Date.now();
    this.sql.exec(`DELETE FROM sessioner WHERE udloeber < ?`, Math.floor(nu / 1000));
    this.sql.exec(`DELETE FROM begraensning WHERE start < ?`, Math.floor(nu / 1000) - 86400);
    const idag = kbhTid().dato;
    // Aftaler, der er passeret uden at blive lukket, får ikke ny status automatisk; de står under "Tidligere".
    // Persondata slettes, når opbevaringsperioden er udløbet.
    const maaneder = this.regler().sletEfterMaaneder;
    if (maaneder > 0) {
      const graense = plusDage(idag, -Math.round(maaneder * 30.44));
      for (const r of this.q<{ id: string }>(`SELECT id FROM bookinger WHERE dato < ? AND anonymiseret = 0`, graense)) this.anonymiser(r.id, 'Automatisk sletning efter opbevaringsperioden');
      this.sql.exec(`DELETE FROM beskeder WHERE oprettet < ?`, new Date(nu - maaneder * 30.44 * 86400_000).toISOString());
    }
    this.sql.exec(`DELETE FROM udbakke WHERE oprettet < ?`, new Date(nu - 90 * 86400_000).toISOString());
    if (this.demo) {
      // Demo: oplysninger, som besøgende har tastet ind, slettes efter 14 dage
      const g = new Date(nu - 14 * 86400_000).toISOString();
      for (const r of this.q<{ id: string }>(`SELECT id FROM bookinger WHERE kilde = 'kunde' AND oprettet < ? AND anonymiseret = 0`, g)) this.anonymiser(r.id, 'Demo: automatisk sletning efter 14 dage');
      this.sql.exec(`DELETE FROM beskeder WHERE kilde = 'kunde' AND oprettet < ?`, g);
    }
  }

  private anonymiser(id: string, grund: string): void {
    this.sql.exec(
      `UPDATE bookinger SET navn = 'Slettet', telefon = '', email = '', maerke = '', beskrivelse = '', har_billede = 0, samtykke = NULL,
        anonymiseret = 1, opdateret = ?, status = CASE WHEN status IN ('anmodet', 'bekraeftet') THEN 'aflyst' ELSE status END WHERE id = ?`,
      nuIso(), id,
    );
    this.sql.exec(`DELETE FROM billeder WHERE booking_id = ?`, id);
    this.sql.exec(`DELETE FROM noter WHERE booking_id = ?`, id);
    this.sql.exec(`DELETE FROM udbakke WHERE booking_id = ?`, id);
    this.log(id, 'persondata slettet', grund);
  }

  // ---------- API ----------

  private byggApi(): Hono<HonoEnv> {
    const app = new Hono<HonoEnv>().basePath('/api');

    app.onError((err, c) => {
      if (err instanceof Fejl) return c.json({ fejl: err.message, felter: err.felter }, err.status);
      console.error('API-fejl', err instanceof Error ? err.message : err);
      return c.json({ fejl: 'Der opstod en uventet fejl. Prøv igen, eller ring til os.' }, 500);
    });

    app.use('*', async (c, next) => {
      await next();
      c.header('Cache-Control', 'no-store');
    });

    const ip = (c: Context<HonoEnv>) => c.req.header('cf-connecting-ip') || 'ukendt';
    const ydelseEllerFejl = (id: string | undefined) => {
      const y = this.ydelser().find((x) => x.id === id);
      if (!y) throw new Fejl(404, 'Ydelsen findes ikke.');
      return y;
    };

    // ----- Offentligt -----

    app.get('/offentlig', (c) => {
      const regler = this.regler();
      const idag = kbhTid().dato;
      return c.json({
        demo: this.demo,
        ydelser: this.ydelser(true),
        maxDageFrem: regler.maxDageFrem,
        idag,
        turnstileSiteKey: this.env.TURNSTILE_SECRET ? this.env.TURNSTILE_SITE_KEY || null : null,
        aabningstider: this.aabningstider(),
        lukkeperioder: this.lukkeperioder().filter((p) => p.til >= idag).map(({ fra, til }) => ({ fra, til })),
      });
    });

    app.get('/ledighed', (c) => {
      const y = ydelseEllerFejl(c.req.query('ydelse'));
      if (!y.aktiv) throw new Fejl(404, 'Ydelsen kan ikke bookes online.');
      const fra = c.req.query('fra') ?? '';
      const dage = Math.min(62, Math.max(1, Number(c.req.query('dage') ?? 31) || 31));
      if (!erDato(fra)) throw new Fejl(400, 'Ugyldig dato.');
      return c.json({ dage: this.ledighed(y, fra, dage) });
    });

    app.post('/bookinger', async (c) => {
      const form = await c.req.formData();
      const f = Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === 'string'));
      this.tjekSpam(f);
      this.begraens(`booking:${ip(c)}`, 8, 3600);
      await this.tjekTurnstile(f['cf-turnstile-response'], ip(c));

      const kunde = this.kundeFraInput(f);
      const felter = validerKunde(kunde);
      if (f.samtykke !== 'ja') felter.samtykke = 'Du skal acceptere, at vi gemmer dine oplysninger for at behandle din booking.';
      if (Object.keys(felter).length) throw new Fejl(400, 'Tjek de markerede felter.', felter);

      let billede: { mime: string; data: ArrayBuffer } | null = null;
      const fil = form.get('billede');
      if (fil && typeof fil !== 'string' && fil.size > 0) {
        if (fil.size > BILLEDE_MAX) throw new Fejl(413, 'Billedet er for stort (højst 2 MB).', { billede: 'Billedet er for stort (højst 2 MB).' });
        const data = await fil.arrayBuffer();
        const mime = billedType(new Uint8Array(data.slice(0, 16)));
        if (!mime) throw new Fejl(400, 'Billedet skal være JPG, PNG eller WebP.', { billede: 'Billedet skal være JPG, PNG eller WebP.' });
        billede = { mime, data };
      }

      const y = ydelseEllerFejl(String(f.ydelse ?? ''));
      const dato = String(f.dato ?? '');
      const start = Number(f.start);
      if (!y.aktiv || !erDato(dato) || !Number.isInteger(start)) throw new Fejl(400, 'Vælg en ydelse og en tid.');

      // Herfra og til indsættelsen er der ingen await: kontrol og gemning sker samlet.
      const id = this.ctx.storage.transactionSync(() => {
        const ledige = this.ledighed(y, dato, 1)[dato] ?? [];
        if (!ledige.includes(start)) throw new Fejl(409, 'Tiden er desværre lige blevet optaget. Vælg en anden tid.');
        const dublet = this.en(
          `SELECT 1 FROM bookinger WHERE (email = ? OR telefon = ?) AND dato = ? AND start = ? AND status IN ('anmodet', 'bekraeftet')`,
          kunde.email, kunde.telefon, dato, start,
        );
        if (dublet) throw new Fejl(409, 'Du har allerede en anmodning på dette tidspunkt.');
        const nyt = this.indsaetBooking({ ydelse: y, dato, start, status: 'anmodet', kilde: 'kunde', samtykke: nuIso(), kunde });
        if (billede) {
          this.sql.exec(`INSERT INTO billeder VALUES (?, ?, ?)`, nyt, billede.mime, billede.data);
          this.sql.exec(`UPDATE bookinger SET har_billede = 1 WHERE id = ?`, nyt);
        }
        return nyt;
      });
      const b = this.hentBooking(id)!;
      await this.mail(id, mails.mailAnmodningModtaget(b, this.link(b.token)));
      if (this.env.NOTIFY_EMAIL) await this.mail(id, mails.mailTilVaerksted(b, this.env.NOTIFY_EMAIL, `${this.env.APP_URL ?? ''}/admin`));
      return c.json({ ...this.kundeVisning(b), token: b.token, emailSendt: !this.demo && !!this.env.RESEND_API_KEY }, 201);
    });

    app.get('/booking/:token', (c) => {
      const r = this.en(`SELECT * FROM bookinger WHERE token = ?`, c.req.param('token'));
      if (!r) throw new Fejl(404, 'Bookingen blev ikke fundet.');
      return c.json(this.kundeVisning(this.tilBooking(r)));
    });

    app.post('/booking/:token/afbestil', async (c) => {
      this.begraens(`afbestil:${ip(c)}`, 20, 3600);
      const r = this.en(`SELECT * FROM bookinger WHERE token = ?`, c.req.param('token'));
      if (!r) throw new Fejl(404, 'Bookingen blev ikke fundet.');
      const b = this.tilBooking(r);
      if (!AKTIVE_STATUSSER.includes(b.status)) throw new Fejl(409, 'Tiden kan ikke afbestilles, fordi den ikke længere er aktiv.');
      const nu = kbhTid();
      if (b.dato < nu.dato || (b.dato === nu.dato && b.start <= nu.min)) throw new Fejl(409, 'Tiden er passeret og kan ikke afbestilles online.');
      this.sql.exec(`UPDATE bookinger SET status = 'aflyst', opdateret = ? WHERE id = ?`, nuIso(), b.id);
      this.log(b.id, 'aflyst', 'Kunden afbestilte via linket');
      const opd = this.hentBooking(b.id)!;
      await this.mail(b.id, mails.mailAflyst(opd, '', true));
      return c.json(this.kundeVisning(opd));
    });

    app.post('/kontakt', async (c) => {
      const f = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      this.tjekSpam(f);
      this.begraens(`kontakt:${ip(c)}`, 5, 3600);
      await this.tjekTurnstile(f['cf-turnstile-response'], ip(c));
      const navn = rens(f.navn, 100);
      const email = rens(f.email, 200).toLowerCase();
      const telefon = rens(f.telefon, 30);
      const besked = rens(f.besked, 3000);
      const felter: Record<string, string> = {};
      if (navn.length < 2) felter.navn = 'Skriv dit navn.';
      if (!EMAIL_RE.test(email)) felter.email = 'Skriv en gyldig e-mailadresse.';
      if (besked.length < 5) felter.besked = 'Skriv en besked.';
      if (f.samtykke !== 'ja') felter.samtykke = 'Du skal acceptere, at vi gemmer din besked for at kunne svare.';
      if (Object.keys(felter).length) throw new Fejl(400, 'Tjek de markerede felter.', felter);
      this.sql.exec(`INSERT INTO beskeder VALUES (?, ?, ?, ?, ?, ?, 0, 'kunde')`, nyId(), navn, email, telefon, besked, nuIso());
      if (this.env.NOTIFY_EMAIL) await this.mail(null, { til: this.env.NOTIFY_EMAIL, emne: `Ny besked fra ${navn}`, tekst: `${navn} (${email}${telefon ? `, ${telefon}` : ''}) skriver:\n\n${besked}` });
      return c.json({ ok: true, demo: this.demo });
    });

    // ----- Administration -----

    app.post('/admin/login', async (c) => {
      const f = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const email = rens(f.email, 200).toLowerCase();
      this.begraens(`login:${ip(c)}`, 10, 900);
      this.begraens(`login:${email}`, 10, 900);
      const r = this.en<{ id: string; hash: string }>(`SELECT id, hash FROM brugere WHERE email = ?`, email);
      const ok = r ? await tjekAdgangskode(String(f.adgangskode ?? ''), r.hash) : (await hashAdgangskode('x'), false);
      if (!ok || !r) throw new Fejl(401, 'Forkert e-mail eller adgangskode.');
      const token = tilfaeldigToken(32);
      this.sql.exec(`INSERT INTO sessioner VALUES (?, ?, ?)`, await sha256(token), r.id, Math.floor(Date.now() / 1000) + SESSION_TIMER * 3600);
      this.sql.exec(`DELETE FROM begraensning WHERE noegle = ?`, `login:${email}`);
      setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'Strict', path: '/', maxAge: SESSION_TIMER * 3600 });
      return c.json({ ok: true });
    });

    app.use('/admin/*', async (c, next) => {
      if (c.req.path === '/api/admin/login') return next();
      const token = getCookie(c, SESSION_COOKIE);
      const s = token ? this.en<Bruger>(
        `SELECT b.id, b.email, b.navn FROM sessioner s JOIN brugere b ON b.id = s.bruger_id WHERE s.hash = ? AND s.udloeber > ?`,
        await sha256(token), Math.floor(Date.now() / 1000),
      ) : undefined;
      if (!s) throw new Fejl(401, 'Du er ikke logget ind.');
      // Beskyttelse mod CSRF: ændringer kræver en header, som andre sider ikke kan sætte
      if (c.req.method !== 'GET' && c.req.header('x-um') !== '1') throw new Fejl(403, 'Ugyldig anmodning.');
      c.set('bruger', s);
      await next();
    });

    app.post('/admin/logout', async (c) => {
      const token = getCookie(c, SESSION_COOKIE);
      if (token) this.sql.exec(`DELETE FROM sessioner WHERE hash = ?`, await sha256(token));
      deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
      return c.json({ ok: true });
    });

    app.get('/admin/mig', (c) => c.json({ ...c.get('bruger'), demo: this.demo }));

    app.post('/admin/adgangskode', async (c) => {
      const f = (await c.req.json()) as Record<string, unknown>;
      const b = c.get('bruger');
      const r = this.en<{ hash: string }>(`SELECT hash FROM brugere WHERE id = ?`, b.id)!;
      if (!(await tjekAdgangskode(String(f.nuvaerende ?? ''), r.hash))) throw new Fejl(400, 'Den nuværende adgangskode er forkert.', { nuvaerende: 'Forkert adgangskode.' });
      const ny = String(f.ny ?? '');
      if (ny.length < 10) throw new Fejl(400, 'Den nye adgangskode skal være på mindst 10 tegn.', { ny: 'Mindst 10 tegn.' });
      this.sql.exec(`UPDATE brugere SET hash = ? WHERE id = ?`, await hashAdgangskode(ny), b.id);
      // Log ud overalt undtagen her
      const token = getCookie(c, SESSION_COOKIE) ?? '';
      this.sql.exec(`DELETE FROM sessioner WHERE bruger_id = ? AND hash != ?`, b.id, await sha256(token));
      return c.json({ ok: true });
    });

    app.get('/admin/oversigt', (c) => {
      const nu = kbhTid();
      const tal = (sql: string, ...a: SqlStorageValue[]) => Number(this.en<{ n: number }>(sql, ...a)?.n ?? 0);
      return c.json({
        idag: nu.dato,
        anmodninger: tal(`SELECT count(*) AS n FROM bookinger WHERE status = 'anmodet' AND dato >= ?`, nu.dato),
        iDag: tal(`SELECT count(*) AS n FROM bookinger WHERE status IN ('anmodet','bekraeftet') AND dato = ?`, nu.dato),
        kommende7: tal(`SELECT count(*) AS n FROM bookinger WHERE status IN ('anmodet','bekraeftet') AND dato BETWEEN ? AND ?`, nu.dato, plusDage(nu.dato, 6)),
        ulaesteBeskeder: tal(`SELECT count(*) AS n FROM beskeder WHERE laest = 0`),
        uafsluttede: tal(`SELECT count(*) AS n FROM bookinger WHERE status = 'bekraeftet' AND dato < ?`, nu.dato),
      });
    });

    app.get('/admin/bookinger', (c) => {
      const { fra, til, status, q, visning } = c.req.query();
      const idag = kbhTid().dato;
      const hvor: string[] = [];
      const args: SqlStorageValue[] = [];
      if (fra && erDato(fra)) { hvor.push('dato >= ?'); args.push(fra); }
      if (til && erDato(til)) { hvor.push('dato <= ?'); args.push(til); }
      if (visning === 'anmodninger') { hvor.push(`status = 'anmodet'`); }
      else if (visning === 'kommende') { hvor.push(`status IN ('anmodet','bekraeftet') AND dato >= ?`); args.push(idag); }
      else if (visning === 'tidligere') { hvor.push(`(dato < ? OR status NOT IN ('anmodet','bekraeftet'))`); args.push(idag); }
      if (status && status in STATUS_TEKST) { hvor.push('status = ?'); args.push(status); }
      if (q) {
        hvor.push(`(navn LIKE ? OR email LIKE ? OR telefon LIKE ? OR ref LIKE ? OR maerke LIKE ? OR beskrivelse LIKE ?)`);
        const m = `%${q.slice(0, 80)}%`;
        args.push(m, m, m, m, m, m);
      }
      const orden = visning === 'tidligere' ? 'dato DESC, start DESC' : 'dato, start';
      const rows = this.q(`SELECT * FROM bookinger ${hvor.length ? 'WHERE ' + hvor.join(' AND ') : ''} ORDER BY ${orden} LIMIT 500`, ...args);
      return c.json({ bookinger: rows.map((r) => this.adminVisning(this.tilBooking(r))) });
    });

    app.get('/admin/bookinger/:id', (c) => {
      const b = this.hentBooking(c.req.param('id'));
      if (!b) throw new Fejl(404, 'Bookingen findes ikke.');
      return c.json({
        booking: this.adminVisning(b),
        noter: this.q(`SELECT id, tekst, oprettet FROM noter WHERE booking_id = ? ORDER BY oprettet`, b.id),
        historik: this.q(`SELECT handling, tekst, tid FROM historik WHERE booking_id = ? ORDER BY id`, b.id),
        mails: this.q(`SELECT til, emne, status, oprettet FROM udbakke WHERE booking_id = ? ORDER BY id`, b.id),
        andre: b.email ? this.q(`SELECT id, ref, dato, start, status, ydelse_navn AS ydelseNavn FROM bookinger WHERE email = ? AND id != ? ORDER BY dato DESC LIMIT 20`, b.email, b.id) : [],
      });
    });

    app.get('/admin/bookinger/:id/billede', (c) => {
      const r = this.en<{ mime: string; data: ArrayBuffer }>(`SELECT mime, data FROM billeder WHERE booking_id = ?`, c.req.param('id'));
      if (!r) throw new Fejl(404, 'Intet billede.');
      return new Response(r.data, {
        headers: { 'Content-Type': r.mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline', 'Content-Security-Policy': "default-src 'none'" },
      });
    });

    app.post('/admin/bookinger', async (c) => {
      const f = (await c.req.json()) as Record<string, unknown>;
      const kunde = this.kundeFraInput(f);
      const felter = validerKunde({ ...kunde, email: kunde.email || 'ukendt@example.com', urtype: kunde.urtype || 'Andet', beskrivelse: kunde.beskrivelse || '---' });
      if (kunde.email && !EMAIL_RE.test(kunde.email)) felter.email = 'Ugyldig e-mail.';
      if (Object.keys(felter).length) throw new Fejl(400, 'Tjek de markerede felter.', felter);
      const y = ydelseEllerFejl(String(f.ydelse));
      const dato = String(f.dato ?? '');
      const start = Number(f.start);
      if (!erDato(dato) || !Number.isInteger(start) || start < 0 || start > 24 * 60) throw new Fejl(400, 'Vælg dato og tid.');
      const id = this.ctx.storage.transactionSync(() => {
        if (f.tving !== true && !(this.ledighed(y, dato, 1, { admin: true })[dato] ?? []).includes(start)) {
          throw new Fejl(409, 'Tiden er ikke ledig (optaget, blokeret eller uden for åbningstiden).');
        }
        return this.indsaetBooking({ ydelse: y, dato, start, status: 'bekraeftet', kilde: 'admin', samtykke: null,
          kunde: { ...kunde, urtype: kunde.urtype || 'Andet' } });
      });
      const b = this.hentBooking(id)!;
      if (b.email && f.sendMail === true) await this.mail(id, mails.mailBekraeftet(b, this.link(b.token)));
      return c.json({ booking: this.adminVisning(b) }, 201);
    });

    app.post('/admin/bookinger/:id/status', async (c) => {
      const f = (await c.req.json()) as Record<string, unknown>;
      const b = this.hentBooking(c.req.param('id'));
      if (!b) throw new Fejl(404, 'Bookingen findes ikke.');
      if (b.anonymiseret) throw new Fejl(409, 'Bookingens oplysninger er slettet.');
      const ny = String(f.status) as BookingStatus;
      if (!(ny in STATUS_TEKST)) throw new Fejl(400, 'Ugyldig status.');
      const besked = rens(f.besked, 1000);
      if (ny === b.status) return c.json({ booking: this.adminVisning(b) });
      // En afvist/aflyst tid kan kun genåbnes, hvis tiden stadig er ledig
      if (AKTIVE_STATUSSER.includes(ny) && !AKTIVE_STATUSSER.includes(b.status)) {
        const y = this.ydelser().find((x) => x.id === b.ydelseId);
        const ledig = y && (this.ledighed(y, b.dato, 1, { admin: true, ignorerId: b.id })[b.dato] ?? []).includes(b.start);
        if (!ledig && f.tving !== true) throw new Fejl(409, 'Tiden er ikke længere ledig. Flyt aftalen i stedet.');
      }
      this.sql.exec(`UPDATE bookinger SET status = ?, opdateret = ? WHERE id = ?`, ny, nuIso(), b.id);
      this.log(b.id, STATUS_TEKST[ny].toLowerCase(), besked ? `Besked: ${besked}` : '');
      const opd = this.hentBooking(b.id)!;
      if (opd.email && f.sendMail !== false) {
        if (ny === 'bekraeftet') await this.mail(b.id, mails.mailBekraeftet(opd, this.link(opd.token)));
        if (ny === 'afvist') await this.mail(b.id, mails.mailAfvist(opd, besked));
        if (ny === 'aflyst') await this.mail(b.id, mails.mailAflyst(opd, besked, false));
      }
      return c.json({ booking: this.adminVisning(opd) });
    });

    app.post('/admin/bookinger/:id/flyt', async (c) => {
      const f = (await c.req.json()) as Record<string, unknown>;
      const b = this.hentBooking(c.req.param('id'));
      if (!b) throw new Fejl(404, 'Bookingen findes ikke.');
      if (b.anonymiseret) throw new Fejl(409, 'Bookingens oplysninger er slettet.');
      const y = f.ydelse ? ydelseEllerFejl(String(f.ydelse)) : (this.ydelser().find((x) => x.id === b.ydelseId) ?? { id: b.ydelseId, navn: b.ydelseNavn, varighed: b.slut - b.start, buffer: b.buffer } as Ydelse);
      const dato = String(f.dato ?? '');
      const start = Number(f.start);
      if (!erDato(dato) || !Number.isInteger(start)) throw new Fejl(400, 'Vælg dato og tid.');
      this.ctx.storage.transactionSync(() => {
        if (f.tving !== true && !(this.ledighed(y, dato, 1, { admin: true, ignorerId: b.id })[dato] ?? []).includes(start)) {
          throw new Fejl(409, 'Tiden er ikke ledig (optaget, blokeret eller uden for åbningstiden).');
        }
        this.sql.exec(
          `UPDATE bookinger SET dato = ?, start = ?, slut = ?, buffer = ?, ydelse_id = ?, ydelse_navn = ?, opdateret = ?,
            status = CASE WHEN status IN ('anmodet','bekraeftet') THEN status ELSE 'bekraeftet' END WHERE id = ?`,
          dato, start, start + y.varighed, y.buffer, y.id, y.navn, nuIso(), b.id,
        );
        this.log(b.id, 'flyttet', `Fra ${datoLang(b.dato)} kl. ${klok(b.start)} til ${datoLang(dato)} kl. ${klok(start)}`);
      });
      const opd = this.hentBooking(b.id)!;
      if (opd.email && f.sendMail !== false) await this.mail(b.id, mails.mailFlyttet(opd, this.link(opd.token)));
      return c.json({ booking: this.adminVisning(opd) });
    });

    app.post('/admin/bookinger/:id/noter', async (c) => {
      const f = (await c.req.json()) as Record<string, unknown>;
      const tekst = rens(f.tekst, 2000);
      if (!tekst) throw new Fejl(400, 'Noten er tom.');
      const id = c.req.param('id');
      if (!this.hentBooking(id)) throw new Fejl(404, 'Bookingen findes ikke.');
      this.sql.exec(`INSERT INTO noter VALUES (?, ?, ?, ?)`, nyId(), id, tekst, nuIso());
      return c.json({ noter: this.q(`SELECT id, tekst, oprettet FROM noter WHERE booking_id = ? ORDER BY oprettet`, id) });
    });

    app.delete('/admin/bookinger/:id/noter/:nid', (c) => {
      this.sql.exec(`DELETE FROM noter WHERE id = ? AND booking_id = ?`, c.req.param('nid'), c.req.param('id'));
      return c.json({ noter: this.q(`SELECT id, tekst, oprettet FROM noter WHERE booking_id = ? ORDER BY oprettet`, c.req.param('id')) });
    });

    app.post('/admin/bookinger/:id/anonymiser', (c) => {
      const b = this.hentBooking(c.req.param('id'));
      if (!b) throw new Fejl(404, 'Bookingen findes ikke.');
      this.ctx.storage.transactionSync(() => this.anonymiser(b.id, 'Slettet af værkstedet'));
      return c.json({ booking: this.adminVisning(this.hentBooking(b.id)!) });
    });

    app.delete('/admin/bookinger/:id', (c) => {
      const id = c.req.param('id');
      this.ctx.storage.transactionSync(() => {
        for (const t of ['noter', 'historik', 'billeder', 'udbakke']) this.sql.exec(`DELETE FROM ${t} WHERE booking_id = ?`, id);
        this.sql.exec(`DELETE FROM bookinger WHERE id = ?`, id);
      });
      return c.json({ ok: true });
    });

    /** Slet alle oplysninger om én kunde (ret til sletning). */
    app.post('/admin/slet-kunde', async (c) => {
      const f = (await c.req.json()) as Record<string, unknown>;
      const email = rens(f.email, 200).toLowerCase();
      const telefon = normalTelefon(rens(f.telefon, 30));
      if (!email && telefon.length < 8) throw new Fejl(400, 'Angiv kundens e-mail eller telefonnummer.');
      const ids = this.q<{ id: string; telefon: string; email: string }>(`SELECT id, telefon, email FROM bookinger WHERE anonymiseret = 0`)
        .filter((r) => (email && r.email === email) || (telefon.length >= 8 && normalTelefon(r.telefon).endsWith(telefon.slice(-8))));
      let beskeder = 0;
      this.ctx.storage.transactionSync(() => {
        for (const r of ids) this.anonymiser(r.id, 'Kundens oplysninger slettet efter anmodning');
        if (email) {
          beskeder = this.q(`SELECT id FROM beskeder WHERE email = ?`, email).length;
          this.sql.exec(`DELETE FROM beskeder WHERE email = ?`, email);
          this.sql.exec(`DELETE FROM udbakke WHERE til = ?`, email);
        }
      });
      return c.json({ bookinger: ids.length, beskeder });
    });

    app.get('/admin/ledighed', (c) => {
      const y = ydelseEllerFejl(c.req.query('ydelse'));
      const fra = c.req.query('fra') ?? '';
      if (!erDato(fra)) throw new Fejl(400, 'Ugyldig dato.');
      const dage = Math.min(62, Math.max(1, Number(c.req.query('dage') ?? 1) || 1));
      return c.json({ dage: this.ledighed(y, fra, dage, { admin: true, ignorerId: c.req.query('ignorer') }) });
    });

    app.get('/admin/kalender', (c) => {
      const fra = c.req.query('fra') ?? '';
      const til = c.req.query('til') ?? '';
      if (!erDato(fra) || !erDato(til) || dageMellem(fra, til) > 62 || til < fra) throw new Fejl(400, 'Ugyldig periode.');
      return c.json({
        bookinger: this.q(`SELECT * FROM bookinger WHERE dato BETWEEN ? AND ? AND status NOT IN ('afvist') ORDER BY dato, start`, fra, til).map((r) => this.adminVisning(this.tilBooking(r))),
        blokeringer: this.blokeringer(fra, til),
        lukkeperioder: this.lukkeperioder().filter((p) => p.til >= fra && p.fra <= til),
        aabningstider: this.aabningstider(),
      });
    });

    app.get('/admin/indstillinger', (c) =>
      c.json({ aabningstider: this.aabningstider(), regler: this.regler(), ydelser: this.ydelser(), lukkeperioder: this.lukkeperioder(),
        blokeringer: this.blokeringer(kbhTid().dato, '9999-12-31') }),
    );

    app.put('/admin/aabningstider', async (c) => {
      const f = (await c.req.json()) as Record<string, unknown>;
      const ud: Aabningstider = {};
      for (let d = 0; d < 7; d++) {
        const liste = Array.isArray(f[String(d)]) ? (f[String(d)] as Interval[]) : [];
        const rensede = liste
          .map((i) => ({ fra: Math.round(Number(i.fra)), til: Math.round(Number(i.til)) }))
          .filter((i) => Number.isFinite(i.fra) && Number.isFinite(i.til) && i.fra >= 0 && i.til <= 24 * 60 && i.fra < i.til)
          .sort((a, b) => a.fra - b.fra);
        for (let i = 1; i < rensede.length; i++) if (rensede[i]!.fra < rensede[i - 1]!.til) throw new Fejl(400, 'Åbningstiderne for en dag må ikke overlappe.');
        ud[String(d)] = rensede.slice(0, 4);
      }
      this.gemIndstilling('aabningstider', ud);
      return c.json({ aabningstider: ud });
    });

    app.put('/admin/regler', async (c) => {
      const f = (await c.req.json()) as Record<string, unknown>;
      const tal = (v: unknown, min: number, max: number, std: number) => {
        const n = Math.round(Number(v));
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : std;
      };
      const r = this.regler();
      const ny: BookingRegler = {
        interval: tal(f.interval, 5, 120, r.interval),
        kapacitet: tal(f.kapacitet, 1, 10, r.kapacitet),
        minVarselTimer: tal(f.minVarselTimer, 0, 24 * 14, r.minVarselTimer),
        maxDageFrem: tal(f.maxDageFrem, 1, 365, r.maxDageFrem),
        sletEfterMaaneder: tal(f.sletEfterMaaneder, 0, 120, r.sletEfterMaaneder),
      };
      this.gemIndstilling('regler', ny);
      return c.json({ regler: ny });
    });

    app.put('/admin/ydelser', async (c) => {
      const f = (await c.req.json()) as { ydelser?: Partial<Ydelse>[] };
      const liste = (f.ydelser ?? []).slice(0, 30).map((y, i) => ({
        id: rens(y.id, 40).toLowerCase().replace(/[^a-z0-9-]/g, '') || `ydelse-${crypto.randomUUID().slice(0, 6)}`,
        navn: rens(y.navn, 80), beskrivelse: rens(y.beskrivelse, 300),
        varighed: Math.min(240, Math.max(5, Math.round(Number(y.varighed) || 30))),
        buffer: Math.min(120, Math.max(0, Math.round(Number(y.buffer) || 0))), aktiv: y.aktiv !== false, sortering: i + 1,
      }));
      if (liste.some((y) => y.navn.length < 2)) throw new Fejl(400, 'Alle ydelser skal have et navn.');
      if (!liste.some((y) => y.aktiv)) throw new Fejl(400, 'Mindst én ydelse skal kunne bookes.');
      this.ctx.storage.transactionSync(() => {
        // Ydelser, der er brugt i bookinger, slettes ikke, men deaktiveres
        const brugte = new Set(this.q<{ ydelse_id: string }>(`SELECT DISTINCT ydelse_id FROM bookinger`).map((r) => r.ydelse_id));
        const nye = new Set(liste.map((y) => y.id));
        for (const gammel of this.ydelser()) {
          if (nye.has(gammel.id)) continue;
          if (brugte.has(gammel.id)) this.sql.exec(`UPDATE ydelser SET aktiv = 0, sortering = 999 WHERE id = ?`, gammel.id);
          else this.sql.exec(`DELETE FROM ydelser WHERE id = ?`, gammel.id);
        }
        for (const y of liste) this.gemYdelse(y);
      });
      return c.json({ ydelser: this.ydelser() });
    });

    app.post('/admin/lukkeperioder', async (c) => {
      const f = (await c.req.json()) as Record<string, unknown>;
      const fra = String(f.fra ?? '');
      const til = String(f.til ?? fra);
      if (!erDato(fra) || !erDato(til) || til < fra) throw new Fejl(400, 'Vælg en gyldig periode.');
      this.sql.exec(`INSERT INTO lukkeperioder VALUES (?, ?, ?, ?)`, nyId(), fra, til, rens(f.note, 120) || 'Lukket');
      const konflikter = this.q(`SELECT count(*) AS n FROM bookinger WHERE dato BETWEEN ? AND ? AND status IN ('anmodet','bekraeftet')`, fra, til)[0]?.n ?? 0;
      return c.json({ lukkeperioder: this.lukkeperioder(), konflikter });
    });

    app.delete('/admin/lukkeperioder/:id', (c) => {
      this.sql.exec(`DELETE FROM lukkeperioder WHERE id = ?`, c.req.param('id'));
      return c.json({ lukkeperioder: this.lukkeperioder() });
    });

    app.post('/admin/blokeringer', async (c) => {
      const f = (await c.req.json()) as Record<string, unknown>;
      const dato = String(f.dato ?? '');
      const fra = Math.round(Number(f.fra));
      const til = Math.round(Number(f.til));
      if (!erDato(dato) || !(fra >= 0 && til <= 24 * 60 && fra < til)) throw new Fejl(400, 'Vælg dato og et gyldigt tidsrum.');
      this.sql.exec(`INSERT INTO blokeringer VALUES (?, ?, ?, ?, ?)`, nyId(), dato, fra, til, rens(f.note, 120) || 'Blokeret');
      const konflikter = this.q(`SELECT count(*) AS n FROM bookinger WHERE dato = ? AND status IN ('anmodet','bekraeftet') AND start < ? AND slut > ?`, dato, til, fra)[0]?.n ?? 0;
      return c.json({ blokeringer: this.blokeringer(kbhTid().dato, '9999-12-31'), konflikter });
    });

    app.delete('/admin/blokeringer/:id', (c) => {
      this.sql.exec(`DELETE FROM blokeringer WHERE id = ?`, c.req.param('id'));
      return c.json({ blokeringer: this.blokeringer(kbhTid().dato, '9999-12-31') });
    });

    app.get('/admin/beskeder', (c) => c.json({ beskeder: this.q(`SELECT * FROM beskeder ORDER BY oprettet DESC LIMIT 200`) }));
    app.post('/admin/beskeder/:id/laest', (c) => {
      this.sql.exec(`UPDATE beskeder SET laest = 1 - laest WHERE id = ?`, c.req.param('id'));
      return c.json({ ok: true });
    });
    app.delete('/admin/beskeder/:id', (c) => {
      this.sql.exec(`DELETE FROM beskeder WHERE id = ?`, c.req.param('id'));
      return c.json({ ok: true });
    });

    app.get('/admin/udbakke', (c) => c.json({ mails: this.q(`SELECT * FROM udbakke ORDER BY id DESC LIMIT 200`) }));

    app.get('/admin/eksport', (c) => {
      const fra = c.req.query('fra');
      const til = c.req.query('til');
      const hvor: string[] = [];
      const args: SqlStorageValue[] = [];
      if (fra && erDato(fra)) { hvor.push('dato >= ?'); args.push(fra); }
      if (til && erDato(til)) { hvor.push('dato <= ?'); args.push(til); }
      const rows = this.q(`SELECT * FROM bookinger ${hvor.length ? 'WHERE ' + hvor.join(' AND ') : ''} ORDER BY dato, start`, ...args).map((r) => this.tilBooking(r));
      const celle = (v: string | number) => {
        let s = String(v);
        if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // undgå formler i regneark
        return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const hoved = ['Reference', 'Dato', 'Tid', 'Varighed (min)', 'Ydelse', 'Status', 'Navn', 'Telefon', 'E-mail', 'Urtype', 'Mærke/model', 'Beskrivelse', 'Oprettet', 'Kilde'];
      const linjer = rows.map((b) => [b.ref, b.dato, klok(b.start), b.slut - b.start, b.ydelseNavn, STATUS_TEKST[b.status], b.navn, b.telefon, b.email, b.urtype, b.maerke, b.beskrivelse, b.oprettet.slice(0, 16).replace('T', ' '), b.kilde].map(celle).join(';'));
      const csv = '﻿' + [hoved.join(';'), ...linjer].join('\r\n');
      return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="bookinger-${kbhTid().dato}.csv"`, 'Cache-Control': 'no-store' } });
    });

    app.post('/admin/demo/nulstil', (c) => {
      if (!this.demo) throw new Fejl(403, 'Kun i demotilstand.');
      this.nulstilDemo();
      return c.json({ ok: true });
    });

    app.notFound((c) => c.json({ fejl: 'Ikke fundet.' }, 404));
    return app;
  }

  private kundeVisning(b: Booking) {
    return {
      ref: b.ref, ydelseNavn: b.ydelseNavn, dato: b.dato, start: b.start, slut: b.slut, status: b.status, statusTekst: STATUS_TEKST[b.status],
      navn: b.navn, telefon: b.telefon, email: b.email, urtype: b.urtype, maerke: b.maerke, beskrivelse: b.beskrivelse, harBillede: b.harBillede,
      demo: this.demo,
    };
  }

  private adminVisning(b: Booking & { token?: string }): Booking {
    const { token: _t, ...rest } = b;
    return rest;
  }
}

export const URTYPE_LISTE = URTYPER;
