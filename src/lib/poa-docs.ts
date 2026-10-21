// Gemte fuldmagtsdokumenter og mails (kvitteringer og beskeder til Veyro) med genforsøg.
import type { Env } from '../env';
import { nowSec, sha256Hex } from './crypto';
import { escapeHtml, sendEmail, type EmailAttachment, type EmailMessage } from './email';
import { logError } from './errlog';
import { formatDay, getPoa, label, parseSnapshot, REVOKE_GUIDE, STATUS_LABEL, type PoaRow } from './poa';
import { fmtTime, renderPoaPdf, type DocKind } from './poa-pdf';

// ---------- Dokumenter ----------

function toBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  throw new Error('Ukendt dokumentformat');
}

export interface StoredDoc {
  kind: DocKind;
  sha256: string;
  pdf: Uint8Array;
  created_at: number;
}

/**
 * Henter det gemte dokument. Findes det ikke endnu (fx hvis lagringen fejlede lige efter godkendelsen),
 * laves det én gang ud fra den gemte, godkendte version og gemmes.
 */
export async function ensureDocument(db: D1Database, poa: PoaRow, kind: DocKind): Promise<StoredDoc | null> {
  const row = await db
    .prepare('SELECT kind, sha256, pdf, created_at FROM poa_documents WHERE poa_id = ? AND kind = ?')
    .bind(poa.id, kind)
    .first<{ kind: DocKind; sha256: string; pdf: unknown; created_at: number }>();
  if (row) return { ...row, pdf: toBytes(row.pdf) };
  const snap = parseSnapshot(poa);
  if (!snap || !poa.content_hash || !poa.approved_at) return null;
  if (kind === 'activated' && !poa.activated_at) return null;
  const pdf = await renderPoaPdf(snap, poa, kind, poa.content_hash);
  const sha = await sha256Hex(Array.from(pdf, (b) => String.fromCharCode(b)).join(''));
  const now = nowSec();
  // INSERT OR IGNORE: laves dokumentet samtidig to steder, vinder det første, og begge bruger det
  await db
    .prepare('INSERT OR IGNORE INTO poa_documents (poa_id, kind, sha256, pdf, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(poa.id, kind, sha, pdf, now)
    .run();
  return ensureDocumentStored(db, poa.id, kind);
}

async function ensureDocumentStored(db: D1Database, poaId: number, kind: DocKind): Promise<StoredDoc | null> {
  const row = await db
    .prepare('SELECT kind, sha256, pdf, created_at FROM poa_documents WHERE poa_id = ? AND kind = ?')
    .bind(poaId, kind)
    .first<{ kind: DocKind; sha256: string; pdf: unknown; created_at: number }>();
  return row ? { ...row, pdf: toBytes(row.pdf) } : null;
}

/** Det dokument, der gælder nu: med Veyros accept, hvis det findes, ellers det kunden godkendte. */
export async function currentDocument(db: D1Database, poa: PoaRow): Promise<StoredDoc | null> {
  if (poa.activated_at && poa.snapshot_json && parseSnapshot(poa)?.requires_veyro_acceptance) {
    const d = await ensureDocument(db, poa, 'activated');
    if (d) return d;
  }
  return ensureDocument(db, poa, 'approved');
}

export function pdfFilename(poa: Pick<PoaRow, 'number' | 'version'>, suffix = ''): string {
  return `Fuldmagt-${poa.number}${poa.version > 1 ? `-v${poa.version}` : ''}${suffix}.pdf`;
}

// ---------- Mails ----------

export type MailKind = 'receipt' | 'activated' | 'revoked' | 'deletion_result' | 'staff_approved' | 'staff_revoked' | 'staff_deletion';

export const MAIL_LABEL: Record<MailKind, string> = {
  receipt: 'Kvittering for godkendelse',
  activated: 'Besked om aktiv fuldmagt',
  revoked: 'Kvittering for tilbagekaldelse',
  deletion_result: 'Kvittering for sletning',
  staff_approved: 'Besked til Veyro: ny fuldmagt',
  staff_revoked: 'Besked til Veyro: tilbagekaldelse',
  staff_deletion: 'Besked til Veyro: sletteanmodning',
};

export const MAIL_STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'err' | 'neutral' }> = {
  pending: { label: 'Sendes', tone: 'neutral' },
  sent: { label: 'Sendt', tone: 'ok' },
  failed: { label: 'Fejlede – prøves igen', tone: 'err' },
  not_configured: { label: 'Ikke sendt – mailintegration mangler', tone: 'warn' },
};

export interface MailRow {
  id: number;
  poa_id: number | null;
  deletion_request_id: number | null;
  kind: MailKind;
  recipient: string;
  status: 'pending' | 'sent' | 'failed' | 'not_configured';
  attempts: number;
  last_error: string | null;
  created_at: number;
  sent_at: number | null;
}

export async function queueMail(
  db: D1Database,
  args: { poaId?: number | null; deletionRequestId?: number | null; kind: MailKind; to: string },
): Promise<number> {
  const r = await db
    .prepare('INSERT INTO poa_mails (poa_id, deletion_request_id, kind, recipient, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id')
    .bind(args.poaId ?? null, args.deletionRequestId ?? null, args.kind, args.to, nowSec())
    .first<{ id: number }>();
  return r!.id;
}

export async function listMails(db: D1Database, poaId: number): Promise<MailRow[]> {
  const { results } = await db.prepare('SELECT * FROM poa_mails WHERE poa_id = ? ORDER BY id').bind(poaId).all<MailRow>();
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
  const text = [
    ...paras,
    '',
    ...facts.map(([k, v]) => `${k}: ${v}`),
    ...(link ? ['', `${link.label}: ${link.href}`] : []),
    '',
    'Venlig hilsen',
    'Veyro',
  ].join('\n');
  const html = wrap(
    paras.map((p) => `<p style="margin:0 0 16px">${escapeHtml(p)}</p>`).join('') +
      `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px;font-size:15px">${facts
        .map(([k, v]) => `<tr><td style="color:#55534D;padding:3px 16px 3px 0;vertical-align:top">${escapeHtml(k)}</td><td style="padding:3px 0;font-weight:600">${escapeHtml(v)}</td></tr>`)
        .join('')}</table>` +
      (link
        ? `<p style="margin:0 0 24px"><a href="${escapeHtml(link.href)}" style="display:inline-block;background:#0F0F0D;color:#FBFAF7;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600">${escapeHtml(link.label)}</a></p>`
        : ''),
  );
  return { subject, text, html };
}

/** Bygger mailens indhold ud fra de gemte data. Returnerer null, hvis grundlaget ikke findes længere. */
async function buildMail(env: Env, m: MailRow): Promise<(Omit<EmailMessage, 'to'> & { attachments?: EmailAttachment[] }) | null> {
  const app = env.APP_URL.replace(/\/+$/, '');
  if (m.kind === 'deletion_result') {
    const req = await env.DB.prepare('SELECT poa_label, status, result_text FROM poa_deletion_requests WHERE id = ?')
      .bind(m.deletion_request_id)
      .first<{ poa_label: string; status: string; result_text: string | null }>();
    if (!req) return null;
    return message(
      `Sletning af fuldmagt ${req.poa_label}: ${req.status === 'completed' ? 'gennemført' : 'delvist gennemført'}`,
      [
        'Hej',
        `Vi har behandlet din anmodning om sletning af fuldmagt ${req.poa_label}.`,
        req.result_text ?? '',
        "Sletning i Veyros system fjerner ikke PDF'er, du allerede har downloadet eller fået på mail. Dem skal du selv slette.",
      ],
      [],
      { href: `${app}/konto/fuldmagter`, label: 'Se fuldmagter i kundeportalen' },
    );
  }
  const poa = m.poa_id ? await getPoa(env.DB, m.poa_id) : null;
  const snap = poa ? parseSnapshot(poa) : null;
  if (!poa || !snap) return null;
  const link = { href: `${app}/konto/fuldmagter/${poa.id}`, label: 'Åbn fuldmagten i kundeportalen' };
  const adminLink = { href: `${app}/admin/fuldmagter/${poa.id}`, label: 'Åbn i admin' };
  const base: [string, string][] = [
    ['Fuldmagtsnummer', label(poa)],
    ['Virksomhed', snap.customer.company_name],
  ];
  const expiry: [string, string] = ['Udløbsdato', snap.scope.expires_on ? formatDay(snap.scope.expires_on) : 'Ingen'];
  const testNote = snap.test ? [`${snap.test}: Dette er en testfuldmagt og er ikke gyldig.`] : [];

  if (m.kind === 'receipt') {
    const doc = await ensureDocument(env.DB, poa, 'approved');
    if (!doc) return null;
    const pending = poa.status === 'pending' || (snap.requires_veyro_acceptance && !poa.veyro_accepted_at && poa.status !== 'active');
    const msg = message(
      `Kvittering: fuldmagt ${label(poa)} er godkendt${pending ? ' og afventer Veyros accept' : ''}`,
      [
        'Hej',
        ...testNote,
        `Tak. Fuldmagten er godkendt af ${snap.approver.name}, ${snap.approver.title}.`,
        pending
          ? 'Fuldmagten afventer Veyros accept og er IKKE aktiv endnu. Du får en ny besked, når den bliver aktiv.'
          : 'Fuldmagten er aktiv.',
        'Hele fuldmagten er vedhæftet som PDF.',
        REVOKE_GUIDE,
      ],
      [...base, ['Godkendt', fmtTime(poa.approved_at)], ['Status', pending ? 'Afventer godkendelse (Veyros accept)' : STATUS_LABEL[poa.status]], expiry],
      link,
    );
    return { ...msg, attachments: [{ filename: pdfFilename(poa), content: base64(doc.pdf) }] };
  }
  if (m.kind === 'activated') {
    const doc = await currentDocument(env.DB, poa);
    if (!doc) return null;
    const msg = message(
      `Fuldmagt ${label(poa)} er nu aktiv`,
      ['Hej', ...testNote, 'Veyro har accepteret fuldmagten, og den er nu aktiv. Den opdaterede fuldmagt med Veyros accept er vedhæftet som PDF.', REVOKE_GUIDE],
      [...base, ['Aktiv fra', fmtTime(poa.activated_at)], ['Status', STATUS_LABEL[poa.status]], expiry],
      link,
    );
    return { ...msg, attachments: [{ filename: pdfFilename(poa, '-aktiv'), content: base64(doc.pdf) }] };
  }
  if (m.kind === 'revoked') {
    return message(
      `Kvittering: fuldmagt ${label(poa)} er tilbagekaldt`,
      [
        'Hej',
        ...testNote,
        'Fuldmagten er tilbagekaldt. Veyro kan ikke længere udføre nye handlinger under den. Allerede gennemførte handlinger annulleres ikke automatisk.',
        'Veyro har fået besked og følger op på eventuelle adgange og igangværende opgaver. Har I selv givet fuldmagten til andre, skal I selv orientere dem.',
        'Den oprindelige PDF er bevaret i kundeportalen som historisk dokument.',
      ],
      [...base, ['Tilbagekaldt', fmtTime(poa.revoked_at)], ['Status', STATUS_LABEL[poa.status]]],
      link,
    );
  }
  const customer = await env.DB.prepare('SELECT email FROM customers WHERE id = ?').bind(poa.customer_id).first<{ email: string }>();
  const who: [string, string] = ['Kundekonto', customer?.email ?? '–'];
  if (m.kind === 'staff_approved') {
    return message(
      `Fuldmagt ${label(poa)} godkendt af kunden${poa.status === 'pending' ? ' – afventer Veyros accept' : ''}`,
      [poa.status === 'pending' ? 'En kunde har godkendt en fuldmagt. Den bliver først aktiv, når Veyro accepterer den i admin.' : 'En kunde har godkendt en fuldmagt.'],
      [...base, who, ['Status', STATUS_LABEL[poa.status]], expiry],
      adminLink,
    );
  }
  if (m.kind === 'staff_revoked') {
    return message(
      `Fuldmagt ${label(poa)} er tilbagekaldt af kunden`,
      [
        'Kunden har tilbagekaldt fuldmagten. Den er spærret i systemet med det samme, og planlagte handlinger er stoppet.',
        'Følg op på eksterne adgange, igangværende opgaver og underretning af leverandører i admin.',
      ],
      [...base, who, ['Tilbagekaldt', fmtTime(poa.revoked_at)]],
      adminLink,
    );
  }
  return message(
    `Sletteanmodning: fuldmagt ${label(poa)}`,
    ['Kunden har anmodet om sletning af fuldmagten. Behandl anmodningen i admin.'],
    [...base, who],
    adminLink,
  );
}

/**
 * Sender én mail. Status gemmes ærligt: "sendt" kun når Resend har modtaget den,
 * "ikke sendt – mailintegration mangler", hvis der ingen nøgle er.
 */
export async function deliverMail(env: Env, id: number): Promise<MailRow['status']> {
  const m = await env.DB.prepare('SELECT * FROM poa_mails WHERE id = ?').bind(id).first<MailRow>();
  if (!m || m.status === 'sent') return m?.status ?? 'failed';
  if (!env.RESEND_API_KEY) {
    await env.DB.prepare("UPDATE poa_mails SET status = 'not_configured', last_error = 'RESEND_API_KEY mangler' WHERE id = ?").bind(id).run();
    return 'not_configured';
  }
  // Lås: kun én afsendelse ad gangen (samme mail sendes ikke to gange ved samtidige forsøg)
  const lock = await env.DB.prepare(
    "UPDATE poa_mails SET attempts = attempts + 1, status = 'pending' WHERE id = ? AND status != 'sent' AND (status != 'pending' OR attempts = ? ) RETURNING attempts",
  )
    .bind(id, m.attempts)
    .first<{ attempts: number }>();
  if (!lock) return 'pending';
  try {
    const content = await buildMail(env, m);
    if (!content) {
      await env.DB.prepare("UPDATE poa_mails SET status = 'failed', last_error = 'Grundlaget findes ikke længere' WHERE id = ?").bind(id).run();
      return 'failed';
    }
    await sendEmail(env, { to: m.recipient, ...content });
    await env.DB.prepare("UPDATE poa_mails SET status = 'sent', sent_at = ?, last_error = NULL WHERE id = ?").bind(nowSec(), id).run();
    return 'sent';
  } catch (err) {
    await env.DB.prepare("UPDATE poa_mails SET status = 'failed', last_error = ? WHERE id = ?").bind(String((err as Error).message ?? err).slice(0, 200), id).run();
    await logError(env.DB, `Fuldmagt-mail ${m.kind}`, err);
    return 'failed';
  }
}

export async function deliverAll(env: Env, ids: number[]): Promise<void> {
  for (const id of ids) await deliverMail(env, id);
}

/** Genforsøg (cron): fejlede mails op til 6 forsøg, og mails, der ventede på mailintegrationen. */
export async function retryMails(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM poa_mails WHERE (status = 'failed' AND attempts < 6)
       OR (status = 'pending' AND created_at < ?)
       OR (status = 'not_configured' AND ? = 1)
     ORDER BY id LIMIT 50`,
  )
    .bind(nowSec() - 600, env.RESEND_API_KEY ? 1 : 0)
    .all<{ id: number }>();
  for (const r of results) await deliverMail(env, r.id);
}

/** Sætter en mail til at blive sendt igen (fx fra admin) uden at oprette noget nyt. */
export async function resendMail(env: Env, id: number): Promise<MailRow['status']> {
  await env.DB.prepare("UPDATE poa_mails SET status = 'failed' WHERE id = ? AND status != 'pending'").bind(id).run();
  return deliverMail(env, id);
}
