// Kvittering for et kassesalg som e-mail (tekst og HTML). Udskriften laves i views/kasse.ts.
import { escapeHtml, wrapHtml, type EmailMessage } from '../email';
import { formatDateTime, formatKr } from '../format';
import type { SaleDetail } from './sales';
import type { PosSettings } from './settings';

export function receiptEmail(d: SaleDetail, pos: PosSettings, to: string, staffName: string): EmailMessage {
  const o = d.sale;
  const vatPct = (o.vat_rate_bp / 100).toLocaleString('da-DK');
  const paid = d.payments.filter((p) => p.status === 'gennemfoert');
  const orderDisc = d.lines.reduce((a, l) => a + l.order_discount, 0);
  const refunds = d.refunds.filter((r) => r.status === 'gennemfoert');
  const text = [
    pos.store_name,
    [pos.store_address, pos.store_phone, pos.cvr ? `CVR ${pos.cvr}` : ''].filter(Boolean).join(' · '),
    '',
    `Kvittering #${o.number}`,
    formatDateTime(o.created_at),
    staffName ? `Ekspedient: ${staffName}` : '',
    '',
    ...d.lines.map((l) => {
      const disc = l.line_discount ? ` (rabat ${formatKr(l.line_discount)})` : '';
      return `${l.quantity} × ${l.name} à ${formatKr(l.unit_price)}: ${formatKr(l.line_total - l.line_discount)}${disc}`;
    }),
    '',
    orderDisc ? `Rabat: -${formatKr(orderDisc)}` : '',
    `I alt: ${formatKr(o.total)}`,
    `Heraf moms ${vatPct} %: ${formatKr(o.vat_amount)}`,
    o.rounding ? `Øreafrunding: ${formatKr(o.rounding)}` : '',
    '',
    ...paid.map((p) => `${p.label}: ${formatKr(p.amount)}${p.method === 'kontant' && p.received ? ` (modtaget ${formatKr(p.received)}, retur ${formatKr(p.change_given ?? 0)})` : ''}`),
    ...refunds.map((r) => `Refunderet ${formatDateTime(r.created_at)}: -${formatKr(r.amount)}`),
    '',
    pos.receipt_footer,
  ]
    .filter((x, i, a) => x !== '' || a[i - 1] !== '')
    .join('\n');
  const row = (a: string, b: string, strong = false) =>
    `<tr><td style="padding:4px 0;${strong ? 'font-weight:700' : ''}">${a}</td><td align="right" style="padding:4px 0;white-space:nowrap;${strong ? 'font-weight:700' : ''}">${b}</td></tr>`;
  const html = wrapHtml(
    `<p style="margin:0 0 4px"><strong>Kvittering #${o.number}</strong></p>
<p style="margin:0 0 16px;color:#55534D;font-size:13px">${escapeHtml(formatDateTime(o.created_at))}${staffName ? ` · ${escapeHtml(staffName)}` : ''}${pos.cvr ? ` · CVR ${escapeHtml(pos.cvr)}` : ''}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin:0 0 12px">
${d.lines
  .map(
    (l) =>
      `<tr><td style="padding:6px 0;border-bottom:1px solid #E6E3DA">${l.quantity} × ${escapeHtml(l.name)}<br><span style="color:#55534D;font-size:13px">à ${formatKr(l.unit_price)}${l.line_discount ? ` · rabat ${formatKr(l.line_discount)}` : ''}</span></td><td align="right" style="padding:6px 0;border-bottom:1px solid #E6E3DA;white-space:nowrap">${formatKr(l.line_total - l.line_discount)}</td></tr>`,
  )
  .join('')}
${orderDisc ? row('Rabat', '-' + formatKr(orderDisc)) : ''}
${row('I alt', formatKr(o.total), true)}
${row(`Heraf moms ${vatPct} %`, formatKr(o.vat_amount))}
${o.rounding ? row('Øreafrunding', formatKr(o.rounding)) : ''}
${paid.map((p) => row(escapeHtml(p.label), formatKr(p.amount))).join('')}
${refunds.map((r) => row(`Refunderet ${escapeHtml(formatDateTime(r.created_at))}`, '-' + formatKr(r.amount))).join('')}
</table>
${pos.receipt_footer ? `<p style="margin:16px 0 0;white-space:pre-line">${escapeHtml(pos.receipt_footer)}</p>` : ''}`,
  );
  return { to, subject: `Kvittering #${o.number} fra ${pos.store_name}`, text, html };
}
