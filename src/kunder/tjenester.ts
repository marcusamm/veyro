// De tjenester, Veyro faktisk kan levere i dag, og hvad hver kræver.
// En tjeneste vises kun som "kan vælges", når den findes og virker. Planlagte tjenester kan ikke slås til.
// Tilgængelighed (her), teknisk opsætning (project_services) og betaling (Tilbud/Stripe) er adskilt:
// at slå en tjeneste til opretter aldrig et abonnement eller ændrer en pris.
import { normalizeEmail } from '../lib/db';

export type ServiceKey = 'hjemmeside' | 'kontaktformular' | 'varebestilling' | 'lagerstyring' | 'kundepanel';
export type ProjectKind = 'skabelon' | 'tilsluttet' | 'intern';

export interface ServiceDef {
  label: string;
  description: string;
  /** Andre tjenester, der skal være slået til */
  requires: ServiceKey[];
  /** Projekttyper, tjenesten giver mening for */
  kinds: ProjectKind[];
  /** Hvor tjenesten kører */
  where: string;
}

export const SERVICES: Record<ServiceKey, ServiceDef> = {
  hjemmeside: {
    label: 'Offentlig hjemmeside',
    description: 'Kundens hjemmeside. Enten bygget her ud fra et startpunkt, eller en færdig side, der tilsluttes.',
    requires: [],
    kinds: ['skabelon', 'tilsluttet'],
    where: 'Veyro-Workeren (startpunkt) eller kundens egen udrulning (tilsluttet)',
  },
  kontaktformular: {
    label: 'Kontakt- og tilbudsformular',
    description: 'Henvendelser fra hjemmesiden gemmes og sendes på e-mail til kunden. Kunden kan se dem i kundepanelet.',
    requires: ['hjemmeside'],
    kinds: ['skabelon', 'tilsluttet'],
    where: 'kunde.veyro.dk (gemmes i Veyros database, adskilt pr. projekt)',
  },
  varebestilling: {
    label: 'Kundebestilling med lager',
    description: 'Bestillingssystem til kundens kunder med varer, lager, reservationer, ordrestatus og lagervarsler. Eget domæne og egen database.',
    requires: [],
    kinds: ['skabelon', 'tilsluttet', 'intern'],
    where: 'Egen Worker og D1-database pr. kunde (varebestilling/), udrulles med "Deploy kunder"',
  },
  lagerstyring: {
    label: 'Intern lagerstyring',
    description: 'Lager, vareforbrug på job, indkøb og fakturakladder til virksomhedens egne medarbejdere. Ingen offentlig bestilling.',
    requires: [],
    kinds: ['skabelon', 'tilsluttet', 'intern'],
    where: 'Egen Worker og D1-database pr. kunde (lagerstyring/), udrulles med "Deploy kunder"',
  },
  kundepanel: {
    label: 'Kundepanel på kunde.veyro.dk',
    description: 'Kundens egne brugere logger ind med engangslink og ser deres hjemmeside, henvendelser, aftaler og abonnement.',
    requires: [],
    kinds: ['skabelon', 'tilsluttet', 'intern'],
    where: 'kunde.veyro.dk',
  },
};

/** Tjenester, der ikke findes endnu. Vises, men kan ikke vælges. */
export const PLANNED: { label: string; description: string }[] = [
  { label: 'Onlinebetaling i bestillingen', description: 'Varebestillingen har ingen kortbetaling i dag; kunderne betaler ved afhentning, levering eller på faktura.' },
  { label: 'Bogføringsintegration (fx e-conomic eller Dinero)', description: 'Findes ikke. Lagerstyringen kan lave fakturakladder som PDF.' },
];

export const SERVICE_ORDER: ServiceKey[] = ['hjemmeside', 'kontaktformular', 'varebestilling', 'lagerstyring', 'kundepanel'];

export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const SENDER = /^[^"\\\n<>]{1,80} <[^<>@\s]+@[^<>@\s]+>$/;

export interface ServiceRow {
  project_id: string;
  service: ServiceKey;
  enabled: number;
  config: string;
  status: string;
  status_detail: string | null;
  provision_requested_at: number | null;
  provisioned_at: number | null;
  provisioned_url: string | null;
  updated_at: number;
}

export interface Problem {
  /** Hvilket felt eller trin der skal rettes */
  field: string;
  message: string;
}

const emails = (v: unknown): string[] =>
  String(Array.isArray(v) ? v.join(',') : (v ?? ''))
    .split(/[\s,;]+/)
    .map((e) => normalizeEmail(e))
    .filter((e): e is string => !!e);

/** Læser en tjenestes indstillinger fra en formular (kun de felter, tjenesten bruger) */
export function readServiceConfig(service: ServiceKey, body: Record<string, unknown>): Record<string, unknown> {
  const t = (k: string, max = 200) => String(body[k] ?? '').trim().slice(0, max);
  switch (service) {
    case 'kontaktformular':
      return { recipients: emails(body['recipients']), subject: t('subject', 120) };
    case 'varebestilling':
    case 'lagerstyring':
      return {
        admins: emails(body['admins']),
        domaene: t('domaene').toLowerCase(),
        afsender: t('afsender'),
        ...(service === 'varebestilling'
          ? {
              pickup: body['pickup'] === '1',
              delivery: body['delivery'] === '1',
              delivery_fee_kr: Math.max(0, Math.min(10000, Math.round(Number(String(body['delivery_fee_kr'] ?? '0').replace(',', '.')) || 0))),
              auto_confirm: body['auto_confirm'] === '1',
              notify_email: normalizeEmail(body['notify_email']) ?? '',
            }
          : {}),
      };
    case 'kundepanel':
      return { members: emails(body['members']) };
    default:
      return {};
  }
}

/** Mangler i en tjenestes opsætning (tom liste = klar) */
export function validateService(service: ServiceKey, cfg: Record<string, any>, ctx: { kind: ProjectKind; enabled: Set<ServiceKey> }): Problem[] {
  const out: Problem[] = [];
  const def = SERVICES[service];
  if (!def.kinds.includes(ctx.kind)) out.push({ field: 'type', message: `${def.label} passer ikke til denne projekttype.` });
  for (const r of def.requires) if (!ctx.enabled.has(r)) out.push({ field: 'tjenester', message: `${def.label} kræver, at "${SERVICES[r].label}" også er slået til.` });
  switch (service) {
    case 'kontaktformular':
      if (!cfg.recipients?.length) out.push({ field: 'recipients', message: 'Angiv mindst én e-mail, som henvendelser skal sendes til.' });
      break;
    case 'varebestilling':
    case 'lagerstyring':
      if (!cfg.admins?.length) out.push({ field: 'admins', message: 'Angiv mindst én e-mail, der kan logge ind som ejer første gang.' });
      if (cfg.domaene && !HOST.test(cfg.domaene)) out.push({ field: 'domaene', message: `"${cfg.domaene}" er ikke et gyldigt domæne (fx bestil.firma.dk).` });
      if (cfg.afsender && !SENDER.test(cfg.afsender)) out.push({ field: 'afsender', message: 'Afsender skal have formen "Navn <adresse@domæne.dk>".' });
      if (service === 'varebestilling' && cfg.pickup === false && cfg.delivery === false) out.push({ field: 'pickup', message: 'Vælg afhentning, levering eller begge.' });
      if (service === 'varebestilling' && !cfg.notify_email) out.push({ field: 'notify_email', message: 'Angiv hvem der får besked om nye ordrer og lagervarsler.' });
      break;
    case 'kundepanel':
      if (!cfg.members?.length) out.push({ field: 'members', message: 'Angiv mindst én e-mail hos kunden, der skal kunne logge ind.' });
      break;
  }
  return out;
}

/**
 * Den adresse, varebestilling/lagerstyring får, hvis der ikke er angivet et eget domæne (samme regel som
 * scripts/deploy-kunder.mjs for kunder fra admin). <adresse>.<domæne> er hjemmesidens egen adresse.
 */
export function defaultSystemHost(slug: string, service: 'varebestilling' | 'lagerstyring', kundeDomaene: string): string {
  return `${slug}-${service === 'lagerstyring' ? 'lager' : 'bestilling'}.${kundeDomaene}`;
}
