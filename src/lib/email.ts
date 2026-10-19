import type { Env } from '../env';
import { formatKr } from './format';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
}

/**
 * Sender e-mail via Resends HTTP API. Returnerer false hvis der ikke er
 * nogen RESEND_API_KEY (udvikling) – så må kalderen selv håndtere det.
 */
export async function sendEmail(env: Env, msg: EmailMessage): Promise<boolean> {
  if (!env.RESEND_API_KEY) return false;
  const base = (env.RESEND_API_BASE || 'https://api.resend.com').replace(/\/+$/, '');
  const res = await fetch(`${base}/emails`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM || 'Veyro <kontakt@veyro.dk>',
      to: [msg.to],
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
    }),
  });
  if (!res.ok) {
    // Log kun status – ikke modtager eller indhold
    console.error(`Resend-fejl: HTTP ${res.status}`);
    throw new Error('E-mail kunne ikke sendes');
  }
  return true;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function wrapHtml(inner: string): string {
  return `<!doctype html><html lang="da"><body style="margin:0;background:#F4F2EC;font-family:'Inter Tight',-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0F0F0D">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F2EC;padding:32px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FBFAF7;border-radius:18px;padding:32px">
<tr><td style="font-size:20px;font-weight:700;letter-spacing:-0.02em;padding-bottom:24px">Veyro<span style="color:#FF5A1F">.</span></td></tr>
<tr><td style="font-size:16px;line-height:1.55">${inner}</td></tr>
</table>
<p style="font-size:12px;color:#55534D;margin-top:16px">Veyro · veyro.dk</p>
</td></tr></table></body></html>`;
}

export function magicLinkEmail(link: string): Omit<EmailMessage, 'to'> {
  const text = `Hej

Her er dit link til at logge ind på Veyros kundepanel:

${link}

Linket virker i 15 minutter og kan kun bruges én gang.
Har du ikke bedt om at logge ind, kan du se bort fra denne e-mail.

Venlig hilsen
Veyro`;
  const html = wrapHtml(`<p style="margin:0 0 16px">Hej</p>
<p style="margin:0 0 24px">Klik på knappen for at logge ind på Veyros kundepanel.</p>
<p style="margin:0 0 24px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#0F0F0D;color:#FBFAF7;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600">Log ind</a></p>
<p style="margin:0 0 8px;color:#55534D;font-size:14px">Linket virker i 15 minutter og kan kun bruges én gang. Har du ikke bedt om at logge ind, kan du se bort fra denne e-mail.</p>`);
  return { subject: 'Dit login-link til Veyro', text, html };
}

export function adminLoginEmail(link: string): Omit<EmailMessage, 'to'> {
  const text = `Hej

Her er dit link til at logge ind på Veyros adminpanel:

${link}

Linket virker i 15 minutter og kan kun bruges én gang. Bagefter forbliver du logget ind i browseren.
Har du ikke bedt om at logge ind, kan du se bort fra denne e-mail.

Veyro`;
  const html = wrapHtml(`<p style="margin:0 0 16px">Hej</p>
<p style="margin:0 0 24px">Klik på knappen for at logge ind på Veyros adminpanel.</p>
<p style="margin:0 0 24px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#0F0F0D;color:#FBFAF7;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600">Log ind</a></p>
<p style="margin:0 0 8px;color:#55534D;font-size:14px">Linket virker i 15 minutter og kan kun bruges én gang. Bagefter forbliver du logget ind i browseren. Har du ikke bedt om at logge ind, kan du se bort fra denne e-mail.</p>`);
  return { subject: 'Dit login-link til Veyro admin', text, html };
}

export function subscriptionWelcomeEmail(args: { name: string; link: string; firstChargeDate: string | null }): Omit<EmailMessage, 'to'> {
  const first = args.name.trim().split(' ')[0];
  const hello = first ? `Hej ${first}` : 'Hej';
  const intro = args.firstChargeDate
    ? `Velkommen til Veyro. Dit abonnement er startet, og den første måned er gratis. Den første betaling er ${args.firstChargeDate}.`
    : 'Velkommen til Veyro. Dit abonnement er startet, og den første faktura kommer i en separat mail.';
  const text = `${hello}

${intro}

Tilføj dit betalingskort her, så betalingen trækkes automatisk hver måned:

${args.link}

Kortoplysningerne håndteres sikkert af Stripe og gemmes aldrig hos Veyro. Tilføjer du ikke et kort, får du i stedet en faktura på mail hver måned med et link til betaling.

Linket virker i 30 dage. Har du spørgsmål, så svar på denne mail eller skriv til kontakt@veyro.dk.

Venlig hilsen
Veyro`;
  const html = wrapHtml(`<p style="margin:0 0 16px">${escapeHtml(hello)}</p>
<p style="margin:0 0 16px">${escapeHtml(intro)}</p>
<p style="margin:0 0 24px">Tilføj dit betalingskort, så betalingen trækkes automatisk hver måned.</p>
<p style="margin:0 0 24px"><a href="${escapeHtml(args.link)}" style="display:inline-block;background:#FF5A1F;color:#0F0F0D;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600">Tilføj betalingskort</a></p>
<p style="margin:0 0 8px;color:#55534D;font-size:14px">Kortoplysningerne håndteres sikkert af Stripe og gemmes aldrig hos Veyro. Tilføjer du ikke et kort, får du i stedet en faktura på mail hver måned med et link til betaling. Linket virker i 30 dage.</p>`);
  return { subject: 'Velkommen til Veyro – tilføj dit betalingskort', text, html };
}

export function signupEmail(link: string, name: string | null): Omit<EmailMessage, 'to'> {
  const hello = name ? `Hej ${name.split(' ')[0]}` : 'Hej';
  const text = `${hello}

Bekræft din e-mail for at oprette din konto hos Veyro:

${link}

Når kontoen er oprettet, kommer du videre til betaling. Linket virker i 15 minutter og kan kun bruges én gang.
Har du ikke bedt om en konto, kan du se bort fra denne e-mail.

Venlig hilsen
Veyro`;
  const html = wrapHtml(`<p style="margin:0 0 16px">${escapeHtml(hello)}</p>
<p style="margin:0 0 24px">Bekræft din e-mail for at oprette din konto hos Veyro. Derefter kommer du videre til betaling.</p>
<p style="margin:0 0 24px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#FF5A1F;color:#0F0F0D;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600">Bekræft og opret konto</a></p>
<p style="margin:0 0 8px;color:#55534D;font-size:14px">Linket virker i 15 minutter og kan kun bruges én gang. Har du ikke bedt om en konto, kan du se bort fra denne e-mail.</p>`);
  return { subject: 'Bekræft din e-mail og opret din konto hos Veyro', text, html };
}

export function newRequestEmail(args: {
  customerEmail: string;
  typeLabel: string;
  title: string;
  description: string;
  adminUrl: string;
}): Omit<EmailMessage, 'to'> {
  const text = `Ny henvendelse fra ${args.customerEmail}

Type: ${args.typeLabel}
Titel: ${args.title}

${args.description}

Se og opdater status: ${args.adminUrl}`;
  const html = wrapHtml(`<p style="margin:0 0 16px"><strong>Ny henvendelse</strong> fra ${escapeHtml(args.customerEmail)}</p>
<p style="margin:0 0 4px"><strong>Type:</strong> ${escapeHtml(args.typeLabel)}</p>
<p style="margin:0 0 16px"><strong>Titel:</strong> ${escapeHtml(args.title)}</p>
<p style="margin:0 0 24px;white-space:pre-wrap">${escapeHtml(args.description)}</p>
<p style="margin:0"><a href="${escapeHtml(args.adminUrl)}" style="color:#0F0F0D">Åbn i admin</a></p>`);
  return { subject: `Ny henvendelse: ${args.title}`.slice(0, 150), text, html };
}

export function newOrderEmail(args: {
  customerEmail: string;
  customerName: string | null;
  planName: string | null;
  amount: number | null;
  adminUrl: string;
}): Omit<EmailMessage, 'to'> {
  const who = args.customerName ? `${args.customerName} (${args.customerEmail})` : args.customerEmail;
  const plan = args.planName ?? 'Abonnement';
  const price = args.amount != null ? `${formatKr(args.amount)} pr. måned` : '–';
  const text = `Ny ordre fra ${who}

Pakke: ${plan}
Pris: ${price}

Se kunden i admin: ${args.adminUrl}`;
  const html = wrapHtml(`<p style="margin:0 0 16px"><strong>Ny ordre</strong> fra ${escapeHtml(who)}</p>
<p style="margin:0 0 4px"><strong>Pakke:</strong> ${escapeHtml(plan)}</p>
<p style="margin:0 0 24px"><strong>Pris:</strong> ${escapeHtml(price)}</p>
<p style="margin:0"><a href="${escapeHtml(args.adminUrl)}" style="color:#0F0F0D">Åbn i admin</a></p>`);
  return { subject: `Ny ordre: ${plan} – ${who}`.slice(0, 150), text, html };
}
