// PDF'er og mails for fortrolighedsaftaler. PDF'erne laves udelukkende ud fra den gemte version (snapshot),
// så en senere ændring af standardskabelonen eller hjemmesiden aldrig ændrer en eksisterende aftale.
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { Env } from '../env';
import { nowSec } from './crypto';
import { escapeHtml, sendEmail, type EmailAttachment, type EmailMessage } from './email';
import { logError } from './errlog';
import {
  approvedVersion,
  CONFIRMATIONS,
  CONTINUING_TEXT,
  eventStmt,
  getNda,
  label,
  NOTICES,
  parseSnapshot,
  parseTemplate,
  REQUEST_KIND_LABEL,
  REQUEST_STATUS_LABEL,
  STATUS_LABEL,
  SUMMARY,
  type NdaRow,
  type Party,
  type RequestRow,
  type Snapshot,
  type TemplateRow,
  type VersionRow,
  type VeyroInfo,
} from './nda';
import { NDA_SUBTITLE, NDA_TITLE } from './nda-template';
import { ACCENT, M, MUTED, RED, Writer, fmtTime, winAnsi } from './pdfdoc';

// ---------- PDF ----------

function fullAddress(s: Snapshot['customer']): string {
  return `${s.address}, ${s.postal_code} ${s.city}`;
}

async function newDoc(title: string, at: number | null) {
  const doc = await PDFDocument.create();
  doc.setTitle(winAnsi(title));
  doc.setAuthor('Veyro');
  doc.setProducer('Veyro kundeportal');
  doc.setCreator('Veyro kundeportal');
  if (at) {
    doc.setCreationDate(new Date(at * 1000));
    doc.setModificationDate(new Date(at * 1000));
  }
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  return { doc, font, bold };
}

function logo(w: Writer): void {
  w.text('Veyro', M, 16, { bold: true });
  w.page.drawCircle({ x: M + w.bold.widthOfTextAtSize('Veyro', 16) + 3, y: w.y + 1.5, size: 1.8, color: ACCENT });
  w.y -= 30;
}

function approvalBlock(w: Writer, heading: string, v: VersionRow | null, party: Party, fallback: { name: string; title: string; company: string }): void {
  const p = party === 'kunde' ? 'customer' : 'veyro';
  const at = v?.[`${p}_approved_at`] ?? null;
  w.para(heading, { bold: true, size: 10 });
  w.y -= 2;
  if (!v || !at) {
    w.kv('Navn', fallback.name || '–');
    w.kv('Titel', fallback.title || '–');
    w.kv('Virksomhed', fallback.company || '–');
    w.kv('Godkendelse', 'Ikke godkendt');
  } else {
    w.kv('Navn', v[`${p}_name`] ?? '');
    w.kv('Titel', v[`${p}_title`] ?? '');
    w.kv('Virksomhed', v[`${p}_company`] ?? '');
    w.kv('Indlogget konto', v[`${p}_email`] ?? '');
    w.kv('Tidspunkt', fmtTime(at));
    w.kv('Metode', v[`${p}_method`] ?? '');
  }
  w.y -= 6;
}

/**
 * Hele aftalen. `final` medtager begge parters godkendelser og bruges til det gemte dokument;
 * ellers er dokumentet tydeligt mærket som udkast på hver side.
 */
export async function renderNdaPdf(
  snap: Snapshot,
  v: VersionRow | null,
  opts: { final: boolean; hash: string | null; sample?: boolean },
): Promise<Uint8Array> {
  const title = opts.sample ? `Fortrolighedsaftale, skabelon ${snap.template_version}` : `Fortrolighedsaftale ${snap.number} version ${snap.version}`;
  const effective = v?.customer_approved_at && v?.veyro_approved_at ? Math.max(v.customer_approved_at, v.veyro_approved_at) : null;
  const { doc, font, bold } = await newDoc(opts.final ? title : opts.sample ? `SKABELON – ${title}` : `UDKAST – ${title}`, opts.final ? effective : null);
  const footer = opts.final
    ? `${title} · Godkendt af begge parter · SHA-256 ${opts.hash ?? ''}`
    : opts.sample
      ? `SKABELON – IKKE EN GYLDIG AFTALE · ${title}`
      : `UDKAST – IKKE GODKENDT · ${title}${snap.test ? ` · ${snap.test.toUpperCase()}` : ''}`;
  const w = new Writer(doc, font, bold, footer);

  logo(w);
  w.text(snap.title.toUpperCase(), M, 20, { bold: true });
  w.y -= 16;
  w.para(snap.subtitle, { size: 11 });
  w.y -= 2;
  w.text(opts.sample ? `Skabelon version ${snap.template_version}` : `${snap.number} · version ${snap.version} · skabelon ${snap.template_version}`, M, 9.5, { color: MUTED });
  w.y -= 18;
  if (snap.test) w.stamp(`${snap.test.toUpperCase()}: TESTDOKUMENT – IKKE GYLDIGT`);
  if (opts.sample)
    w.stamp('SKABELON – IKKE EN GYLDIG AFTALE. Felterne i [klammer] udfyldes i kundeportalen, og aftalen gælder først, når begge parter har godkendt den.');
  else if (!opts.final) w.stamp('UDKAST – IKKE GODKENDT. Aftalen er først gældende, når begge parter har godkendt den samme version.');

  w.heading('Aftalens parter');
  w.para('Veyro', { bold: true, size: 10 });
  w.kv('Juridisk navn', snap.veyro.legal_name || '(ikke udfyldt)');
  w.kv('CVR-nr.', snap.veyro.cvr || '(ikke udfyldt)');
  w.kv('Adresse', snap.veyro.address || '(ikke udfyldt)');
  w.kv('Kontaktperson', snap.veyro.contact_name || '–');
  w.kv('E-mail', snap.veyro.contact_email);
  w.y -= 6;
  w.para('Kunden eller samarbejdspartneren', { bold: true, size: 10 });
  w.kv('Juridisk navn', snap.customer.company_name);
  w.kv('CVR-nr.', snap.customer.cvr);
  w.kv('Adresse', fullAddress(snap.customer));
  w.kv('Kontaktperson', snap.customer.contact_name);
  w.kv('E-mail', snap.customer.contact_email);
  w.y -= 4;

  for (const b of parseTemplate(snap.body)) {
    if (b.kind === 'heading') {
      w.heading(b.text);
    } else if (b.kind === 'para') {
      w.para(b.text);
      w.y -= 5;
    } else if (b.kind === 'bullets') {
      for (const item of b.items) w.bullet(item);
      w.y -= 3;
    } else {
      w.para('Konkret projekt, hjemmeside eller system:', { bold: true });
      w.para(snap.project, { x: M + 12 });
      w.y -= 5;
    }
  }

  w.y -= 4;
  w.need(200);
  approvalBlock(w, 'For Veyro', v, 'veyro', { name: '', title: '', company: snap.veyro.legal_name });
  approvalBlock(w, 'For kunden eller samarbejdspartneren', v, 'kunde', {
    name: snap.customer_approver.name,
    title: snap.customer_approver.title,
    company: snap.customer.company_name,
  });
  w.heading('Aftalens gyldighed');
  if (effective) {
    w.kv('Ikrafttræden', `${fmtTime(effective)} (tidspunktet for den sidste godkendelse)`);
  } else {
    w.kv('Ikrafttræden', 'Aftalen træder først i kraft, når begge parter har godkendt denne version.');
  }
  if (!opts.sample) {
    w.kv('Aftalenummer', snap.number);
    w.kv('Version', String(snap.version));
  }
  w.kv('Skabelon', `Version ${snap.template_version}`);
  if (opts.hash) w.kv('Indholdets SHA-256', opts.hash);
  w.para(
    'Godkendelsen er sket digitalt i Veyros kundeportal med verificeret login og en engangskode sendt til den indloggede e-mail. Det er ikke en MitID-underskrift og ikke dokumentation for tegningsret; godkenderne har selv bekræftet at være bemyndigede.',
    { size: 8.5, color: MUTED },
  );
  if (snap.footnote) {
    w.y -= 10;
    w.para(snap.footnote, { size: 8, color: MUTED });
  }
  return doc.save({ useObjectStreams: false });
}

/** Offentlig skabelon til veyro.dk: den aktuelle standardtekst med pladsholdere i stedet for kundens oplysninger. */
export async function sampleNdaPdf(veyro: VeyroInfo, t: TemplateRow): Promise<Uint8Array> {
  const snap: Snapshot = {
    number: '[Aftalenummer]',
    version: 1,
    template_version: t.version,
    title: NDA_TITLE,
    subtitle: NDA_SUBTITLE,
    body: t.body,
    footnote: t.footnote,
    test: null,
    customer: {
      company_name: '[Virksomhedens juridiske navn]',
      cvr: '[CVR-nr.]',
      address: '[Adresse]',
      postal_code: '[Postnr.]',
      city: '[By]',
      contact_name: '[Kontaktperson]',
      contact_email: '[E-mail]',
    },
    customer_approver: { name: '[Navn]', title: '[Titel]' },
    veyro: {
      legal_name: veyro.legal_name || '[Veyros juridiske navn]',
      cvr: veyro.cvr || '[CVR-nr.]',
      address: veyro.address || '[Adresse]',
      contact_name: veyro.contact_name,
      contact_email: veyro.contact_email,
    },
    project: '[Det konkrete projekt, den hjemmeside eller det system, aftalen gælder]',
    summary: SUMMARY,
    notices: NOTICES,
    confirmations: [...CONFIRMATIONS],
  };
  return renderNdaPdf(snap, null, { final: false, hash: null, sample: true });
}

/** Kvittering for ophør. Dokumenterer registreringen af meddelelsen, ikke at den er kommet frem. */
export async function renderTerminationPdf(nda: NdaRow, snap: Snapshot): Promise<Uint8Array> {
  const { doc, font, bold } = await newDoc(`Kvittering for ophør – ${nda.number}`, nda.terminated_at);
  const w = new Writer(doc, font, bold, `Kvittering for ophør af fortrolighedsaftale ${nda.number} for fremtidig udveksling`);
  logo(w);
  w.text('KVITTERING FOR OPHØR', M, 18, { bold: true });
  w.y -= 18;
  w.para('Afslutning af fortrolighedsaftalen for fremtidig udveksling af oplysninger', { size: 11 });
  w.y -= 8;
  if (snap.test) w.stamp(`${snap.test.toUpperCase()}: TESTDOKUMENT – IKKE GYLDIGT`);
  w.heading('Aftalen');
  w.kv('Aftalenummer', `${nda.number} (version ${snap.version})`);
  w.kv('Veyro', `${snap.veyro.legal_name}, CVR ${snap.veyro.cvr}`);
  w.kv('Kunden', `${snap.customer.company_name}, CVR ${snap.customer.cvr}`);
  w.kv('Projekt', snap.project);
  w.kv('Ikrafttræden', fmtTime(nda.effective_at));
  w.heading('Ophør');
  w.kv('Afsluttet af', nda.terminated_party === 'kunde' ? `Kunden (${snap.customer.company_name})` : `Veyro (${snap.veyro.legal_name})`);
  w.kv('Registreret af konto', nda.terminated_by ?? '');
  w.kv('Registreret', fmtTime(nda.terminated_at));
  w.kv('Ny status', STATUS_LABEL.terminated);
  w.heading('Skriftlig meddelelse til den anden part');
  w.para(nda.termination_notice ?? '');
  w.y -= 6;
  w.para(
    'Denne kvittering dokumenterer, at meddelelsen er registreret i Veyros kundeportal på tidspunktet ovenfor. Den dokumenterer ikke i sig selv, at meddelelsen er kommet frem. Leveringsstatus for meddelelsen fremgår af kundeportalen.',
    { size: 9, color: MUTED },
  );
  w.heading('Fortsat fortrolighed');
  w.para(CONTINUING_TEXT);
  w.y -= 4;
  w.para(
    'Efter aftalens punkt 4 gælder fortroligheds- og anvendelsesbegrænsningerne for allerede modtagne oplysninger under samarbejdet og i fem år efter det seneste af samarbejdets ophør eller aftalens ophør. Hvis et samarbejde ikke indledes, regnes de fem år fra aftalens ophør.',
  );
  return doc.save({ useObjectStreams: false });
}

// ---------- Gemte dokumenter ----------

function toBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  throw new Error('Ukendt dokumentformat');
}

async function bytesHash(b: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', b);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export interface StoredDoc {
  kind: 'final' | 'termination';
  sha256: string;
  pdf: Uint8Array;
  created_at: number;
}

async function storedDoc(db: D1Database, ndaId: number, kind: StoredDoc['kind']): Promise<StoredDoc | null> {
  const row = await db
    .prepare('SELECT kind, sha256, pdf, created_at FROM nda_documents WHERE nda_id = ? AND kind = ?')
    .bind(ndaId, kind)
    .first<{ kind: StoredDoc['kind']; sha256: string; pdf: unknown; created_at: number }>();
  return row ? { ...row, pdf: toBytes(row.pdf) } : null;
}

/**
 * Den endelige aftale (godkendt af begge parter). Laves én gang ud fra den gemte version og gemmes;
 * findes den allerede, returneres den uændret.
 */
export async function ensureFinalDocument(db: D1Database, nda: NdaRow): Promise<StoredDoc | null> {
  const existing = await storedDoc(db, nda.id, 'final');
  if (existing) return existing;
  const v = await approvedVersion(db, nda.id);
  const snap = v ? parseSnapshot(v) : null;
  if (!v || !snap || !v.content_hash) return null;
  const pdf = await renderNdaPdf(snap, v, { final: true, hash: v.content_hash });
  await db
    .prepare('INSERT OR IGNORE INTO nda_documents (nda_id, version_id, kind, sha256, pdf, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(nda.id, v.id, 'final', await bytesHash(pdf), pdf, nowSec())
    .run();
  return storedDoc(db, nda.id, 'final');
}

export async function ensureTerminationDocument(db: D1Database, nda: NdaRow): Promise<StoredDoc | null> {
  const existing = await storedDoc(db, nda.id, 'termination');
  if (existing) return existing;
  if (nda.status !== 'terminated' || !nda.terminated_at) return null;
  const v = await approvedVersion(db, nda.id);
  const snap = v ? parseSnapshot(v) : null;
  if (!v || !snap) return null;
  const pdf = await renderTerminationPdf(nda, snap);
  await db
    .prepare('INSERT OR IGNORE INTO nda_documents (nda_id, version_id, kind, sha256, pdf, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(nda.id, v.id, 'termination', await bytesHash(pdf), pdf, nowSec())
    .run();
  return storedDoc(db, nda.id, 'termination');
}

export function pdfFilename(nda: Pick<NdaRow, 'number'>, version: number, suffix = ''): string {
  return `Fortrolighedsaftale-${nda.number}-v${version}${suffix}.pdf`;
}

export function pdfResponse(pdf: Uint8Array, filename: string, inline: boolean): Response {
  return new Response(pdf, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

// ---------- Mails ----------

export type MailKind =
  | 'customer_receipt'
  | 'staff_customer_approved'
  | 'final'
  | 'termination_notice'
  | 'termination_receipt'
  | 'request_received'
  | 'staff_request'
  | 'request_result';

export const MAIL_LABEL: Record<MailKind, string> = {
  customer_receipt: 'Kvittering for kundens godkendelse',
  staff_customer_approved: 'Besked til Veyro: kunden har godkendt',
  final: 'Endelig kvittering med PDF',
  termination_notice: 'Skriftlig meddelelse om ophør til den anden part',
  termination_receipt: 'Kvittering for ophør',
  request_received: 'Kvittering for anmodning',
  staff_request: 'Besked til Veyro: ny anmodning',
  request_result: 'Resultat af anmodning',
};

export const MAIL_STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'err' | 'neutral' }> = {
  pending: { label: 'Sendes', tone: 'neutral' },
  sent: { label: 'Afleveret til mailudbyderen', tone: 'ok' },
  failed: { label: 'Fejlede', tone: 'err' },
  not_configured: { label: 'Ikke sendt – mailintegration mangler', tone: 'warn' },
};

export interface MailRow {
  id: number;
  nda_id: number | null;
  request_id: number | null;
  kind: MailKind;
  recipient: string;
  status: 'pending' | 'sent' | 'failed' | 'not_configured';
  attempts: number;
  last_error: string | null;
  created_at: number;
  sent_at: number | null;
}

export async function queueMail(db: D1Database, args: { ndaId?: number | null; requestId?: number | null; kind: MailKind; to: string }): Promise<number> {
  const r = await db
    .prepare('INSERT INTO nda_mails (nda_id, request_id, kind, recipient, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id')
    .bind(args.ndaId ?? null, args.requestId ?? null, args.kind, args.to, nowSec())
    .first<{ id: number }>();
  return r!.id;
}

export async function listMails(db: D1Database, ndaId: number): Promise<MailRow[]> {
  const { results } = await db.prepare('SELECT * FROM nda_mails WHERE nda_id = ? ORDER BY id').bind(ndaId).all<MailRow>();
  return results;
}

export async function listFailedMails(db: D1Database): Promise<(MailRow & { number: string | null })[]> {
  const { results } = await db
    .prepare("SELECT m.*, n.number FROM nda_mails m LEFT JOIN ndas n ON n.id = m.nda_id WHERE m.status IN ('failed', 'not_configured') ORDER BY m.id DESC LIMIT 100")
    .all<MailRow & { number: string | null }>();
  return results;
}

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function wrap(inner: string): string {
  return `<!doctype html><html lang="da"><body style="margin:0;background:#F4F2EC;font-family:'Inter Tight',-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0F0F0D">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F2EC;padding:32px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FBFAF7;border-radius:18px;padding:32px">
<tr><td style="font-size:20px;font-weight:700;letter-spacing:-0.02em;padding-bottom:24px">Veyro<span style="color:#FF5A1F">.</span></td></tr>
<tr><td style="font-size:16px;line-height:1.55">${inner}</td></tr>
</table>
<p style="font-size:12px;color:#55534D;margin-top:16px">Veyro · veyro.dk</p>
</td></tr></table></body></html>`;
}

function message(subject: string, paras: string[], facts: [string, string][], link?: { href: string; label: string }): Omit<EmailMessage, 'to'> {
  const text = [...paras, '', ...facts.map(([k, v]) => `${k}: ${v}`), ...(link ? ['', `${link.label}: ${link.href}`] : []), '', 'Venlig hilsen', 'Veyro'].join('\n');
  const html = wrap(
    paras.map((p) => `<p style="margin:0 0 16px;white-space:pre-wrap">${escapeHtml(p)}</p>`).join('') +
      (facts.length
        ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px;font-size:15px">${facts
            .map(([k, v]) => `<tr><td style="color:#55534D;padding:3px 16px 3px 0;vertical-align:top">${escapeHtml(k)}</td><td style="padding:3px 0;font-weight:600">${escapeHtml(v)}</td></tr>`)
            .join('')}</table>`
        : '') +
      (link
        ? `<p style="margin:0 0 24px"><a href="${escapeHtml(link.href)}" style="display:inline-block;background:#0F0F0D;color:#FBFAF7;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600">${escapeHtml(link.label)}</a></p>`
        : ''),
  );
  return { subject, text, html };
}

type Built = Omit<EmailMessage, 'to'> & { attachments?: EmailAttachment[] };

async function buildRequestMail(env: Env, m: MailRow): Promise<Built | null> {
  const app = env.APP_URL.replace(/\/+$/, '');
  const req = await env.DB.prepare('SELECT * FROM nda_requests WHERE id = ?').bind(m.request_id).first<RequestRow>();
  if (!req) return null;
  const facts: [string, string][] = [
    ['Aftale', req.nda_label],
    ['Anmodning', REQUEST_KIND_LABEL[req.kind]],
    ['Status', REQUEST_STATUS_LABEL[req.status]],
  ];
  const link = { href: `${app}/konto/nda/anmodninger/${req.id}`, label: 'Følg anmodningen i kundeportalen' };
  if (m.kind === 'staff_request') {
    return message(`Ny anmodning om fortrolighedsaftale ${req.nda_label}`, ['En kunde har sendt en anmodning. Behandl den i admin.'], facts, {
      href: `${app}/admin/nda/anmodninger/${req.id}`,
      label: 'Åbn i admin',
    });
  }
  if (m.kind === 'request_received') {
    return message(
      `Vi har modtaget din anmodning (${req.nda_label})`,
      [
        'Hej',
        `Vi har modtaget din anmodning: ${REQUEST_KIND_LABEL[req.kind].toLowerCase()}. Du kan følge status i kundeportalen og får besked, når den er behandlet.`,
        req.kind === 'delete_document'
          ? 'Sletning af aftaledokumentet ophæver ikke aftalens forpligtelser.'
          : 'Anmodningen behandles efter fortrolighedsaftalens punkt 4 og en eventuel databehandleraftale.',
      ],
      facts,
      link,
    );
  }
  const paras = ['Hej', `Vi har behandlet din anmodning om ${REQUEST_KIND_LABEL[req.kind].toLowerCase()} for fortrolighedsaftale ${req.nda_label}.`, req.result_text ?? ''];
  if (req.status === 'retained') {
    paras.push(
      `Oplysninger, der beholdes: ${req.retained_info}`,
      `Begrundelse: ${req.retention_reason}`,
      `Slettefrist: ${req.retain_until ? fmtTime(req.retain_until).replace(/ kl\..*$/, '') : '–'}`,
    );
  }
  if (req.kind === 'delete_document') paras.push('Sletning af aftaledokumentet ophæver ikke aftalens forpligtelser. PDF\'er, du selv har downloadet eller fået på mail, skal du selv slette.');
  return message(`Resultat af din anmodning (${req.nda_label}): ${REQUEST_STATUS_LABEL[req.status].toLowerCase()}`, paras, facts, link);
}

/** Bygger mailens indhold ud fra de gemte data. Returnerer null, hvis grundlaget ikke findes længere. */
async function buildMail(env: Env, m: MailRow): Promise<Built | null> {
  if (m.request_id) return buildRequestMail(env, m);
  const app = env.APP_URL.replace(/\/+$/, '');
  const nda = m.nda_id ? await getNda(env.DB, m.nda_id) : null;
  if (!nda) return null;
  const sent = await env.DB.prepare("SELECT * FROM nda_versions WHERE nda_id = ? AND state IN ('sent', 'approved') ORDER BY version DESC LIMIT 1")
    .bind(nda.id)
    .first<VersionRow>();
  const snap = sent ? parseSnapshot(sent) : null;
  if (!sent || !snap) return null;
  const link = { href: `${app}/konto/nda/${nda.id}`, label: 'Åbn aftalen i kundeportalen' };
  const adminLink = { href: `${app}/admin/nda/${nda.id}`, label: 'Åbn i admin' };
  const testNote = snap.test ? [`${snap.test}: Dette er en testaftale og er ikke gyldig.`] : [];
  const base: [string, string][] = [
    ['Aftale', label(nda, sent)],
    ['Kunde', snap.customer.company_name],
    ['Projekt', snap.project.length > 120 ? `${snap.project.slice(0, 117)}…` : snap.project],
  ];

  if (m.kind === 'customer_receipt') {
    const waiting = !sent.veyro_approved_at;
    return message(
      `Kvittering: du har godkendt fortrolighedsaftale ${nda.number}${waiting ? ' – afventer Veyro' : ''}`,
      [
        'Hej',
        ...testNote,
        `Tak. ${sent.customer_name}, ${sent.customer_title}, har godkendt fortrolighedsaftale ${label(nda, sent)} på vegne af ${snap.customer.company_name}.`,
        waiting
          ? 'Aftalen AFVENTER VEYRO og er ikke gældende endnu. Den træder i kraft, når Veyro også har godkendt den samme version. Du får en endelig kvittering med hele aftalen som PDF, når det sker.'
          : 'Begge parter har nu godkendt aftalen. Du får en endelig kvittering med PDF i en separat mail.',
      ],
      [...base, ['Din godkendelse', fmtTime(sent.customer_approved_at)], ['Status', STATUS_LABEL[nda.status]]],
      link,
    );
  }
  if (m.kind === 'staff_customer_approved') {
    return message(
      `Fortrolighedsaftale ${nda.number} er godkendt af kunden – afventer Veyro`,
      ['Kunden har godkendt fortrolighedsaftalen. Den bliver først aktiv, når en Veyro-medarbejder med godkenderrollen har godkendt den samme version i admin.'],
      [...base, ['Kundens godkendelse', fmtTime(sent.customer_approved_at)]],
      adminLink,
    );
  }
  if (m.kind === 'final') {
    const doc = await ensureFinalDocument(env.DB, nda);
    if (!doc) return null;
    const msg = message(
      `Fortrolighedsaftale ${nda.number} er godkendt af begge parter`,
      [
        'Hej',
        ...testNote,
        `Fortrolighedsaftale ${label(nda, sent)} mellem ${snap.customer.company_name} og ${snap.veyro.legal_name} er nu godkendt af begge parter og er trådt i kraft.`,
        'Hele den godkendte aftale er vedhæftet som PDF. Den ligger også i kundeportalen under Aftaler og dokumenter.',
      ],
      [
        ...base,
        ['Kundens godkendelse', `${sent.customer_name}, ${sent.customer_title} – ${fmtTime(sent.customer_approved_at)}`],
        ['Veyros godkendelse', `${sent.veyro_name}, ${sent.veyro_title} – ${fmtTime(sent.veyro_approved_at)}`],
        ['Ikrafttræden', fmtTime(nda.effective_at)],
      ],
      m.recipient === snap.veyro.contact_email ? adminLink : link,
    );
    return { ...msg, attachments: [{ filename: pdfFilename(nda, sent.version), content: base64(doc.pdf) }] };
  }
  if (m.kind === 'termination_notice') {
    const toVeyro = nda.terminated_party === 'kunde';
    return message(
      `Meddelelse: fortrolighedsaftale ${nda.number} afsluttes for fremtidig udveksling`,
      [
        toVeyro ? 'Til Veyro' : `Til ${snap.customer.company_name}`,
        ...testNote,
        nda.termination_notice ?? '',
        CONTINUING_TEXT,
      ],
      [...base, ['Registreret', fmtTime(nda.terminated_at)], ['Registreret af', nda.terminated_by ?? '']],
      toVeyro ? adminLink : link,
    );
  }
  if (m.kind === 'termination_receipt') {
    const doc = await ensureTerminationDocument(env.DB, nda);
    const msg = message(
      `Kvittering: fortrolighedsaftale ${nda.number} er afsluttet for fremtidig udveksling`,
      [
        'Hej',
        ...testNote,
        `Afslutningen af fortrolighedsaftale ${nda.number} for fremtidig udveksling er registreret.`,
        CONTINUING_TEXT,
        'Kvitteringen dokumenterer registreringen. Om meddelelsen til den anden part er leveret, kan du se i portalen.',
      ],
      [...base, ['Registreret', fmtTime(nda.terminated_at)], ['Status', STATUS_LABEL.terminated]],
      nda.terminated_party === 'veyro' ? adminLink : link,
    );
    return doc ? { ...msg, attachments: [{ filename: pdfFilename(nda, sent.version, '-ophoer'), content: base64(doc.pdf) }] } : msg;
  }
  return null;
}

/** Ophørsmeddelelser, der ikke kunne leveres, bliver til en opgave for Veyro. */
async function taskOnFailure(env: Env, m: MailRow, why: string): Promise<void> {
  if (m.kind !== 'termination_notice' || !m.nda_id) return;
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO nda_tasks (nda_id, mail_id, kind, note, created_at) VALUES (?, ?, ?, ?, ?)').bind(
      m.nda_id,
      m.id,
      'notice_failed',
      `Ophørsmeddelelsen til ${m.recipient} kunne ikke leveres (${why}). Send meddelelsen igen, eller giv den anden part skriftlig besked på anden vis, og registrér det her.`,
      nowSec(),
    ),
    eventStmt(env.DB, m.nda_id, 'system', 'mail_failed', MAIL_LABEL[m.kind]),
  ]);
}

/**
 * Sender én mail. Status gemmes ærligt: "afleveret" kun når mailudbyderen har modtaget den,
 * "ikke sendt – mailintegration mangler", hvis der ingen nøgle er.
 */
export async function deliverMail(env: Env, id: number): Promise<MailRow['status']> {
  const m = await env.DB.prepare('SELECT * FROM nda_mails WHERE id = ?').bind(id).first<MailRow>();
  if (!m || m.status === 'sent') return m?.status ?? 'failed';
  if (!env.RESEND_API_KEY) {
    await env.DB.prepare("UPDATE nda_mails SET status = 'not_configured', last_error = 'RESEND_API_KEY mangler' WHERE id = ?").bind(id).run();
    await taskOnFailure(env, m, 'mailintegrationen er ikke sat op');
    return 'not_configured';
  }
  // Lås: kun én afsendelse ad gangen
  const lock = await env.DB.prepare(
    "UPDATE nda_mails SET attempts = attempts + 1, status = 'pending' WHERE id = ? AND status != 'sent' AND (status != 'pending' OR attempts = ?) RETURNING attempts",
  )
    .bind(id, m.attempts)
    .first<{ attempts: number }>();
  if (!lock) return 'pending';
  try {
    const content = await buildMail(env, m);
    if (!content) {
      await env.DB.prepare("UPDATE nda_mails SET status = 'failed', last_error = 'Grundlaget findes ikke længere' WHERE id = ?").bind(id).run();
      return 'failed';
    }
    await sendEmail(env, { to: m.recipient, ...content });
    await env.DB.prepare("UPDATE nda_mails SET status = 'sent', sent_at = ?, last_error = NULL WHERE id = ?").bind(nowSec(), id).run();
    return 'sent';
  } catch (err) {
    const msg = String((err as Error).message ?? err).slice(0, 200);
    await env.DB.prepare("UPDATE nda_mails SET status = 'failed', last_error = ? WHERE id = ?").bind(msg, id).run();
    await taskOnFailure(env, m, msg);
    await logError(env.DB, `NDA-mail ${m.kind}`, err);
    return 'failed';
  }
}

export async function deliverAll(env: Env, ids: number[]): Promise<void> {
  for (const id of ids) await deliverMail(env, id);
}

/** Genforsøg (cron): fejlede mails op til 6 forsøg, og mails, der ventede på mailintegrationen. */
export async function retryMails(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM nda_mails WHERE (status = 'failed' AND attempts < 6)
       OR (status = 'pending' AND created_at < ?)
       OR (status = 'not_configured' AND ? = 1)
     ORDER BY id LIMIT 50`,
  )
    .bind(nowSec() - 600, env.RESEND_API_KEY ? 1 : 0)
    .all<{ id: number }>();
  for (const r of results) await deliverMail(env, r.id);
}

/** Sender en eksisterende mail igen (fx fra admin) uden at oprette noget nyt. */
export async function resendMail(env: Env, id: number): Promise<MailRow['status']> {
  await env.DB.prepare("UPDATE nda_mails SET status = 'failed' WHERE id = ? AND status != 'pending'").bind(id).run();
  return deliverMail(env, id);
}

/** Hvem modtager kundens mails: kontaktpersonen og (hvis en anden) den konto, der godkendte. */
export function customerRecipients(snap: Snapshot, v: Pick<VersionRow, 'customer_email'> | null, accountEmail: string): string[] {
  return [...new Set([snap.customer.contact_email, v?.customer_email ?? accountEmail].filter(Boolean).map((e) => e.toLowerCase()))];
}

/** Køer og sender de endelige kvitteringer, når aftalen er blevet aktiv. */
export async function onActivated(env: Env, nda: NdaRow, snap: Snapshot, accountEmail: string): Promise<number[]> {
  try {
    await ensureFinalDocument(env.DB, nda);
  } catch (err) {
    await logError(env.DB, 'NDA PDF', err);
  }
  const v = await approvedVersion(env.DB, nda.id);
  const ids: number[] = [];
  for (const to of customerRecipients(snap, v, accountEmail)) ids.push(await queueMail(env.DB, { ndaId: nda.id, kind: 'final', to }));
  ids.push(await queueMail(env.DB, { ndaId: nda.id, kind: 'final', to: snap.veyro.contact_email }));
  return ids;
}

/** Meddelelse til den anden part og kvittering til den, der afsluttede. */
export async function onTerminated(env: Env, nda: NdaRow, snap: Snapshot, customerAccount: string): Promise<number[]> {
  try {
    await ensureTerminationDocument(env.DB, nda);
  } catch (err) {
    await logError(env.DB, 'NDA ophør PDF', err);
  }
  const v = await approvedVersion(env.DB, nda.id);
  const customer = customerRecipients(snap, v, customerAccount);
  const ids: number[] = [];
  if (nda.terminated_party === 'kunde') {
    ids.push(await queueMail(env.DB, { ndaId: nda.id, kind: 'termination_notice', to: snap.veyro.contact_email }));
    for (const to of customer) ids.push(await queueMail(env.DB, { ndaId: nda.id, kind: 'termination_receipt', to }));
  } else {
    for (const to of customer) ids.push(await queueMail(env.DB, { ndaId: nda.id, kind: 'termination_notice', to }));
    ids.push(await queueMail(env.DB, { ndaId: nda.id, kind: 'termination_receipt', to: snap.veyro.contact_email }));
  }
  return ids;
}

