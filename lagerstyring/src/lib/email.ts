// E-mail via Resend. Er der ingen RESEND_API_KEY, sendes intet: beskeden gemmes som "simuleret",
// og det står tydeligt i systemet, at den ikke er sendt.
//
// I en demo (DEMO_MODE=1) kan alle logge ind som ejer med ét klik og oprette brugere med en hvilken
// som helst adresse. Derfor sendes der i demoen kun til Veyros egne adresser i ADMIN_EMAILS; alt
// andet (fx demobrugerne @nordlysbyg.example) simuleres, så demoen ikke kan bruges til at sende mails
// fra Veyros domæne til fremmede.

import type { Env } from '../env';
import { nowSec } from './crypto';
import { parseAdminEmails } from './session';
import type { Settings } from './settings';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type DeliveryStatus = 'sendt' | 'simuleret' | 'fejlet';

export function emailConfigured(env: Env, to?: string): boolean {
  if (!env.RESEND_API_KEY) return false;
  if (env.DEMO_MODE === '1') return !!to && parseAdminEmails(env).has(to.toLowerCase());
  return true;
}

/** Sender via Resends HTTP API. Kaster ved fejl. */
export async function sendEmail(env: Env, msg: EmailMessage, s: Settings): Promise<void> {
  const base = (env.RESEND_API_BASE || 'https://api.resend.com').replace(/\/+$/, '');
  const from = env.EMAIL_FROM || `${s.company_name} <onboarding@resend.dev>`;
  const res = await fetch(`${base}/emails`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }),
  });
  if (!res.ok) {
    // Log kun status, ikke modtager eller indhold
    console.error(`Resend-fejl: HTTP ${res.status}`);
    throw new Error('E-mail kunne ikke sendes');
  }
}

/**
 * Sender (eller simulerer) og gemmer beskeden i loggen. Returnerer den faktiske status, så
 * brugeren aldrig får at vide, at en e-mail er sendt, hvis den ikke er det.
 */
export async function deliver(
  env: Env,
  s: Settings,
  msg: EmailMessage,
  meta: { kind: string; actor: string; list_id?: number | null; list_version?: number | null },
): Promise<{ id: number; status: DeliveryStatus }> {
  let status: DeliveryStatus = 'simuleret';
  if (emailConfigured(env, msg.to)) {
    try {
      await sendEmail(env, msg, s);
      status = 'sendt';
    } catch {
      status = 'fejlet';
    }
  }
  const row = await env.DB.prepare(
    `INSERT INTO mails (kind, recipient, subject, body_text, status, list_id, list_version, actor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(meta.kind, msg.to, msg.subject, msg.text, status, meta.list_id ?? null, meta.list_version ?? null, meta.actor, nowSec())
    .first<{ id: number }>();
  return { id: row!.id, status };
}

export const DELIVERY_LABEL: Record<DeliveryStatus, string> = {
  sendt: 'Sendt',
  simuleret: 'Simuleret (ikke sendt)',
  fejlet: 'Fejlede (ikke sendt)',
};

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function accentOf(s: Settings): string {
  return /^#[0-9a-fA-F]{6}$/.test(s.accent_color) ? s.accent_color : '#FF5A1F';
}

export function wrapHtml(s: Settings, inner: string): string {
  return `<!doctype html><html lang="da"><body style="margin:0;background:#F4F2EC;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0F0F0D">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F2EC;padding:32px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#FBFAF7;border-radius:14px;padding:28px;border-top:4px solid ${accentOf(s)}">
<tr><td style="font-size:18px;font-weight:700;padding-bottom:16px">${escapeHtml(s.company_name)}</td></tr>
<tr><td style="font-size:15px;line-height:1.55">${inner}</td></tr>
</table>
</td></tr></table></body></html>`;
}

export function button(s: Settings, href: string, label: string): string {
  return `<p style="margin:20px 0 4px"><a href="${escapeHtml(href)}" style="display:inline-block;background:${accentOf(s)};color:#0F0F0D;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:600">${escapeHtml(label)}</a></p>`;
}

/** Simpel tabel til e-mails: første række er overskrifter. */
export function table(rows: string[][], alignRight: number[] = []): { html: string; text: string } {
  const [head, ...body] = rows;
  const td = (v: string, i: number, th = false) =>
    `<${th ? 'th' : 'td'} align="${alignRight.includes(i) ? 'right' : 'left'}" style="padding:6px 8px;border-bottom:1px solid #E2DFD6;font-size:13.5px;${th ? 'color:#55534D;font-weight:500' : ''}">${escapeHtml(v)}</${th ? 'th' : 'td'}>`;
  const html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:8px 0">
<tr>${head!.map((v, i) => td(v, i, true)).join('')}</tr>${body.map((r) => `<tr>${r.map((v, i) => td(v, i)).join('')}</tr>`).join('')}</table>`;
  const text = body.map((r) => r.map((v, i) => `${head![i]}: ${v}`).join(' · ')).join('\n');
  return { html, text };
}

export function inviteEmail(link: string, invitedBy: string, s: Settings): Omit<EmailMessage, 'to'> {
  return {
    subject: `Du er inviteret til ${s.company_name}`,
    text: `${invitedBy} har givet dig adgang til ${s.company_name}s lager- og jobsystem.\n\nLog ind med din e-mailadresse her:\n${link}\n\nDu får et login-link på e-mail, når du logger ind. Der er ingen adgangskode.`,
    html: wrapHtml(
      s,
      `<p>${escapeHtml(invitedBy)} har givet dig adgang til ${escapeHtml(s.company_name)}s lager- og jobsystem.</p>${button(s, link, 'Log ind')}<p style="color:#55534D;font-size:13px">Du logger ind med din e-mailadresse og får et login-link på e-mail. Der er ingen adgangskode.</p>`,
    ),
  };
}

export function loginEmail(link: string, s: Settings): Omit<EmailMessage, 'to'> {
  return {
    subject: `Log ind på ${s.company_name}`,
    text: `Brug dette link for at logge ind (gyldigt i 15 minutter):\n${link}\n\nHar du ikke bedt om at logge ind, kan du se bort fra denne e-mail.`,
    html: wrapHtml(
      s,
      `<p>Klik på knappen for at logge ind. Linket virker i 15 minutter og kun én gang.</p>${button(s, link, 'Log ind')}<p style="color:#55534D;font-size:13px">Har du ikke bedt om at logge ind, kan du se bort fra denne e-mail.</p>`,
    ),
  };
}
