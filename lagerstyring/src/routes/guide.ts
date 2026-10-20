// Opsætningsguide: hvad der er sat op, og hvad der mangler. Status beregnes ud fra rigtige data.

import { Hono } from 'hono';
import { html } from 'hono/html';
import type { AppEnv } from '../env';
import { requireManager } from '../lib/session';
import { isDemo, render } from '../render';
import { pageHead } from '../views/common';
import type { H } from '../views/layout';

const guide = new Hono<AppEnv>();
guide.use('*', requireManager);

type State = 'ok' | 'mangler' | 'opsaetning';
interface Step {
  title: string;
  state: State;
  text: string | H;
  href?: string;
  link?: string;
}

guide.get('/', async (c) => {
  const db = c.env.DB;
  const s = c.get('settings');
  const n = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())?.n ?? 0;
  const [users, suppliers, products, priced, jobs, bilag, approved, exports, issued, payments] = await Promise.all([
    n('SELECT COUNT(*) AS n FROM users WHERE active = 1'),
    n('SELECT COUNT(*) AS n FROM suppliers'),
    n('SELECT COUNT(*) AS n FROM products WHERE active = 1'),
    n('SELECT COUNT(*) AS n FROM products WHERE active = 1 AND purchase_price IS NOT NULL'),
    n('SELECT COUNT(*) AS n FROM jobs'),
    n('SELECT COUNT(*) AS n FROM bilag'),
    n("SELECT COUNT(*) AS n FROM bilag WHERE status = 'godkendt'"),
    n('SELECT COUNT(*) AS n FROM exports'),
    n("SELECT COUNT(*) AS n FROM invoices WHERE status = 'udstedt'"),
    n('SELECT COUNT(*) AS n FROM invoice_payments WHERE deleted_at IS NULL'),
  ]);
  const company = !!(s.company_name && s.company_name !== 'Mit firma' && s.company_address && s.company_cvr);
  const steps: Step[] = [
    { title: 'Virksomhedens oplysninger', state: company ? 'ok' : 'mangler', text: company ? `${s.company_name}, CVR ${s.company_cvr}.` : 'Navn, adresse og CVR bruges på overslag, fakturaer og eksport. Bruges også til at genkende jeres eget CVR, når bilag aflæses.', href: '/lager/indstillinger', link: 'Indstillinger' },
    { title: 'Momsforhold', state: s.vat_registered ? 'ok' : 'mangler', text: s.vat_registered ? (s.vat_registered === 'ja' ? 'Momsregistreret: bilag fordeles ekskl. moms.' : 'Ikke momsregistreret: bilag fordeles inkl. moms.') : 'Angiv om virksomheden er momsregistreret. Uden det kan der ikke udstedes fakturaer. Systemet lægger aldrig selv 25 % moms på.', href: '/lager/indstillinger', link: 'Indstillinger' },
    { title: 'Bankoplysninger', state: s.bank_reg && s.bank_account ? 'ok' : 'mangler', text: 'Står på fakturaer og udkast til påmindelser.', href: '/lager/indstillinger', link: 'Indstillinger' },
    { title: 'Brugere og roller', state: users > 1 ? 'ok' : 'mangler', text: `${users} aktive brugere. Ejer og indkøber godkender bilag; medarbejdere kan uploade kvitteringer og udlæg.`, href: '/lager/indstillinger', link: 'Indstillinger' },
    { title: 'Leverandører', state: suppliers ? 'ok' : 'mangler', text: `${suppliers} leverandører. Kendte leverandører genkendes, når bilag aflæses.`, href: '/lager/indstillinger', link: 'Indstillinger' },
    { title: 'Varer og indkøbspriser', state: products && priced === products ? 'ok' : 'mangler', text: `${products} varer, ${priced} med indkøbspris.`, href: '/lager/varer', link: 'Varer og lager' },
    { title: 'Første job', state: jobs ? 'ok' : 'mangler', text: `${jobs} job.`, href: '/job', link: 'Job' },
    { title: 'Første bilag uploadet og godkendt', state: approved ? 'ok' : 'mangler', text: `${bilag} bilag, ${approved} godkendt.`, href: '/lager/bilag/ny', link: 'Upload bilag' },
    { title: 'Første eksport til bogholder', state: exports ? 'ok' : 'mangler', text: `${exports} eksporter. Aftal med bogholderen, om CSV-formatet (semikolon, komma som decimaltegn) passer.`, href: '/lager/bilag/eksport', link: 'Eksport' },
    { title: 'Betalinger på fakturaer', state: !issued || payments ? 'ok' : 'mangler', text: `${issued} udstedte fakturaer, ${payments} registrerede betalinger. Registreres manuelt; der er ingen bankforbindelse.`, href: '/job/faktura/opfolgning', link: 'Betalingsopfølgning' },
    { title: 'E-mail', state: c.env.RESEND_API_KEY ? 'ok' : 'opsaetning', text: c.env.RESEND_API_KEY ? 'E-mail er sat op.' : 'E-mail er ikke sat op: invitationer og advarsler simuleres og gemmes i e-mail-loggen. Påmindelser sendes aldrig automatisk.' },
    { title: 'Automatisk aflæsning af billeder (OCR)', state: 'opsaetning', text: "PDF'er med tekst aflæses automatisk. Fotos og indskannede PDF'er kræver OCR, som ikke er sat op; de registreres manuelt ud fra originalen. OCR kræver en ekstern tjeneste og en godkendt udgift." },
    { title: 'Regnskabsprogram og bank', state: 'opsaetning', text: 'Der er ingen integration til et regnskabsprogram eller banken. Bilag og fakturaer overføres med eksporten (ZIP), og intet markeres som bogført.' },
  ];
  const tag = (st: State) =>
    st === 'ok' ? html`<span class="tag tag-ok">Klar</span>` : st === 'mangler' ? html`<span class="tag tag-ready">Mangler</span>` : html`<span class="tag tag-sim">Kræver opsætning</span>`;
  const done = steps.filter((x) => x.state === 'ok').length;
  return render(
    c,
    'Opsætningsguide',
    html`<div class="stack-lg">
  ${pageHead(html`<a href="/lager/indstillinger">Indstillinger</a>`, 'Opsætningsguide', '', `${done} af ${steps.length} punkter er klar.${isDemo(c) ? ' Demoen bruger fiktive oplysninger.' : ''}`)}
  <ol class="card stack steps-list">${steps.map(
    (x) => html`<li class="stack-sm"><div class="row-between"><strong>${x.title}</strong>${tag(x.state)}</div><p class="muted">${x.text}</p>${x.href ? html`<a href="${x.href}">${x.link}</a>` : ''}</li>`,
  )}</ol>
</div>`,
    { portal: 'lager', tab: 'indstillinger' },
  );
});

export default guide;
