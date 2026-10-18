import type { Env, OrderLineRow, OrderRow } from '../env';
import { formatDateTime, formatKr } from './format';
import { STATUS_LABEL } from './orders';
import type { Settings } from './settings';

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
export async function sendEmail(env: Env, msg: EmailMessage, s?: Settings): Promise<boolean> {
  // Ordrer oprettet på telefon eller ved direkte salg kan være uden e-mail
  if (!env.RESEND_API_KEY || !msg.to) return false;
  const base = (env.RESEND_API_BASE || 'https://api.resend.com').replace(/\/+$/, '');
  const from = env.EMAIL_FROM || `${s?.shop_name ?? 'Butik'} <onboarding@resend.dev>`;
  const replyTo = msg.replyTo ?? (s?.contact_email || undefined);
  const res = await fetch(`${base}/emails`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [msg.to],
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });
  if (!res.ok) {
    // Log kun status – ikke modtager eller indhold
    console.error(`Resend-fejl: HTTP ${res.status}`);
    throw new Error('E-mail kunne ikke sendes');
  }
  return true;
}

/** Sender i baggrunden og logger fejl, så en e-mailfejl aldrig stopper en ordre. */
export function sendLater(env: Env, ctx: { waitUntil(p: Promise<unknown>): void }, msg: EmailMessage | null, s?: Settings): void {
  if (!msg || !msg.to) return;
  if (!env.RESEND_API_KEY) {
    console.log(`[DEV] Ingen RESEND_API_KEY – e-mail til ${msg.to}: ${msg.subject}`);
    return;
  }
  ctx.waitUntil(sendEmail(env, msg, s).catch((err) => console.error('E-mail fejlede:', (err as Error).message)));
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function wrapHtml(s: Settings, inner: string): string {
  const accent = /^#[0-9a-fA-F]{6}$/.test(s.accent_color) ? s.accent_color : '#1F5EFF';
  const footer = [s.shop_name, s.address, s.contact_phone, s.contact_email].filter(Boolean).map(escapeHtml).join(' · ');
  return `<!doctype html><html lang="da"><body style="margin:0;background:#F3F4F6;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F6;padding:32px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:14px;padding:32px;border-top:4px solid ${accent}">
<tr><td style="font-size:20px;font-weight:700;padding-bottom:20px">${escapeHtml(s.shop_name)}</td></tr>
<tr><td style="font-size:15px;line-height:1.55">${inner}</td></tr>
</table>
<p style="font-size:12px;color:#6B7280;margin-top:16px">${footer}</p>
</td></tr></table></body></html>`;
}

function button(s: Settings, href: string, label: string): string {
  const accent = /^#[0-9a-fA-F]{6}$/.test(s.accent_color) ? s.accent_color : '#1F5EFF';
  return `<p style="margin:0 0 24px"><a href="${escapeHtml(href)}" style="display:inline-block;background:${accent};color:#FFFFFF;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">${escapeHtml(label)}</a></p>`;
}

function linesTable(order: OrderRow, lines: OrderLineRow[]): { html: string; text: string } {
  const rows = lines
    .map(
      (l) =>
        `<tr><td style="padding:6px 0;border-bottom:1px solid #E5E7EB">${l.quantity} × ${escapeHtml(l.name)}<br><span style="color:#6B7280;font-size:13px">${escapeHtml(l.sku)}</span></td><td align="right" style="padding:6px 0;border-bottom:1px solid #E5E7EB;white-space:nowrap">${formatKr(l.line_total)}</td></tr>`,
    )
    .join('');
  const fee = order.delivery === 'levering'
    ? `<tr><td style="padding:6px 0">Levering</td><td align="right" style="padding:6px 0">${order.delivery_fee ? formatKr(order.delivery_fee) : 'Gratis'}</td></tr>`
    : '';
  const html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;font-size:14px">${rows}${fee}
<tr><td style="padding:10px 0 0;font-weight:700">I alt inkl. moms</td><td align="right" style="padding:10px 0 0;font-weight:700">${formatKr(order.total)}</td></tr></table>`;
  const text =
    lines.map((l) => `${l.quantity} × ${l.name} (${l.sku}): ${formatKr(l.line_total)}`).join('\n') +
    (order.delivery === 'levering' ? `\nLevering: ${order.delivery_fee ? formatKr(order.delivery_fee) : 'Gratis'}` : '') +
    `\nI alt inkl. moms: ${formatKr(order.total)}`;
  return { html, text };
}

function deliveryText(order: OrderRow, s: Settings): string {
  return order.delivery === 'levering'
    ? `Levering til: ${order.address}, ${order.postcode} ${order.city}`
    : `Afhentning${s.address ? ': ' + s.address : ''}`;
}

export function orderReceivedEmail(order: OrderRow, lines: OrderLineRow[], s: Settings, url: string): EmailMessage {
  const t = linesTable(order, lines);
  const confirmed = order.status === 'bekraeftet';
  const lead = confirmed
    ? 'Tak for din bestilling. Den er bekræftet, og vi går i gang med at gøre den klar.'
    : 'Tak for din bestilling. Vi har modtaget den og vender tilbage, når den er bekræftet.';
  const text = `Hej ${order.customer_name}

${lead}

Ordrenummer: #${order.number}
${deliveryText(order, s)}

${t.text}

Se din bestilling: ${url}

Venlig hilsen
${s.shop_name}`;
  const html = wrapHtml(
    s,
    `<p style="margin:0 0 12px">Hej ${escapeHtml(order.customer_name)}</p>
<p style="margin:0 0 20px">${lead}</p>
<p style="margin:0 0 4px"><strong>Ordrenummer:</strong> #${order.number}</p>
<p style="margin:0 0 20px">${escapeHtml(deliveryText(order, s))}</p>
${t.html}
${button(s, url, 'Se din bestilling')}`,
  );
  return { to: order.customer_email, subject: `Tak for din bestilling (#${order.number})`, text, html };
}

const STATUS_MESSAGE: Partial<Record<string, (o: OrderRow, s: Settings) => string>> = {
  bekraeftet: () => 'Din bestilling er bekræftet, og vi går i gang med at gøre den klar.',
  klar: (o, s) =>
    o.delivery === 'levering'
      ? 'Din bestilling er sendt afsted til dig.'
      : `Din bestilling er klar til afhentning${s.address ? ' på ' + s.address : ''}.${s.pickup_info ? ' ' + s.pickup_info : ''}`,
  annulleret: (_o, s) =>
    `Din bestilling er annulleret. Har du spørgsmål, så kontakt os${s.contact_email ? ' på ' + s.contact_email : ''}${s.contact_phone ? ' eller ' + s.contact_phone : ''}.`,
};

/** E-mail til kunden ved statusskift (kun de statusser, der er relevante for kunden). */
export function statusEmail(order: OrderRow, s: Settings, url: string): EmailMessage | null {
  const msg = STATUS_MESSAGE[order.status]?.(order, s);
  if (!msg) return null;
  const text = `Hej ${order.customer_name}

${msg}

Ordrenummer: #${order.number}
Se din bestilling: ${url}

Venlig hilsen
${s.shop_name}`;
  const html = wrapHtml(
    s,
    `<p style="margin:0 0 12px">Hej ${escapeHtml(order.customer_name)}</p>
<p style="margin:0 0 20px">${escapeHtml(msg)}</p>
<p style="margin:0 0 20px"><strong>Ordrenummer:</strong> #${order.number}</p>
${button(s, url, 'Se din bestilling')}`,
  );
  return { to: order.customer_email, subject: `Bestilling #${order.number}: ${STATUS_LABEL[order.status].toLowerCase()}`, text, html };
}

export function newOrderNotifyEmail(order: OrderRow, lines: OrderLineRow[], s: Settings, adminUrl: string): EmailMessage {
  const t = linesTable(order, lines);
  const who = [order.customer_name, order.company, order.customer_email, order.customer_phone].filter(Boolean).join(' · ');
  const text = `Ny bestilling #${order.number} (${formatDateTime(order.created_at)})

${who}
${deliveryText(order, s)}
${order.note ? '\nBesked: ' + order.note + '\n' : ''}
${t.text}

Åbn ordren: ${adminUrl}`;
  const html = wrapHtml(
    s,
    `<p style="margin:0 0 12px"><strong>Ny bestilling #${order.number}</strong></p>
<p style="margin:0 0 4px">${escapeHtml(who)}</p>
<p style="margin:0 0 16px">${escapeHtml(deliveryText(order, s))}</p>
${order.note ? `<p style="margin:0 0 16px;white-space:pre-wrap"><strong>Besked:</strong> ${escapeHtml(order.note)}</p>` : ''}
${t.html}
${button(s, adminUrl, 'Åbn ordren')}`,
  );
  return { to: s.notify_email || s.contact_email, subject: `Ny bestilling #${order.number} – ${formatKr(order.total)}`, text, html, replyTo: order.customer_email || undefined };
}

export function lowStockEmail(items: { sku: string; name: string; stock: number }[], s: Settings, adminUrl: string): EmailMessage {
  const text = `Disse varer er ved at løbe tør:

${items.map((i) => `${i.name} (${i.sku}): ${i.stock} tilbage`).join('\n')}

Se lageret: ${adminUrl}`;
  const html = wrapHtml(
    s,
    `<p style="margin:0 0 16px"><strong>Disse varer er ved at løbe tør</strong></p>
<ul style="margin:0 0 20px;padding-left:20px">${items.map((i) => `<li>${escapeHtml(i.name)} (${escapeHtml(i.sku)}): <strong>${i.stock}</strong> tilbage</li>`).join('')}</ul>
${button(s, adminUrl, 'Se lageret')}`,
  );
  return { to: s.notify_email || s.contact_email, subject: `Lavt lager: ${items.map((i) => i.name).join(', ')}`.slice(0, 150), text, html };
}

export function loginEmail(link: string, s: Settings): Omit<EmailMessage, 'to'> {
  const text = `Hej

Her er dit link til at logge ind i ${s.shop_name}s ordresystem:

${link}

Linket virker i 15 minutter og kan kun bruges én gang.
Har du ikke bedt om at logge ind, kan du se bort fra denne e-mail.`;
  const html = wrapHtml(
    s,
    `<p style="margin:0 0 16px">Klik på knappen for at logge ind i ordresystemet.</p>
${button(s, link, 'Log ind')}
<p style="margin:0;color:#6B7280;font-size:14px">Linket virker i 15 minutter og kan kun bruges én gang. Har du ikke bedt om at logge ind, kan du se bort fra denne e-mail.</p>`,
  );
  return { subject: `Log ind: ${s.shop_name}`, text, html };
}
