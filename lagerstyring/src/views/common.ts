import { html } from 'hono/html';
import { formatQty } from '../lib/format';
import { LINE_STATUS_LABEL, LINE_STATUS_TAG, type LineStatus } from '../lib/purchasing';
import { STATUS_LABEL, STATUS_TAG, type StockPlan, type StockStatus } from '../lib/stock';
import { alert, type H } from './layout';

export function stockTag(status: StockStatus): H {
  return html`<span class="tag ${STATUS_TAG[status]}">${STATUS_LABEL[status]}</span>`;
}

export function lineTag(status: LineStatus): H {
  return html`<span class="tag ${LINE_STATUS_TAG[status]}">${LINE_STATUS_LABEL[status]}</span>`;
}

export function rowClass(status: StockStatus): string {
  return status === 'ingen' ? 'is-out' : status === 'kritisk' ? 'is-crit' : status === 'genbestil' ? 'is-low' : '';
}

/** Mængde eller "Mangler opsætning" (aldrig 0 for et manglende tal). */
export function qtyOrMissing(m: number | null, unit = ''): H {
  return m === null ? html`<span class="miss">Mangler opsætning</span>` : html`<span class="nowrap">${formatQty(m)}${unit ? ` ${unit}` : ''}</span>`;
}

/** Lille bjælke: disponibel beholdning i forhold til genbestillingspunktet. */
export function meter(plan: StockPlan): H {
  if (plan.rop === null || plan.rop <= 0) return html``;
  const pct = Math.max(0, Math.min(100, Math.round((plan.available / (plan.rop * 2)) * 100)));
  const cls = plan.status === 'ingen' ? 'out' : plan.status === 'kritisk' ? 'crit' : plan.status === 'genbestil' ? 'low' : '';
  return html`<div class="meter ${cls}" aria-hidden="true"><span style="width:${pct}%"></span></div>`;
}

export function pageHead(eyebrow: string | H, title: string | H, actions: H | string = '', sub: H | string = ''): H {
  return html`<div class="page-head">
  <div class="stack-sm">
    <div class="eyebrow">${eyebrow}</div>
    <h1>${title}</h1>
    ${sub ? html`<p class="muted">${sub}</p>` : ''}
  </div>
  ${actions ? html`<div class="row">${actions}</div>` : ''}
</div>`;
}

const FLASH: Record<string, [kind: 'ok' | 'info' | 'warn' | 'err', text: string]> = {
  gemt: ['ok', 'Ændringerne er gemt.'],
  logo_gemt: ['ok', 'Logoet er gemt.'],
  inviteret: ['ok', 'Brugeren er oprettet, og invitationen er sendt på e-mail.'],
  invitation_simuleret: ['info', 'Brugeren er oprettet. Invitationen er kun simuleret, fordi e-mail ikke er sat op, og den er gemt i e-mail-loggen.'],
  invitation_fejlet: ['warn', 'Brugeren er oprettet, men invitationen kunne ikke sendes. Brugeren kan stadig logge ind med sin e-mail.'],
  logo_slettet: ['ok', 'Logoet er fjernet.'],
  oprettet: ['ok', 'Oprettet.'],
  registreret: ['ok', 'Registreringen er gemt.'],
  dublet: ['info', 'Registreringen var allerede gennemført, så den er ikke lavet igen.'],
  bestilt: ['ok', 'Bestillingen er registreret.'],
  modtaget: ['ok', 'Modtagelsen er registreret.'],
  annulleret: ['ok', 'Linjen er annulleret.'],
  arkiveret: ['ok', 'Listen er arkiveret.'],
  genaabnet: ['ok', 'Listen er genåbnet.'],
  afsluttet: ['ok', 'Jobbet er afsluttet, og ubrugte reservationer er frigivet.'],
  job_genaabnet: ['ok', 'Jobbet er genåbnet.'],
  godkendt: ['ok', 'Fakturagrundlaget er godkendt. Mængder og priser er nu låst.'],
  slettet: ['ok', 'Slettet.'],
  nulstillet: ['ok', 'Demodata er nulstillet.'],
  ingen_adgang: ['warn', 'Den side er kun for ejer og indkøber.'],
  logget_ud: ['info', 'Du er logget ud.'],
  login_udlobet: ['info', 'Siden var udløbet. Tryk på knappen igen for at få et login-link.'],
  tom: ['warn', 'Angiv mindst én mængde.'],
  planlagt: ['ok', 'Materialerne er reserveret til jobbet.'],
  planlagt_mangler: ['warn', 'Det disponible er reserveret. Resten mangler og står nu på jobbets indkøbsliste, og jobbet afventer materialer.'],
  forbrug: ['ok', 'Forbruget er registreret og trukket fra lageret.'],
  job_oprettet: ['ok', 'Jobbet er oprettet.'],
  pris_gemt: ['ok', 'Prisen er gemt.'],
  alternativ_godkendt: ['ok', 'Alternativet er godkendt og tæller med i estimatet. Varen på listen er ikke ændret.'],
  prisfil: ['ok', 'Prisfilen er indlæst.'],
  job_annulleret: ['ok', 'Jobbet er annulleret, og ubrugte reservationer er frigivet.'],
  status_gemt: ['ok', 'Status er ændret.'],
  materiale_tilfojet: ['ok', 'Materialet er tilføjet jobbet.'],
  alternativ_godkendt_job: ['ok', 'Alternativet er godkendt for denne linje. Prisen bruges nu i overslag og faktura.'],
  forbrug_registreret: ['ok', 'Forbruget er registreret.'],
  reserveret: ['ok', 'Lagervarerne er reserveret, og det manglende står på jobbets indkøbsliste.'],
  timer_registreret: ['ok', 'Timerne er registreret og afventer godkendelse.'],
  timer_godkendt: ['ok', 'Timerne er godkendt til fakturering.'],
  overslag_gemt: ['ok', 'Prisoverslaget er gemt som en ny version. Tidligere versioner er uændrede.'],
  overslag_accepteret: ['ok', 'Overslaget er markeret som accepteret af kunden.'],
  kladde_oprettet: ['ok', 'Fakturakladden er oprettet. Den er ikke udstedt endnu.'],
  faktura_udstedt: ['ok', 'Fakturaen er udstedt og låst. Rettelser sker med en kreditnota.'],
  kreditnota_oprettet: ['ok', 'Kreditnotaen er oprettet som kladde.'],
  kreditnota_udstedt: ['ok', 'Kreditnotaen er udstedt og låst.'],
  katalog_reserveret: ['ok', 'Varen er tilføjet jobbet og reserveret på lageret.'],
  katalog_mangler: ['warn', 'Varen er tilføjet jobbet. Det disponible er reserveret, og resten står nu på jobbets indkøbsliste.'],
  katalog_brugt: ['ok', 'Varen er tilføjet jobbet, og forbruget er trukket fra lageret.'],
  katalog_oprettet: ['ok', 'Varen er oprettet i varekartoteket fra produktkataloget. Beholdningen er 0; lager registreres som altid ved modtagelse eller optælling.'],
  katalog_knyttet: ['ok', 'Varen fandtes allerede i varekartoteket og er nu knyttet til produktkataloget. Beholdningen er uændret.'],
  enhed_mangler: ['warn', 'Katalogvaren har ingen enhed. Vælg varen på et job og angiv enheden dér, eller opret varen manuelt.'],
  import_godkendt: ['ok', 'Importen er godkendt, og produktkataloget er opdateret. Lagerbeholdninger, indkøb og modtagelser er ikke ændret.'],
  import_annulleret: ['ok', 'Importen er annulleret. Kataloget er uændret.'],
  belastning: ['ok', 'Belastningstestens syntetiske DEMO-varer er oprettet i kataloget.'],
  betaling_registreret: ['ok', 'Betalingen er registreret. Den er ikke afstemt med banken.'],
  betaling_annulleret: ['ok', 'Registreringen er annulleret og bevaret i historikken.'],
  belastning_fjernet: ['ok', 'Belastningstestens syntetiske DEMO-varer er fjernet.'],
};

export function flash(code: string | undefined): H | '' {
  const f = code ? FLASH[code] : undefined;
  return f ? alert(f[0], f[1]) : '';
}

/** Besked om en afsendt (eller simuleret) e-mail. Siger aldrig "sendt", hvis den ikke er det. */
export function mailFlash(status: string | undefined, to: string | undefined): H | '' {
  if (!status) return '';
  if (status === 'sendt') return alert('ok', `E-mailen er sendt til ${to ?? 'modtageren'}.`);
  if (status === 'simuleret')
    return alert('info', html`<strong>Simuleret:</strong> e-mailen til ${to ?? 'modtageren'} er <strong>ikke sendt</strong>, fordi e-mail ikke er sat op i denne demo. Indholdet er gemt under Indstillinger → E-mails.`);
  return alert('err', `E-mailen til ${to ?? 'modtageren'} kunne ikke sendes. Prøv igen senere.`);
}

export function mailTag(status: string): H {
  return status === 'sendt'
    ? html`<span class="tag tag-sent">Sendt</span>`
    : status === 'simuleret'
      ? html`<span class="tag tag-sim">Simuleret, ikke sendt</span>`
      : html`<span class="tag tag-fail">Fejlede</span>`;
}

export function errors(list: string[]): H | '' {
  if (!list.length) return '';
  return alert('err', list.length === 1 ? list[0]! : html`<ul>${list.map((e) => html`<li>${e}</li>`)}</ul>`);
}
