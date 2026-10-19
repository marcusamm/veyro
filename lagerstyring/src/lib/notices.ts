// Lageradvarsler og e-mails til ejer/indkøber.
//
// En advarsel oprettes, når den disponible beholdning når genbestillingspunktet. Samme uændrede
// behov giver ikke en ny besked, men en forværring (genbestilling → kritisk → ingen disponible)
// gør. Advarslen er synlig, indtil varerne er modtaget, også selvom der er oprettet en
// genbestilling; en åben indkøbsordre skjuler aldrig risikoen for mangel før levering.

import type { Env, PurchaseListRow, User } from '../env';
import { formatDateTime, formatDay, formatKr, formatQty, lineAmount, todayDk } from './format';
import { nowSec } from './crypto';
import { deliver, button, escapeHtml, table, wrapHtml, type DeliveryStatus } from './email';
import { listEstimate, type EstimatedLine } from './estimates';
import { PRODUCT_SQL, type ProductWithSupplier } from './materials';
import { DISCLAIMER, FREIGHT_NOTE, STALE_LABEL, VAT_LABEL, type ListEstimate } from './prices';
import { lineStatus, LINE_STATUS_LABEL, listLines, openPurchasesFor, outstanding, type LineView } from './purchasing';
import type { Settings } from './settings';
import { LEVEL, STATUS_LABEL, stockPlan, type StockPlan } from './stock';

export function appUrl(env: Env): string {
  return (env.APP_URL || '').replace(/\/+$/, '');
}

export async function recipients(db: D1Database, flag: 'alert_mail' | 'purchase_mail'): Promise<User[]> {
  const { results } = await db.prepare(`SELECT * FROM users WHERE active = 1 AND ${flag} = 1 ORDER BY name`).all<User>();
  return results;
}

/** Må modtageren se priser? (ejer og indkøber) */
export function seesPrices(u: Pick<User, 'role'> | null | undefined): boolean {
  return !!u && (u.role === 'ejer' || u.role === 'indkober');
}

export interface AlertInfo {
  product: ProductWithSupplier;
  plan: StockPlan;
  open: LineView[];
}

function alertText(a: AlertInfo): { lines: string[]; rows: string[][] } {
  const p = a.product;
  const u = p.unit;
  const lines = [
    `${p.name} (${p.sku}): ${STATUS_LABEL[a.plan.status]}`,
    `Fysisk ${formatQty(p.stock)} ${u} · reserveret ${formatQty(p.reserved)} ${u} · disponibel ${formatQty(a.plan.available)} ${u}`,
    `Sikkerhedslager ${formatQty(a.plan.safety)} ${u} · genbestillingspunkt ${formatQty(a.plan.rop)} ${u}`,
    `Leverandør: ${p.supplier_name ?? 'ikke valgt'} · leveringstid ${a.plan.leadDays ?? '?'} dage`,
  ];
  const rows = [['Åbent indkøb', 'Mængde', 'Status', 'Forventet']];
  for (const l of a.open) {
    rows.push([l.job_number ? `${l.job_number} ${l.job_name}` : 'Lageropfyldning', `${formatQty(outstanding(l))} ${u}`, LINE_STATUS_LABEL[lineStatus(l)], l.expected_date || '–']);
  }
  return { lines, rows };
}

export function alertEmail(alerts: AlertInfo[], s: Settings, link: string): { subject: string; text: string; html: string } {
  const worst = alerts.reduce((m, a) => Math.max(m, LEVEL[a.plan.status]), 0);
  const subject =
    alerts.length === 1
      ? `${STATUS_LABEL[alerts[0]!.plan.status]}: ${alerts[0]!.product.name}`
      : `${alerts.length} varer skal genbestilles${worst >= 2 ? ' (kritisk)' : ''}`;
  const text: string[] = [];
  const html: string[] = [];
  for (const a of alerts) {
    const t = alertText(a);
    text.push(t.lines.join('\n'));
    html.push(`<p style="margin:0 0 4px"><strong>${escapeHtml(t.lines[0]!)}</strong></p><p style="margin:0 0 4px;color:#55534D">${t.lines.slice(1).map(escapeHtml).join('<br>')}</p>`);
    if (t.rows.length > 1) {
      const tb = table(t.rows, [1]);
      text.push(tb.text);
      html.push(tb.html);
    } else {
      text.push('Ingen åbne indkøb.');
      html.push('<p style="margin:0 0 12px;color:#55534D">Ingen åbne indkøb.</p>');
    }
  }
  return {
    subject,
    text: `${text.join('\n\n')}\n\nSe lageret: ${link}`,
    html: wrapHtml(s, `${html.join('<div style="height:14px"></div>')}${button(s, link, 'Se lageret')}`),
  };
}

/**
 * Vurderer varernes lagerstatus efter en ændring: nye eller forværrede advarsler oprettes (og
 * sendes på e-mail, hvis det er slået til), og løste advarsler lukkes.
 */
export async function evaluateProducts(env: Env, s: Settings, ids: Iterable<number>, actor = 'system'): Promise<AlertInfo[]> {
  const list = [...new Set(ids)];
  if (!list.length) return [];
  const { results } = await env.DB.prepare(`${PRODUCT_SQL} WHERE p.id IN (${list.map(() => '?').join(',')})`)
    .bind(...list)
    .all<ProductWithSupplier>();
  const now = nowSec();
  const stmts: D1PreparedStatement[] = [];
  const fresh: AlertInfo[] = [];
  for (const p of results) {
    const plan = stockPlan(p);
    const level = LEVEL[plan.status];
    if (level > p.alert_level) {
      const msg = `${STATUS_LABEL[plan.status]}: disponibel ${formatQty(plan.available)} ${p.unit}, genbestillingspunkt ${formatQty(plan.rop)} ${p.unit}`;
      stmts.push(
        env.DB.prepare("UPDATE notices SET open = 0, resolved_at = ? WHERE kind = 'lager' AND open = 1 AND product_id = ?").bind(now, p.id),
        env.DB.prepare("INSERT INTO notices (kind, level, product_id, message, created_at) VALUES ('lager', ?, ?, ?, ?)").bind(level, p.id, msg, now),
        env.DB.prepare('UPDATE products SET alert_level = ? WHERE id = ?').bind(level, p.id),
      );
      fresh.push({ product: p, plan, open: await openPurchasesFor(env.DB, p.id) });
    } else if (level < p.alert_level) {
      stmts.push(env.DB.prepare('UPDATE products SET alert_level = ? WHERE id = ?').bind(level, p.id));
      if (level === 0) {
        stmts.push(env.DB.prepare("UPDATE notices SET open = 0, resolved_at = ? WHERE kind = 'lager' AND open = 1 AND product_id = ?").bind(now, p.id));
      } else {
        stmts.push(env.DB.prepare("UPDATE notices SET level = ? WHERE kind = 'lager' AND open = 1 AND product_id = ?").bind(level, p.id));
      }
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  if (fresh.length && s.alert_mail_enabled) {
    const to = await recipients(env.DB, 'alert_mail');
    const msg = alertEmail(fresh, s, `${appUrl(env)}/lager`);
    for (const u of to) {
      const { id } = await deliver(env, s, { to: u.email, ...msg }, { kind: 'lageradvarsel', actor });
      await env.DB.prepare(
        `UPDATE notices SET mail_id = ? WHERE kind = 'lager' AND open = 1 AND mail_id IS NULL AND product_id IN (${fresh.map(() => '?').join(',')})`,
      )
        .bind(id, ...fresh.map((f) => f.product.id))
        .run();
    }
  }
  return fresh;
}

/** E-mail med en indkøbsliste. Priser medtages kun, hvis modtageren har adgang til dem. */
export function purchaseListEmail(
  list: PurchaseListRow & { job_number: string | null; job_name: string | null },
  lines: LineView[],
  s: Settings,
  link: string,
  withPrices: boolean,
  estimate?: { items: EstimatedLine<LineView>[]; summary: ListEstimate; bySupplier: boolean },
): { subject: string; text: string; html: string } {
  const title = list.job_number ? `${list.job_number} ${list.job_name}` : list.name;
  const live = lines.filter((l) => !l.cancelled);
  const head = ['Vare', 'Varenr.', 'Mængde', 'Leverandør', 'Status'];
  if (withPrices) head.push('Pris', 'Beløb');
  const rows = [head];
  let total = 0;
  for (const l of live) {
    const q = Math.max(l.qty, l.ordered);
    const r = [l.name, l.sku || '–', `${formatQty(q)} ${l.unit}`, l.supplier_name ?? '–', LINE_STATUS_LABEL[lineStatus(l)]];
    if (withPrices) {
      const amount = lineAmount(l.unit_price, q);
      total += amount;
      r.push(l.unit_price === null ? '–' : formatKr(l.unit_price), l.unit_price === null ? '–' : formatKr(amount));
    }
    rows.push(r);
  }
  const tb = table(rows, withPrices ? [2, 5, 6] : [2]);
  const meta = [
    list.job_number ? `Job: ${list.job_number} ${list.job_name}` : 'Lageropfyldning',
    `Liste: ${list.name} (version ${list.version})`,
    list.wanted_date && `Ønsket levering: ${list.wanted_date}`,
    list.responsible && `Indkøbsansvarlig: ${list.responsible}`,
  ].filter(Boolean) as string[];
  const note = 'Dette er en orientering. Bestillingen hos leverandøren registreres særskilt i systemet.';
  const est = withPrices && estimate ? estimateMail(estimate) : null;
  return {
    subject: `Indkøbsliste: ${title}`,
    text: `${meta.join('\n')}\n\n${tb.text}${withPrices ? `\n\nI alt (forventet): ${formatKr(total)}` : ''}${est ? `\n\n${est.text}` : ''}\n\n${note}\n\nÅbn listen: ${link}`,
    html: wrapHtml(
      s,
      `<p style="margin:0 0 8px">${meta.map(escapeHtml).join('<br>')}</p>${tb.html}${withPrices ? `<p style="margin:8px 0 0"><strong>I alt (forventet): ${formatKr(total)}</strong></p>` : ''}${est ? est.html : ''}${button(s, link, 'Åbn indkøbslisten')}<p style="color:#55534D;font-size:13px">${note}</p>`,
    ),
  };
}

export interface OrderLine {
  line: LineView;
  qty: number;
  date: string;
  /** Leveringsadresse: firmaets adresse (lager) eller jobbets arbejdssted */
  address: string;
}

/**
 * Bestilling til en forhandler på e-mail. Uden priser: forhandleren bruger firmaets egne
 * aftalepriser og bekræfter pris og levering ved at svare (svaret går til den, der bestilte).
 */
export function supplierOrderEmail(
  supplier: string,
  lines: OrderLine[],
  s: Settings,
  d: { ref: string; orderedBy: { name: string; email: string } },
): { subject: string; text: string; html: string } {
  const rows = [['Varenr.', 'Vare', 'Antal', 'Job', 'Levering', 'Ønsket levering']];
  for (const { line, qty, date, address } of lines) {
    rows.push([
      line.sku || '–',
      line.note ? `${line.name} (${line.note})` : line.name,
      `${formatQty(qty)} ${line.unit}`,
      line.job_number ?? 'Lager',
      address || 'Aftales',
      date ? formatDay(date) : 'Snarest',
    ]);
  }
  const tb = table(rows, [2]);
  const meta = [
    `Bestilling fra ${s.company_name}${d.ref ? ` (vores ref. ${d.ref})` : ''}`,
    s.company_cvr && `CVR: ${s.company_cvr}`,
    s.company_address && `Adresse: ${s.company_address}`,
    `Bestilt af: ${d.orderedBy.name} (${d.orderedBy.email}${s.company_phone ? `, tlf. ${s.company_phone}` : ''})`,
  ].filter(Boolean) as string[];
  const ask = 'Bekræft venligst bestillingen med pris og forventet leveringsdato ved at svare på denne e-mail. Priser efter vores aftale med jer.';
  return {
    subject: `Bestilling fra ${s.company_name}${d.ref ? ` · ${d.ref}` : ''}`,
    text: `Til ${supplier}\n\n${meta.join('\n')}\n\n${tb.text}\n\n${ask}`,
    html: wrapHtml(
      s,
      `<p style="margin:0 0 8px">Til ${escapeHtml(supplier)}</p><p style="margin:0 0 8px">${meta.map(escapeHtml).join('<br>')}</p>${tb.html}<p style="margin:12px 0 0">${escapeHtml(ask)}</p>`,
    ),
  };
}

/** Prisestimatet i e-mailen: valgt forhandler, link, estimat, varer uden pris og prisdatoernes dato. */
function estimateMail(e: { items: EstimatedLine<LineView>[]; summary: ListEstimate; bySupplier: boolean }): { text: string; html: string } {
  const s = e.summary;
  const basis = VAT_LABEL[s.basis];
  const rows = e.items.filter((x) => x.est.need > 0);
  const groups = new Map<string, typeof rows>();
  for (const x of rows) {
    const k = e.bySupplier ? (x.est.chosen?.est.retailer_name ?? 'Uden pris') : '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(x);
  }
  const text: string[] = [`Prisestimat (${basis})`];
  const htmlParts: string[] = [`<h3 style="margin:20px 0 6px;font-size:16px">Prisestimat (${escapeHtml(basis)})</h3>`];
  for (const [name, items] of groups) {
    const head = ['Vare', 'Mangler', 'Forhandler', 'Køb', 'Estimat', 'Pris tjekket', 'Link'];
    const t = [head];
    let sub = 0;
    for (const { line, est } of items) {
      const c = est.chosen;
      if (c && c.plan.ok) sub += c.amount!;
      t.push([
        line.name,
        `${formatQty(est.need)} ${line.unit}`,
        c ? `${c.est.retailer_name}${c.est.match === 'alternativ' ? ' (godkendt alternativ)' : ''}${c.est.source === 'demodata' ? ' (Demodata)' : c.est.source === 'manuel' ? ' (manuelt indtastet)' : ''}` : 'Pris mangler',
        c && c.plan.ok ? `${formatQty(c.plan.buy)} ${c.est.sales_unit}` : '–',
        c ? formatKr(c.amount) : 'Pris mangler',
        c ? `${formatDateTime(c.est.checked_at)}${c.stale ? ` (${STALE_LABEL})` : ''}` : '–',
        c?.est.url || '–',
      ]);
    }
    const tb = table(t, [1, 3, 4]);
    if (name) {
      text.push(`\n${name} (${formatKr(sub)})`);
      htmlParts.push(`<p style="margin:12px 0 4px"><strong>${escapeHtml(name)}</strong> (${formatKr(sub)})</p>`);
    }
    text.push(tb.text);
    htmlParts.push(tb.html);
  }
  const lines = [
    `Estimat i alt (${basis}): ${formatKr(s.total)} for ${s.priced} af ${s.lines} varer med pris.`,
    s.missing.length ? `Varer uden pris (Pris mangler): ${s.missing.map((m) => m.name).join(', ')}.` : '',
    s.stale ? `${s.stale} ${s.stale === 1 ? 'pris er' : 'priser er'} markeret "${STALE_LABEL}".` : '',
    s.oldest ? `Prisdata fra ${formatDateTime(s.oldest)}${s.newest && s.newest !== s.oldest ? ` til ${formatDateTime(s.newest)}` : ''}.` : '',
    `${FREIGHT_NOTE}.`,
    DISCLAIMER,
  ].filter(Boolean);
  text.push('', ...lines);
  htmlParts.push(
    `<p style="margin:8px 0 0"><strong>${escapeHtml(lines[0]!)}</strong></p>`,
    ...lines.slice(1).map((l) => `<p style="margin:4px 0 0;font-size:14px">${escapeHtml(l)}</p>`),
  );
  return { text: text.join('\n'), html: htmlParts.join('') };
}

export async function sendPurchaseList(
  env: Env,
  s: Settings,
  list: PurchaseListRow & { job_number: string | null; job_name: string | null },
  to: User,
  actor: string,
  opts: { bySupplier?: boolean } = {},
): Promise<DeliveryStatus> {
  const lines = await listLines(env.DB, list.id);
  const prices = seesPrices(to);
  // Prisestimatet er kun en tilføjelse: kan det ikke beregnes, sendes listen uden
  const est = prices ? await listEstimate(env.DB, s, lines, nowSec()).catch(() => null) : null;
  const msg = purchaseListEmail(
    list,
    lines,
    s,
    `${appUrl(env)}/${prices ? 'lager' : 'job'}/indkob/${list.id}`,
    prices,
    est ? { items: est.items, summary: est.summary, bySupplier: !!opts.bySupplier } : undefined,
  );
  const { status } = await deliver(env, s, { to: to.email, ...msg }, { kind: 'indkobsliste', actor, list_id: list.id, list_version: list.version });
  return status;
}

/**
 * Samlet e-mail med nye indkøbsbehov siden sidst (kører fra cron med det valgte interval).
 * Afsendelsen ændrer ikke status på linjerne: bestilling registreres særskilt.
 */
export async function runPurchaseDigest(env: Env, s: Settings, now = nowSec()): Promise<number> {
  if (!s.purchase_digest_hours) return 0;
  if (now - s.last_digest_at < s.purchase_digest_hours * 3600 - 60) return 0;
  const since = s.last_digest_at || now - s.purchase_digest_hours * 3600;
  const { results } = await env.DB.prepare(
    `SELECT l.*, s.name AS supplier_name, j.number AS job_number, j.name AS job_name
     FROM purchase_lines l JOIN purchase_lists pl ON pl.id = l.list_id
     LEFT JOIN suppliers s ON s.id = l.supplier_id LEFT JOIN jobs j ON j.id = l.job_id
     WHERE l.cancelled = 0 AND l.ordered = 0 AND l.updated_at > ? AND pl.archived = 0
     ORDER BY j.number, l.name`,
  )
    .bind(since)
    .all<LineView>();
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('last_digest_at', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(String(now)).run();
  if (!results.length) return 0;
  const to = await recipients(env.DB, 'purchase_mail');
  for (const u of to) {
    const prices = seesPrices(u);
    const head = ['Job', 'Vare', 'Mængde', 'Leverandør'];
    if (prices) head.push('Forventet beløb');
    const rows = [head];
    for (const l of results) {
      const r = [l.job_number ? `${l.job_number} ${l.job_name}` : 'Lageropfyldning', l.name, `${formatQty(l.qty)} ${l.unit}`, l.supplier_name ?? '–'];
      if (prices) r.push(l.unit_price === null ? '–' : formatKr(lineAmount(l.unit_price, l.qty)));
      rows.push(r);
    }
    const tb = table(rows, prices ? [2, 4] : [2]);
    const link = `${appUrl(env)}/lager/indkob`;
    await deliver(
      env,
      s,
      {
        to: u.email,
        subject: `Nye indkøbsbehov (${results.length})`,
        text: `Nye eller ændrede indkøbsbehov siden ${formatDateTime(since)}:\n\n${tb.text}\n\nSe indkøb: ${link}`,
        html: wrapHtml(s, `<p>Nye eller ændrede indkøbsbehov siden ${escapeHtml(formatDateTime(since))}:</p>${tb.html}${button(s, link, 'Se indkøb')}`),
      },
      { kind: 'samlet_indkob', actor: 'system' },
    );
  }
  return results.length;
}

export { todayDk };
