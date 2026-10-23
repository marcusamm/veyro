// Synkronisering af Gmail i baggrunden: kun samtaler med kendte adresser på kundeemner og kunder gemmes.
// Matchning: præcis mailadresse = bekræftet (ved ét entydigt emne). Kun fælles virksomhedsdomæne, flere mulige
// emner eller fælles udbydere kræver gennemgang, og indholdet hentes først, når en medarbejder har bekræftet.
// Dubletter undgås med Message-ID (på tværs af Veyro-konti) og samtalens rod (References).
//
// Automatik må ikke overskrive nyere manuelle beslutninger, genåbne afslag/arkiverede/blacklistede emner
// eller ændre "Blev kunde". Der sendes aldrig mails.
import type { Env } from '../env';
import { nowSec } from './crypto';
import { logError } from './errlog';
import {
  GmailError,
  META_HEADERS,
  accessToken,
  addresses,
  gmail,
  header,
  plainBody,
  type GmailMessage,
} from './gmail';
import { addEvent, addWorkdays, companyDomain, getProspect, isSalesActive, notify, sharedMailboxes, staffName, today, type ProspectRow } from './prospects';

export interface MailAccountRow {
  email: string;
  status: 'ikke_forbundet' | 'forbundet' | 'fejl' | 'genforbind';
  connected_email: string | null;
  token_enc: string | null;
  scopes: string | null;
  history_id: string | null;
  last_sync_at: number | null;
  last_check_at: number | null;
  last_error: string | null;
  last_error_at: number | null;
  attempts: number;
  next_attempt_at: number | null;
  connected_by: string | null;
  connected_at: number | null;
  updated_at: number;
}

export interface ThreadRow {
  id: number;
  conv_key: string;
  subject: string | null;
  prospect_id: number | null;
  customer_id: number | null;
  match_state: 'bekraeftet' | 'gennemgaa' | 'afvist';
  match_reason: string | null;
  account_hint: string | null;
  assigned_to: string | null;
  first_at: number | null;
  last_at: number | null;
}

export interface MessageRow {
  id: number;
  thread_id: number;
  rfc_id: string;
  account: string;
  gmail_id: string;
  direction: 'ud' | 'ind';
  kind: 'menneske' | 'autosvar' | 'leveringsfejl';
  from_addr: string | null;
  from_name: string | null;
  to_addrs: string | null;
  cc_addrs: string | null;
  subject: string | null;
  sent_at: number;
  snippet: string | null;
  body_text: string | null;
  body_loaded: number;
}

// ---------- Klassificering ----------

export function classify(m: GmailMessage): 'menneske' | 'autosvar' | 'leveringsfejl' {
  const from = (addresses(header(m, 'From'))[0]?.email ?? '').toLowerCase();
  const ct = (header(m, 'Content-Type') ?? '').toLowerCase();
  if (/^(mailer-daemon|postmaster)@/.test(from) || (ct.includes('multipart/report') && ct.includes('delivery-status')) || header(m, 'X-Failed-Recipients')) return 'leveringsfejl';
  const auto = (header(m, 'Auto-Submitted') ?? '').toLowerCase();
  const prec = (header(m, 'Precedence') ?? '').toLowerCase();
  const subj = header(m, 'Subject') ?? '';
  if ((auto && auto !== 'no') || header(m, 'X-Autoreply') || header(m, 'X-Autorespond') || /auto_reply|bulk|junk/.test(prec)) return 'autosvar';
  if (/^(autosvar|automatisk svar|auto:|automatic reply|out of office|fraværende|ikke på kontoret)/i.test(subj.trim())) return 'autosvar';
  return 'menneske';
}

function msgIds(h: string | null): string[] {
  return h ? [...h.matchAll(/<[^>]+>/g)].map((x) => x[0].toLowerCase()) : [];
}

export function conversationKey(m: GmailMessage): { key: string; refs: string[]; own: string } {
  const own = msgIds(header(m, 'Message-ID'))[0] ?? `<gmail-${m.id}>`;
  const refs = [...msgIds(header(m, 'References')), ...msgIds(header(m, 'In-Reply-To'))];
  return { key: refs[0] ?? own, refs, own };
}

// ---------- Matchning ----------

interface MatchResult {
  state: 'bekraeftet' | 'gennemgaa' | null;
  prospectId: number | null;
  customerId: number | null;
  reason: string;
}

/** Finder kundeemner/kunder ud fra de eksterne adresser i en besked */
export async function matchExternal(env: Env, external: string[]): Promise<MatchResult> {
  const db = env.DB;
  if (!external.length) return { state: null, prospectId: null, customerId: null, reason: '' };
  const ph = external.map(() => '?').join(',');
  const [pRes, cRes] = await db.batch([
    db.prepare(`SELECT DISTINCT p.id, pc.value FROM prospect_contacts pc JOIN prospects p ON p.id = pc.prospect_id WHERE pc.kind = 'email' AND pc.unverified = 0 AND p.merged_into IS NULL AND pc.value IN (${ph})`).bind(...external),
    db.prepare(`SELECT id, email FROM customers WHERE email IN (${ph})`).bind(...external),
  ]);
  const prospects = [...new Set(((pRes?.results ?? []) as { id: number; value: string }[]).map((x) => x.id))];
  const customers = [...new Set(((cRes?.results ?? []) as { id: number }[]).map((x) => x.id))];
  // Kunde fundet via kundeemne, der er knyttet til kunden, tæller som samme part
  if (prospects.length === 1) {
    const p = await getProspect(db, prospects[0]!);
    const cust = p?.customer_id ?? customers[0] ?? null;
    if (customers.length <= 1 && (!customers.length || customers[0] === p?.customer_id || !p?.customer_id)) {
      return { state: 'bekraeftet', prospectId: prospects[0]!, customerId: cust, reason: 'Kendt mailadresse' };
    }
  }
  if (!prospects.length && customers.length === 1) return { state: 'bekraeftet', prospectId: null, customerId: customers[0]!, reason: 'Kundens mailadresse' };
  if (prospects.length > 1 || customers.length > 1 || (prospects.length && customers.length)) {
    return { state: 'gennemgaa', prospectId: prospects[0] ?? null, customerId: customers[0] ?? null, reason: 'Adresserne passer på flere kundeemner eller kunder' };
  }
  // Ingen kendt adresse: et virksomhedsdomæne alene giver kun et forslag til gennemgang
  const domains = [...new Set(external.map(companyDomain).filter(Boolean) as string[])];
  if (domains.length) {
    const d = await db.prepare(`SELECT id FROM prospects WHERE merged_into IS NULL AND domain IN (${domains.map(() => '?').join(',')}) LIMIT 2`).bind(...domains).all<{ id: number }>();
    if ((d.results ?? []).length === 1) return { state: 'gennemgaa', prospectId: d.results![0]!.id, customerId: null, reason: `Kun samme domæne (${domains.join(', ')})` };
  }
  return { state: null, prospectId: null, customerId: null, reason: '' };
}

// ---------- Behandling af én besked ----------

interface Ctx {
  env: Env;
  account: string;
  token: string;
  veyroDomain: string;
  shared: Set<string>;
}

async function fetchMeta(c: Ctx, id: string): Promise<GmailMessage> {
  return gmail<GmailMessage>(c.env, c.token, `/messages/${id}`, { query: { format: 'metadata', metadataHeaders: META_HEADERS } });
}

async function fetchFull(c: Ctx, id: string): Promise<GmailMessage> {
  return gmail<GmailMessage>(c.env, c.token, `/messages/${id}`, { query: { format: 'full' } });
}

/** Behandler en besked (metadata). Returnerer true, hvis den blev gemt. */
export async function processMessage(c: Ctx, meta: GmailMessage, opts: { force?: { prospectId: number | null; customerId: number | null; actor: string } } = {}): Promise<boolean> {
  const db = c.env.DB;
  if (meta.labelIds?.includes('DRAFT') || meta.labelIds?.includes('SPAM') || meta.labelIds?.includes('TRASH')) return false;
  const { key, refs, own } = conversationKey(meta);
  const existingMsg = await db.prepare('SELECT id, thread_id FROM mail_messages WHERE rfc_id = ?').bind(own).first<{ id: number; thread_id: number }>();
  if (existingMsg) {
    // Allerede gemt fra en anden Veyro-konto: notér kun, at samtalen også ligger i denne postkasse
    await db.prepare('INSERT OR IGNORE INTO mail_thread_refs (account, gmail_thread, thread_id) VALUES (?, ?, ?)').bind(c.account, meta.threadId, existingMsg.thread_id).run();
    return false;
  }
  const fromA = addresses(header(meta, 'From'))[0] ?? null;
  const to = addresses(header(meta, 'To'));
  const cc = addresses(header(meta, 'Cc'));
  const isVeyro = (e: string) => e.endsWith('@' + c.veyroDomain);
  const direction: 'ud' | 'ind' = fromA && isVeyro(fromA.email) ? 'ud' : 'ind';
  const external = [...new Set([fromA, ...to, ...cc].filter((x): x is { email: string; name: string | null } => !!x).map((x) => x.email).filter((e) => !isVeyro(e)))];
  const kind = classify(meta);

  // Eksisterende samtale (samme rod eller en kendt besked i References)
  let thread = await db.prepare('SELECT * FROM mail_threads WHERE conv_key = ?').bind(key).first<ThreadRow>();
  if (!thread && refs.length) {
    const ph = refs.map(() => '?').join(',');
    thread = await db.prepare(`SELECT t.* FROM mail_messages m JOIN mail_threads t ON t.id = m.thread_id WHERE m.rfc_id IN (${ph}) LIMIT 1`).bind(...refs).first<ThreadRow>();
  }
  if (!thread) {
    const ref = await db.prepare('SELECT t.* FROM mail_thread_refs r JOIN mail_threads t ON t.id = r.thread_id WHERE r.account = ? AND r.gmail_thread = ?').bind(c.account, meta.threadId).first<ThreadRow>();
    thread = ref ?? null;
  }
  if (thread?.match_state === 'afvist' && !opts.force) return false;

  let match: MatchResult;
  if (opts.force) match = { state: 'bekraeftet', prospectId: opts.force.prospectId, customerId: opts.force.customerId, reason: `Tilknyttet manuelt af ${staffName(opts.force.actor)}` };
  else if (thread) match = { state: thread.match_state === 'afvist' ? null : thread.match_state, prospectId: thread.prospect_id, customerId: thread.customer_id, reason: thread.match_reason ?? '' };
  else match = await matchExternal(c.env, external);
  if (!match.state) return false; // Ikke knyttet til et kundeemne eller en kunde: gemmes ikke

  const sentAt = meta.internalDate ? Math.floor(Number(meta.internalDate) / 1000) : nowSec();
  const subject = (header(meta, 'Subject') ?? '').slice(0, 300) || null;
  const now = nowSec();
  if (!thread) {
    thread = await db
      .prepare(
        `INSERT INTO mail_threads (conv_key, subject, prospect_id, customer_id, match_state, match_reason, account_hint, first_at, last_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(conv_key) DO UPDATE SET last_at = MAX(last_at, excluded.last_at) RETURNING *`,
      )
      .bind(key, subject, match.prospectId, match.customerId, match.state, match.reason, c.account, sentAt, sentAt, now)
      .first<ThreadRow>();
  } else if (opts.force) {
    await db.prepare("UPDATE mail_threads SET match_state = 'bekraeftet', prospect_id = ?, customer_id = ?, match_reason = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?")
      .bind(match.prospectId, match.customerId, match.reason, opts.force.actor, now, thread.id)
      .run();
    thread = { ...thread, match_state: 'bekraeftet', prospect_id: match.prospectId, customer_id: match.customerId };
  }
  const confirmed = thread!.match_state === 'bekraeftet';
  // Indhold hentes kun for bekræftede samtaler
  const full = confirmed ? await fetchFull(c, meta.id) : null;
  const ins = await db
    .prepare(
      `INSERT INTO mail_messages (thread_id, rfc_id, account, gmail_id, direction, kind, from_addr, from_name, to_addrs, cc_addrs, subject, sent_at, snippet, body_text, body_loaded, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(rfc_id) DO NOTHING`,
    )
    .bind(
      thread!.id, own, c.account, meta.id, direction, kind, fromA?.email ?? null, fromA?.name?.slice(0, 150) ?? null,
      to.map((x) => x.email).join(', ').slice(0, 1000), cc.map((x) => x.email).join(', ').slice(0, 1000), subject, sentAt,
      confirmed ? (full?.snippet ?? meta.snippet ?? '').slice(0, 300) : null, confirmed && full ? plainBody(full) : null, confirmed ? 1 : 0, now,
    )
    .run();
  if (!ins.meta.changes) return false;
  await db.batch([
    db.prepare('INSERT OR IGNORE INTO mail_thread_refs (account, gmail_thread, thread_id) VALUES (?, ?, ?)').bind(c.account, meta.threadId, thread!.id),
    db.prepare('UPDATE mail_threads SET last_at = MAX(COALESCE(last_at, 0), ?), first_at = MIN(COALESCE(first_at, ?), ?) WHERE id = ?').bind(sentAt, sentAt, sentAt, thread!.id),
  ]);
  if (confirmed && thread!.prospect_id) await automate(c, thread!, { direction, kind, sentAt, subject, from: fromA, to: to.map((x) => x.email), failed: addresses(header(meta, 'X-Failed-Recipients')).map((x) => x.email) });
  if (!confirmed && thread!.prospect_id) {
    // Til gennemgang: den ansvarlige (eller kontoens ejer) får besked
    const p = await getProspect(db, thread!.prospect_id);
    const recipient = c.shared.has(c.account) ? (p?.owner ?? null) : c.account;
    if (p) await notify(db, recipient, p.id, 'mail-gennemgaa', `Mulig mail om ${p.company} kræver gennemgang (${match.reason}).`);
  }
  return true;
}

/** Statusautomatik og notifikationer for en bekræftet besked på et kundeemne */
async function automate(
  c: Ctx,
  t: ThreadRow,
  m: { direction: 'ud' | 'ind'; kind: 'menneske' | 'autosvar' | 'leveringsfejl'; sentAt: number; subject: string | null; from: { email: string; name: string | null } | null; to: string[]; failed: string[] },
): Promise<void> {
  const db = c.env.DB;
  const p = await getProspect(db, t.prospect_id!);
  if (!p) return;
  const stmts: D1PreparedStatement[] = [];
  const personal = !c.shared.has(c.account);
  const label = m.kind === 'autosvar' ? 'Autosvar' : m.kind === 'leveringsfejl' ? 'Leveringsfejl' : m.direction === 'ud' ? 'Mail sendt' : 'Svar modtaget';
  stmts.push(
    addEvent(db, p.id, {
      kind: 'mail',
      actor: m.direction === 'ud' && personal ? c.account : 'system',
      at: m.sentAt,
      channel: 'mail',
      contact_person: m.direction === 'ind' ? (m.from?.name ?? m.from?.email ?? null) : null,
      body: `${label}${m.subject ? `: ${m.subject}` : ''} (${c.account})`,
    }),
  );
  if (m.kind === 'menneske') stmts.push(db.prepare('UPDATE prospects SET last_contact_at = MAX(COALESCE(last_contact_at, 0), ?) WHERE id = ?').bind(m.sentAt, p.id));
  const active = isSalesActive(p);
  // Nyere manuel beslutning vinder: en besked fra før statussen blev sat, ændrer intet.
  // Standardstatussen ved oprettelse ("Skal undersøges") og statusser sat af automatikken er ikke manuelle beslutninger.
  const initial = p.status === 'undersoeges' && p.status_set_at === p.created_at;
  const newer = initial || p.status_set_by === 'system' || m.sentAt > (p.status_set_at ?? 0);

  if (m.kind === 'leveringsfejl') {
    // Kun de adresser, der faktisk fejlede: fra X-Failed-Recipients, ellers modtagerne af samtalens seneste udgående mail
    let failed = m.failed;
    if (!failed.length) {
      const last = await db.prepare("SELECT to_addrs FROM mail_messages WHERE thread_id = ? AND direction = 'ud' ORDER BY sent_at DESC LIMIT 1").bind(t.id).first<{ to_addrs: string | null }>();
      failed = (last?.to_addrs ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    }
    if (failed.length) {
      stmts.push(
        db.prepare(`UPDATE prospect_contacts SET bounced_at = ? WHERE prospect_id = ? AND kind = 'email' AND bounced_at IS NULL AND value IN (${failed.map(() => '?').join(',')})`).bind(nowSec(), p.id, ...failed),
      );
    }
    await db.batch(stmts);
    await notify(db, p.owner, p.id, 'mail-leveringsfejl', `Leveringsfejl på mail til ${p.company}. Tjek mailadressen.`);
    return;
  }
  if (m.kind === 'autosvar') {
    await db.batch(stmts);
    return;
  }
  if (m.direction === 'ud') {
    if (active && newer && (p.status === 'undersoeges' || p.status === 'klar')) {
      stmts.push(
        db.prepare("UPDATE prospects SET status = 'afventer', status_set_at = ?, status_set_by = 'system', version = version + 1, updated_at = ? WHERE id = ? AND status IN ('undersoeges', 'klar') AND (status_set_at IS NULL OR status_set_at < ? OR (status = 'undersoeges' AND status_set_at = created_at))").bind(Math.max(m.sentAt, p.status_set_at ?? 0), nowSec(), p.id, m.sentAt),
        addEvent(db, p.id, { kind: 'status', actor: 'system', at: m.sentAt, old_value: p.status, new_value: 'afventer', body: `Første udgående mail fra ${c.account}` }),
      );
    }
    if (!p.owner && personal) stmts.push(db.prepare('UPDATE prospects SET suggested_owner = COALESCE(suggested_owner, ?) WHERE id = ? AND owner IS NULL').bind(c.account, p.id));
    if (active && !p.follow_up_on) {
      const day = addWorkdays(today(m.sentAt), 5);
      stmts.push(
        db.prepare("UPDATE prospects SET follow_up_on = ?, next_action = COALESCE(next_action, 'Følg op på mail') WHERE id = ? AND follow_up_on IS NULL").bind(day, p.id),
        addEvent(db, p.id, { kind: 'followup', actor: 'system', new_value: day, body: `Foreslået opfølgning ${day} (fem arbejdsdage efter mailen). Kan ændres eller fravælges.` }),
      );
    }
    await db.batch(stmts);
    return;
  }
  // Menneskeligt svar: notifikation, opfølgningen markeres til gennemgang, "I dialog" foreslås (ændres ikke automatisk)
  if (active) {
    if (p.follow_up_on) stmts.push(db.prepare('UPDATE prospects SET follow_up_review = 1 WHERE id = ?').bind(p.id));
    if (newer && (p.status === 'undersoeges' || p.status === 'klar' || p.status === 'afventer')) stmts.push(db.prepare("UPDATE prospects SET suggested_status = 'dialog' WHERE id = ?").bind(p.id));
  }
  await db.batch(stmts);
  await notify(db, p.owner ?? (personal ? c.account : null), p.id, 'mail-svar', `${m.from?.name ?? m.from?.email ?? 'Kontakten'} har svaret${m.subject ? ` på "${m.subject}"` : ''} (${p.company}).`);
}

// ---------- Synkronisering ----------

async function knownAddresses(db: D1Database): Promise<string[]> {
  const [p, c] = await db.batch([
    db.prepare("SELECT DISTINCT pc.value AS e FROM prospect_contacts pc JOIN prospects p ON p.id = pc.prospect_id WHERE pc.kind = 'email' AND pc.unverified = 0 AND p.merged_into IS NULL LIMIT 3000"),
    db.prepare('SELECT email AS e FROM customers LIMIT 3000'),
  ]);
  return [...new Set([...((p?.results ?? []) as { e: string }[]), ...((c?.results ?? []) as { e: string }[])].map((x) => x.e))];
}

/** Virksomhedsdomæner på aktive kundeemner (mails herfra gemmes kun til gennemgang) */
async function knownDomains(db: D1Database): Promise<string[]> {
  const r = await db.prepare('SELECT DISTINCT domain AS d FROM prospects WHERE domain IS NOT NULL AND merged_into IS NULL AND archived_at IS NULL AND blacklisted = 0 LIMIT 1000').all<{ d: string }>();
  return (r.results ?? []).map((x) => x.d);
}

/** Søger efter beskeder med kendte adresser og domæner (første synkronisering og kontrol af manglende beskeder) */
async function backfill(c: Ctx, newerThanDays: number): Promise<number> {
  const addrs = [...(await knownAddresses(c.env.DB)), ...(await knownDomains(c.env.DB))];
  let stored = 0;
  for (let i = 0; i < addrs.length; i += 15) {
    const chunk = addrs.slice(i, i + 15);
    const q = `newer_than:${newerThanDays}d {${chunk.map((a) => `from:${a} to:${a} cc:${a}`).join(' ')}}`;
    let pageToken: string | undefined;
    for (let page = 0; page < 5; page++) {
      const res = await gmail<{ messages?: { id: string }[]; nextPageToken?: string }>(c.env, c.token, '/messages', { query: { q, maxResults: '100', pageToken } });
      for (const m of res.messages ?? []) {
        const known = await c.env.DB.prepare('SELECT 1 FROM mail_messages WHERE gmail_id = ? AND account = ?').bind(m.id, c.account).first();
        if (known) continue;
        if (await processMessage(c, await fetchMeta(c, m.id))) stored++;
      }
      if (!res.nextPageToken) break;
      pageToken = res.nextPageToken;
    }
  }
  return stored;
}

export async function syncAccount(env: Env, acc: MailAccountRow): Promise<void> {
  const db = env.DB;
  if (!acc.token_enc) return;
  const now = nowSec();
  try {
    const token = await accessToken(env, acc.email, acc.token_enc);
    const c: Ctx = { env, account: acc.email, token, veyroDomain: acc.email.split('@')[1]!, shared: sharedMailboxes(env) };
    let historyId = acc.history_id;
    let checked = acc.last_check_at;
    if (!historyId) {
      const prof = await gmail<{ historyId: string }>(env, token, '/profile');
      await backfill(c, 180);
      historyId = prof.historyId;
      checked = now;
    } else {
      try {
        let pageToken: string | undefined;
        let latest = historyId;
        for (let page = 0; page < 10; page++) {
          const h = await gmail<{ history?: { messagesAdded?: { message: { id: string } }[] }[]; historyId?: string; nextPageToken?: string }>(env, token, '/history', {
            query: { startHistoryId: historyId, historyTypes: 'messageAdded', maxResults: '500', pageToken },
          });
          for (const item of h.history ?? []) for (const a of item.messagesAdded ?? []) await processMessage(c, await fetchMeta(c, a.message.id));
          if (h.historyId) latest = h.historyId;
          if (!h.nextPageToken) break;
          pageToken = h.nextPageToken;
        }
        historyId = latest;
      } catch (err) {
        // Historikken er for gammel (404): fuld kontrol igen
        if (err instanceof GmailError && err.status === 404) {
          const prof = await gmail<{ historyId: string }>(env, token, '/profile');
          await backfill(c, 30);
          historyId = prof.historyId;
          checked = now;
        } else throw err;
      }
      // Kontrol af manglende beskeder én gang i døgnet
      if (!checked || checked < now - 86400) {
        await backfill(c, 3);
        checked = now;
      }
    }
    await db.prepare("UPDATE mail_accounts SET status = 'forbundet', history_id = ?, last_sync_at = ?, last_check_at = ?, last_error = NULL, attempts = 0, next_attempt_at = NULL, updated_at = ? WHERE email = ?")
      .bind(historyId, now, checked, now, acc.email)
      .run();
  } catch (err) {
    const reconnect = err instanceof GmailError && err.reconnect;
    const attempts = acc.attempts + 1;
    const msg = err instanceof GmailError ? err.message : err instanceof Error && err.name === 'TimeoutError' ? 'Google svarede ikke i tide' : 'Synkroniseringen fejlede';
    await db.prepare('UPDATE mail_accounts SET status = ?, last_error = ?, last_error_at = ?, attempts = ?, next_attempt_at = ?, updated_at = ? WHERE email = ?')
      .bind(reconnect ? 'genforbind' : 'fejl', msg.slice(0, 200), now, attempts, now + Math.min(3600, 60 * 2 ** attempts), now, acc.email)
      .run();
    await logError(db, `gmail.sync ${acc.email}`, new Error(msg));
  }
}

/** Cron: synkroniserer alle forbundne konti, der ikke venter på genforsøg */
export async function runMailSync(env: Env): Promise<void> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.MAIL_TOKEN_KEY) return;
  const { results } = await env.DB.prepare("SELECT * FROM mail_accounts WHERE token_enc IS NOT NULL AND status IN ('forbundet', 'fejl') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)").bind(nowSec()).all<MailAccountRow>();
  for (const acc of results ?? []) await syncAccount(env, acc);
}

// ---------- Manuel gennemgang og tilknytning ----------

async function ctxFor(env: Env, account: string): Promise<Ctx> {
  const acc = await env.DB.prepare('SELECT * FROM mail_accounts WHERE email = ?').bind(account).first<MailAccountRow>();
  if (!acc?.token_enc || acc.status === 'genforbind') throw new GmailError(`${account} er ikke forbundet.`, 400);
  return { env, account, token: await accessToken(env, account, acc.token_enc), veyroDomain: account.split('@')[1]!, shared: sharedMailboxes(env) };
}

/** Bekræfter en samtale til gennemgang: knytter den til emnet og henter indholdet */
export async function confirmThread(env: Env, t: ThreadRow, prospectId: number | null, customerId: number | null, actor: string): Promise<void> {
  const db = env.DB;
  await db.prepare("UPDATE mail_threads SET match_state = 'bekraeftet', prospect_id = ?, customer_id = ?, match_reason = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?")
    .bind(prospectId, customerId, `Bekræftet af ${staffName(actor)}`, actor, nowSec(), t.id)
    .run();
  const msgs = (await db.prepare('SELECT * FROM mail_messages WHERE thread_id = ? AND body_loaded = 0').bind(t.id).all<MessageRow>()).results ?? [];
  const ctxs = new Map<string, Ctx>();
  for (const m of msgs) {
    const c = ctxs.get(m.account) ?? (await ctxFor(env, m.account));
    ctxs.set(m.account, c);
    const full = await fetchFull(c, m.gmail_id);
    await db.prepare('UPDATE mail_messages SET body_text = ?, snippet = ?, body_loaded = 1 WHERE id = ?').bind(plainBody(full), (full.snippet ?? '').slice(0, 300), m.id).run();
  }
  if (prospectId) {
    const p = await getProspect(db, prospectId);
    if (p) await addEvent(db, p.id, { kind: 'mail', actor, body: `Mailsamtale "${t.subject ?? ''}" bekræftet og knyttet til (${msgs.length} beskeder)` }).run();
  }
}

/** Fjerner en forkert tilknyttet samtale: indholdet slettes i Veyro, og samtalen tilknyttes ikke igen automatisk */
export async function rejectThread(env: Env, t: ThreadRow, actor: string): Promise<void> {
  const db = env.DB;
  await db.batch([
    db.prepare('DELETE FROM mail_messages WHERE thread_id = ?').bind(t.id),
    db.prepare("UPDATE mail_threads SET match_state = 'afvist', match_reason = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?").bind(`Fjernet af ${staffName(actor)}`, actor, nowSec(), t.id),
    ...(t.prospect_id ? [addEvent(db, t.prospect_id, { kind: 'mail', actor, body: `Mailsamtale "${t.subject ?? ''}" fjernet fra kundeemnet (forkert tilknyttet). Originalen i Gmail er ikke berørt.` })] : []),
  ]);
}

/** Søger i én postkasse (kun metadata; intet gemmes) */
export async function searchMailbox(env: Env, account: string, q: string): Promise<{ threadId: string; id: string; from: string | null; subject: string | null; date: number }[]> {
  const c = await ctxFor(env, account);
  const res = await gmail<{ messages?: { id: string; threadId: string }[] }>(env, c.token, '/messages', { query: { q: q.slice(0, 200), maxResults: '20' } });
  const out = [];
  for (const m of res.messages ?? []) {
    const meta = await fetchMeta(c, m.id);
    out.push({ threadId: m.threadId, id: m.id, from: header(meta, 'From'), subject: header(meta, 'Subject'), date: meta.internalDate ? Math.floor(Number(meta.internalDate) / 1000) : 0 });
  }
  return out;
}

/** Knytter en Gmail-tråd manuelt til et kundeemne og henter dens beskeder */
export async function linkGmailThread(env: Env, account: string, gmailThread: string, prospect: ProspectRow, actor: string): Promise<number> {
  const c = await ctxFor(env, account);
  const t = await gmail<{ messages?: GmailMessage[] }>(env, c.token, `/threads/${encodeURIComponent(gmailThread)}`, { query: { format: 'metadata', metadataHeaders: META_HEADERS } });
  let n = 0;
  for (const m of t.messages ?? []) if (await processMessage(c, m, { force: { prospectId: prospect.id, customerId: prospect.customer_id, actor } })) n++;
  return n;
}

export async function createDraft(env: Env, account: string, raw: string): Promise<void> {
  const c = await ctxFor(env, account);
  await gmail(env, c.token, '/drafts', { method: 'POST', body: { message: { raw } } });
}
