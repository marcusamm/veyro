// Gmail-integration i admin: forbind/afbryd konti, gennemgang af mulige mails, manuel tilknytning,
// mailsamtaler på kundeemner og Gmail-kladder. Personlige postkasser kan kun bruges af deres ejer;
// fælles postkasser (SHARED_MAILBOXES, fx kontakt@) kan bruges af alle i ADMIN_EMAILS.
import { Hono, type Context } from 'hono';
import type { AppEnv, Env } from '../env';
import { nowSec } from '../lib/crypto';
import { normalizeEmail } from '../lib/db';
import { logError } from '../lib/errlog';
import {
  GmailError,
  SCOPE_COMPOSE,
  SCOPE_READ,
  consumeState,
  encryptToken,
  exchangeCode,
  gmail,
  rawMessage,
  redirectUri,
  revoke,
  setupStatus,
  startOAuth,
} from '../lib/gmail';
import {
  confirmThread,
  createDraft,
  linkGmailThread,
  rejectThread,
  searchMailbox,
  syncAccount,
  type MailAccountRow,
  type MessageRow,
  type ThreadRow,
} from '../lib/gmail-sync';
import {
  activeBlocksFor,
  addEvent,
  companyDomain,
  getProspect,
  isSalesActive,
  listContacts,
  mailAccounts,
  sharedMailboxes,
  staffList,
  type ProspectRow,
} from '../lib/prospects';
import { isAdmin } from '../lib/session';
import { render } from '../render';
import { mailAccountsPage, mailSearchPage, prospectMailSection } from '../views/mail';
import { draftPage } from '../views/prospects';
import { errorPage } from '../views/pages';
import { adminGuard } from './admin-guard';

const r = new Hono<AppEnv>();
r.use('/kundeemner/*', adminGuard);

const who = (c: Context<AppEnv>) => c.get('session')!.email.toLowerCase();
const nav = { nav: 'admin-kundeemner' as const, admin: true };

/** Må brugeren bruge postkassen? Egen personlige eller en fælles. */
export function canUseMailbox(env: Env, me: string, account: string): boolean {
  return mailAccounts(env).includes(account) && (sharedMailboxes(env).has(account) || account === me);
}

/** Sikrer en række pr. konto i MAIL_ACCOUNTS */
async function ensureAccounts(env: Env): Promise<MailAccountRow[]> {
  const list = mailAccounts(env);
  if (list.length) {
    await env.DB.batch(list.map((e) => env.DB.prepare("INSERT OR IGNORE INTO mail_accounts (email, status, attempts, updated_at) VALUES (?, 'ikke_forbundet', 0, ?)").bind(e, nowSec())));
  }
  const rows = (await env.DB.prepare('SELECT * FROM mail_accounts').all<MailAccountRow>()).results ?? [];
  return list.map((e) => rows.find((x) => x.email === e)!).filter(Boolean);
}

const isConnected = (a: MailAccountRow) => !!a.token_enc && (a.status === 'forbundet' || a.status === 'fejl');
const hasCompose = (a: MailAccountRow) => isConnected(a) && (a.scopes ?? '').split(' ').includes(SCOPE_COMPOSE);

export async function senderOptions(c: Context<AppEnv>): Promise<{ email: string; connected: boolean; compose: boolean }[]> {
  const me = who(c);
  const rows = await ensureAccounts(c.env);
  return rows.filter((a) => canUseMailbox(c.env, me, a.email)).map((a) => ({ email: a.email, connected: isConnected(a), compose: hasCompose(a) }));
}

/** Mailsamtaler på kundeemnets side */
export async function mailSection(c: Context<AppEnv>, p: ProspectRow) {
  const db = c.env.DB;
  const me = who(c);
  const accounts = await ensureAccounts(c.env);
  const threads = (await db.prepare("SELECT * FROM mail_threads WHERE prospect_id = ? AND match_state != 'afvist' ORDER BY last_at DESC LIMIT 50").bind(p.id).all<ThreadRow>()).results ?? [];
  const ids = threads.map((t) => t.id);
  const msgs = ids.length
    ? ((await db.prepare(`SELECT * FROM mail_messages WHERE thread_id IN (${ids.map(() => '?').join(',')}) ORDER BY sent_at`).bind(...ids).all<MessageRow>()).results ?? [])
    : [];
  const shared = sharedMailboxes(c.env);
  const contacts = await listContacts(db, p.id);
  const emails = contacts.filter((x) => x.kind === 'email').map((x) => x.value);
  return prospectMailSection({
    csrf: c.get('csrf'),
    prospectId: p.id,
    anyConnected: accounts.some(isConnected),
    searchAccounts: accounts.filter((a) => isConnected(a) && canUseMailbox(c.env, me, a.email)).map((a) => a.email),
    defaultQuery: emails.length ? emails.map((e) => `from:${e} OR to:${e}`).join(' OR ') : p.domain ? `${p.domain}` : p.company,
    threads: threads.map((t) => {
      const mine = msgs.filter((m) => m.thread_id === t.id);
      const accs = new Set([t.account_hint, ...mine.map((m) => m.account)].filter(Boolean) as string[]);
      return {
        ...t,
        messages: mine,
        canReview: [...accs].some((a) => canUseMailbox(c.env, me, a)),
        sharedAccount: [...accs].some((a) => shared.has(a)),
      };
    }),
    staff: staffList(c.env),
  });
}

// ---------- Mailkonti ----------

r.get('/kundeemner/mail', async (c) => {
  const env = c.env;
  const me = who(c);
  const accounts = await ensureAccounts(env);
  const shared = sharedMailboxes(env);
  const usable = accounts.filter((a) => canUseMailbox(env, me, a.email)).map((a) => a.email);
  const review = usable.length
    ? ((
        await env.DB.prepare(
          `SELECT t.*, p.company AS prospect_company,
             (SELECT GROUP_CONCAT(DISTINCT m.from_addr) FROM mail_messages m WHERE m.thread_id = t.id) AS froms
           FROM mail_threads t LEFT JOIN prospects p ON p.id = t.prospect_id
           WHERE t.match_state = 'gennemgaa' AND t.account_hint IN (${usable.map(() => '?').join(',')})
           ORDER BY t.last_at DESC LIMIT 100`,
        )
          .bind(...usable)
          .all<ThreadRow & { prospect_company: string | null; froms: string }>()
      ).results ?? [])
    : [];
  return render(
    c,
    'Mailkonti',
    mailAccountsPage({
      csrf: c.get('csrf'),
      me,
      setup: setupStatus(env),
      redirectUri: redirectUri(env),
      accounts: accounts.map((a) => ({ ...a, canUse: canUseMailbox(env, me, a.email), shared: shared.has(a.email), compose: hasCompose(a) })),
      review,
      flash: c.req.query('besked') ?? null,
      error: c.req.query('fejl') ?? null,
      isStaff: (e) => isAdmin(env, e),
    }),
    nav,
  );
});

const toMail = (c: Context<AppEnv>, q: string) => c.redirect(`/admin/kundeemner/mail?${q}`, 303);

function accountParam(c: Context<AppEnv>): string | null {
  const raw = decodeURIComponent(c.req.param('account') ?? '').toLowerCase();
  return mailAccounts(c.env).includes(raw) ? raw : null;
}

r.post('/kundeemner/mail/konto/:account/forbind', async (c) => {
  const account = accountParam(c);
  const me = who(c);
  if (!account || !canUseMailbox(c.env, me, account)) return toMail(c, 'fejl=adgang');
  if (!setupStatus(c.env).ready) return toMail(c, 'fejl=opsaetning');
  const body = await c.req.parseBody();
  return c.redirect(await startOAuth(c.env, account, me, body['drafts'] === '1'), 303);
});

r.get('/kundeemner/mail/callback', async (c) => {
  const env = c.env;
  const me = who(c);
  const st = await consumeState(env, c.req.query('state') ?? '');
  // Engangs-state skal findes og være startet af den samme medarbejder
  if (!st || st.started_by !== me) return toMail(c, 'fejl=state');
  if (c.req.query('error') || !c.req.query('code')) return toMail(c, 'besked=annulleret');
  try {
    const tok = await exchangeCode(env, c.req.query('code')!, st.verifier);
    const scopes = (tok.scope ?? '').split(' ');
    if (!scopes.includes(SCOPE_READ)) return toMail(c, 'fejl=rettighed');
    if (!tok.refresh_token || !tok.access_token) return toMail(c, 'fejl=token');
    const prof = await gmail<{ emailAddress: string }>(env, tok.access_token, '/profile');
    if ((prof.emailAddress ?? '').toLowerCase() !== st.account) {
      // Forkert konto: adgangen kasseres og tilbagekaldes med det samme
      await revoke(env, st.account, await encryptToken(env, tok.refresh_token, st.account));
      return toMail(c, 'fejl=forkert');
    }
    const now = nowSec();
    const old = await env.DB.prepare('SELECT token_enc FROM mail_accounts WHERE email = ?').bind(st.account).first<{ token_enc: string | null }>();
    await env.DB.prepare(
      `UPDATE mail_accounts SET status = 'forbundet', connected_email = ?, token_enc = ?, scopes = ?, history_id = NULL, last_error = NULL, last_error_at = NULL,
         attempts = 0, next_attempt_at = NULL, connected_by = ?, connected_at = ?, updated_at = ? WHERE email = ?`,
    )
      .bind(prof.emailAddress.toLowerCase(), await encryptToken(env, tok.refresh_token, st.account), scopes.filter((s) => s === SCOPE_READ || s === SCOPE_COMPOSE).join(' '), me, now, now, st.account)
      .run();
    if (old?.token_enc) c.executionCtx.waitUntil(revoke(env, st.account, old.token_enc));
    const acc = await env.DB.prepare('SELECT * FROM mail_accounts WHERE email = ?').bind(st.account).first<MailAccountRow>();
    if (acc) await syncAccount(env, acc);
    return toMail(c, 'besked=forbundet');
  } catch (err) {
    await logError(env.DB, 'gmail.callback', new Error(err instanceof GmailError ? err.message : 'Fejl ved forbindelse'));
    return toMail(c, 'fejl=google');
  }
});

r.post('/kundeemner/mail/konto/:account/afbryd', async (c) => {
  const account = accountParam(c);
  if (!account || !canUseMailbox(c.env, who(c), account)) return toMail(c, 'fejl=adgang');
  const acc = await c.env.DB.prepare('SELECT * FROM mail_accounts WHERE email = ?').bind(account).first<MailAccountRow>();
  if (acc?.token_enc) await revoke(c.env, account, acc.token_enc);
  await c.env.DB.prepare(
    "UPDATE mail_accounts SET status = 'ikke_forbundet', token_enc = NULL, scopes = NULL, history_id = NULL, connected_email = NULL, last_error = NULL, attempts = 0, next_attempt_at = NULL, updated_at = ? WHERE email = ?",
  )
    .bind(nowSec(), account)
    .run();
  return toMail(c, 'besked=afbrudt');
});

r.post('/kundeemner/mail/konto/:account/synk', async (c) => {
  const account = accountParam(c);
  if (!account || !canUseMailbox(c.env, who(c), account)) return toMail(c, 'fejl=adgang');
  const acc = await c.env.DB.prepare('SELECT * FROM mail_accounts WHERE email = ?').bind(account).first<MailAccountRow>();
  if (!acc?.token_enc) return toMail(c, 'fejl=adgang');
  await syncAccount(c.env, acc);
  const after = await c.env.DB.prepare('SELECT status FROM mail_accounts WHERE email = ?').bind(account).first<{ status: string }>();
  return toMail(c, after?.status === 'forbundet' ? 'besked=synkroniseret' : 'fejl=sync');
});

// ---------- Gennemgang og tildeling ----------

async function threadFor(c: Context<AppEnv>): Promise<ThreadRow | null> {
  const id = Number(c.req.param('tid'));
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const t = await c.env.DB.prepare('SELECT * FROM mail_threads WHERE id = ?').bind(id).first<ThreadRow>();
  if (!t) return null;
  // Kun samtaler fra egen eller fælles postkasse
  const accs = ((await c.env.DB.prepare('SELECT DISTINCT account FROM mail_messages WHERE thread_id = ?').bind(t.id).all<{ account: string }>()).results ?? []).map((x) => x.account);
  const me = who(c);
  return [t.account_hint, ...accs].some((a) => a && canUseMailbox(c.env, me, a)) ? t : null;
}

const backTo = (c: Context<AppEnv>, body: Record<string, unknown>, t: ThreadRow, flash: string) =>
  body['back'] === '1' && t.prospect_id ? c.redirect(`/admin/kundeemner/${t.prospect_id}?besked=mail-${flash}#mail`, 303) : toMail(c, `besked=${flash}`);

r.post('/kundeemner/mail/samtale/:tid/bekraeft', async (c) => {
  const t = await threadFor(c);
  if (!t) return toMail(c, 'fejl=adgang');
  const body = await c.req.parseBody();
  const p = await getProspect(c.env.DB, Number(body['prospect']));
  if (!p) return render(c, 'Findes ikke', errorPage('Kundeemnet findes ikke', 'Tjek kundeemne-ID.', { href: '/admin/kundeemner/mail', label: 'Tilbage' }), { status: 404, ...nav });
  try {
    await confirmThread(c.env, t, p.id, p.customer_id, who(c));
  } catch (err) {
    await logError(c.env.DB, 'gmail.confirm', new Error(err instanceof GmailError ? err.message : 'Fejl'));
    return toMail(c, 'fejl=google');
  }
  return backTo(c, body, { ...t, prospect_id: p.id }, 'bekraeftet');
});

r.post('/kundeemner/mail/samtale/:tid/afvis', async (c) => {
  const t = await threadFor(c);
  if (!t) return toMail(c, 'fejl=adgang');
  const body = await c.req.parseBody();
  await rejectThread(c.env, t, who(c));
  return backTo(c, body, t, 'afvist');
});

r.post('/kundeemner/mail/samtale/:tid/tildel', async (c) => {
  const t = await threadFor(c);
  if (!t) return toMail(c, 'fejl=adgang');
  const body = await c.req.parseBody();
  const to = String(body['assigned_to'] ?? '').toLowerCase();
  const assigned = to && staffList(c.env).includes(to) ? to : null;
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE mail_threads SET assigned_to = ? WHERE id = ?').bind(assigned, t.id),
    ...(t.prospect_id ? [addEvent(c.env.DB, t.prospect_id, { kind: 'mail', actor: who(c), body: `Mailsamtale "${t.subject ?? ''}" ${assigned ? `tildelt ${assigned}` : 'ikke længere tildelt'}` })] : []),
  ]);
  return backTo(c, body, t, 'tildelt');
});

// ---------- Manuel søgning og tilknytning ----------

async function loadProspect(c: Context<AppEnv>): Promise<ProspectRow | null> {
  const id = Number(c.req.param('id'));
  return Number.isSafeInteger(id) && id > 0 ? getProspect(c.env.DB, id) : null;
}

r.get('/kundeemner/:id/mail/soeg', async (c) => {
  const p = await loadProspect(c);
  if (!p) return c.notFound();
  const account = (c.req.query('konto') ?? '').toLowerCase();
  if (!canUseMailbox(c.env, who(c), account)) return toMail(c, 'fejl=adgang');
  const q = (c.req.query('q') ?? '').trim().slice(0, 200);
  let results: Awaited<ReturnType<typeof searchMailbox>> = [];
  let error: string | null = null;
  if (q) {
    try {
      results = await searchMailbox(c.env, account, q);
    } catch (err) {
      error = err instanceof GmailError && err.status === 400 ? `${account} er ikke forbundet.` : 'Gmail svarede med en fejl. Prøv igen.';
    }
  }
  return render(c, 'Find mail', mailSearchPage({ csrf: c.get('csrf'), p, account, q, results, error }), nav);
});

r.post('/kundeemner/:id/mail/knyt', async (c) => {
  const p = await loadProspect(c);
  if (!p) return c.notFound();
  const body = await c.req.parseBody();
  const account = String(body['konto'] ?? '').toLowerCase();
  const thread = String(body['thread'] ?? '');
  if (!canUseMailbox(c.env, who(c), account) || !/^[0-9a-f]{6,32}$/i.test(thread)) return toMail(c, 'fejl=adgang');
  try {
    await linkGmailThread(c.env, account, thread, p, who(c));
  } catch (err) {
    await logError(c.env.DB, 'gmail.link', new Error(err instanceof GmailError ? err.message : 'Fejl'));
    return c.redirect(`/admin/kundeemner/${p.id}/mail/soeg?konto=${encodeURIComponent(account)}`, 303);
  }
  return c.redirect(`/admin/kundeemner/${p.id}?besked=mail-knyttet#mail`, 303);
});

// ---------- Gmail-kladde (oprettes kun ved klik; sendes aldrig) ----------

r.post('/kundeemner/:id/udkast/gmail', async (c) => {
  const p = await loadProspect(c);
  if (!p) return c.notFound();
  const me = who(c);
  const body = await c.req.parseBody();
  const sender = String(body['sender'] ?? '').toLowerCase();
  const subject = String(body['subject'] ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
  const text = String(body['body'] ?? '').slice(0, 10000);
  const to = normalizeEmail(String(body['to'] ?? ''));
  const senders = await senderOptions(c);
  const again = (error: string, status: 400 | 409 | 502) =>
    render(
      c,
      'Mailudkast',
      draftPage({ p, draft: { to: to ?? String(body['to'] ?? ''), subject, body: text, sources: [] }, senders, sender, kind: 'foerste', csrf: c.get('csrf'), flash: null, error }),
      { ...nav, status },
    );
  if (p.blacklisted || p.archived_at || p.status === 'afslag') return again('Der oprettes ikke salgskladder til blacklistede, arkiverede kundeemner eller afslag.', 409);
  if (!isSalesActive(p) && p.status !== 'dialog' && p.status !== 'kunde') return again('Kundeemnet er ikke aktivt.', 409);
  const s = senders.find((x) => x.email === sender);
  if (!s || !s.compose || !canUseMailbox(c.env, me, sender)) return again('Afsenderens Gmail er ikke forbundet med tilladelse til kladder.', 400);
  if (!to) return again('Skriv en gyldig modtageradresse.', 400);
  if ((await activeBlocksFor(c.env.DB, { company: p.company, cvr: p.cvr, domain: companyDomain(to), emails: [to] })).length) return again('Modtageren er blacklistet. Der oprettes ikke salgskladder.', 409);
  if (!subject || !text.trim()) return again('Skriv emne og tekst.', 400);
  try {
    await createDraft(c.env, sender, rawMessage(sender, to, subject, text));
  } catch (err) {
    await logError(c.env.DB, 'gmail.draft', new Error(err instanceof GmailError ? err.message : 'Fejl'));
    return again('Gmail svarede med en fejl. Kladden er ikke oprettet. Din tekst står herunder.', 502);
  }
  await addEvent(c.env.DB, p.id, { kind: 'mail', actor: me, body: `Kladde oprettet i Gmail (${sender} → ${to}): ${subject}. Ikke sendt.` }).run();
  return c.redirect(`/admin/kundeemner/${p.id}/udkast?afsender=${encodeURIComponent(sender)}&besked=kladde`, 303);
});

export default r;
