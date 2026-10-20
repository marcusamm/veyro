// Demoforløb og nulstilling (kun når DEMO_MODE=1).

import { Hono } from 'hono';
import { html } from 'hono/html';
import type { AppEnv } from '../env';
import { emailConfigured } from '../lib/email';
import { DEMO_USERS, resetDemo, runDemoScenario, type DemoStep } from '../lib/demo';
import { runBilagScenario } from '../lib/bilagdemo';
import { actorOf, isDemo, render } from '../render';
import { pageHead } from '../views/common';
import { alert, csrfField, type H } from '../views/layout';

const demo = new Hono<AppEnv>();
const NAV = { portal: 'lager', tab: 'oversigt' } as const;

demo.use('*', async (c, next) => {
  if (!isDemo(c)) return c.notFound();
  await next();
});

function demoPage(d: { csrf: string; steps: DemoStep[] | null; mail: boolean; bilag?: boolean }): H {
  const ok = d.steps?.every((s) => s.checks.every((x) => x.ok));
  return html`<div class="stack-lg" style="max-width:900px">
  ${pageHead(
    'Demo',
    d.bilag ? 'Bilagsforløb (14 trin)' : 'Demoforløb',
    html`<a class="btn btn-ghost" href="/lager">← Oversigt</a>${d.bilag ? html`<a class="btn btn-secondary" href="/lager/demo">Lagerforløb</a>` : html`<a class="btn btn-secondary" href="/lager/demo/bilag">Bilagsforløb</a>`}`,
    d.bilag
      ? 'Upload → kontrollér digitalt bilag → fordel → godkend → eksportér, med dubletter, udlæg, retur, kreditnota og betaling. Bruger de samme funktioner som brugerfladen og fiktive bilag.'
      : 'Kører eksemplerne fra kravene igennem den rigtige lagermotor på nye forløbsvarer og to forløbsjob og viser tallene efter hvert trin.',
  )}
  ${d.mail ? '' : alert('info', html`E-mail er ikke sat op i demoen. E-mails bliver <strong>simuleret</strong>: de gemmes i e-mail-loggen, men sendes ikke.`)}
  <form method="post" action="/lager/demo${d.bilag ? '/bilag' : ''}" class="row">${csrfField(d.csrf)}<button class="btn btn-primary" type="submit">${d.steps ? 'Kør forløbet igen' : 'Kør demoforløbet'}</button></form>
  ${d.steps
    ? html`${ok ? alert('ok', 'Alle trin gav det forventede resultat.') : alert('err', 'Mindst ét trin gav ikke det forventede resultat.')}
      <ol class="steps-demo">${d.steps.map(
        (s, i) => html`<li class="stack">
        <div class="row-between"><strong>${i + 1}. ${s.title}</strong>${s.checks.every((x) => x.ok) ? html`<span class="tag tag-ok">Som forventet</span>` : html`<span class="tag tag-out">Afviger</span>`}</div>
        <p class="muted small" style="margin:0">${s.text}</p>
        <div class="table-wrap"><table class="mini"><thead><tr><th>Kontrol</th><th class="num">Forventet</th><th class="num">Faktisk</th><th></th></tr></thead><tbody>${s.checks.map(
          (x) => html`<tr><td>${x.label}</td><td class="num">${x.expected}</td><td class="num"><strong>${x.actual}</strong></td><td>${x.ok ? '✓' : '✗'}</td></tr>`,
        )}</tbody></table></div>
        ${s.link ? html`<a href="${s.link.href}">${s.link.label} →</a>` : ''}
      </li>`,
      )}</ol>`
    : d.bilag
      ? html`<div class="card stack"><p style="margin:0">Forløbet viser upload og aflæsning af en PDF-faktura, dublet, medarbejderudlæg, fordeling til lager og job, registrering af varemodtagelse uden dobbelttælling, godkendelse, retur med kreditnota, betaling og påmindelse, eksport og en rettelse efter eksport.</p></div>`
      : html`<div class="card stack"><p style="margin:0">Forløbet viser bl.a.:</p><ul style="margin:0">
        <li>Genbestillingspunkt 70 (forbrug 10 × leveringstid 5 + sikkerhedslager 20)</li>
        <li>Direkte forbrug af 30 og reservation af 30, hver med advarsel</li>
        <li>Udlevering, annulleret reservation og returnering</li>
        <li>Mangel på plader (30 behov, 18 på lager) på det rigtige jobs liste uden dubletter</li>
        <li>E-mail med indkøbslisten, delvis modtagelse reserveret til jobbet</li>
        <li>Blokeret forbrug og fakturagrundlag uden dobbelttælling</li>
      </ul></div>`}
</div>`;
}

demo.get('/', (c) => render(c, 'Demoforløb', demoPage({ csrf: c.get('csrf'), steps: null, mail: emailConfigured(c.env) }), NAV));

demo.post('/', async (c) => {
  const steps = await runDemoScenario(c.env, c.get('settings'), actorOf(c));
  return render(c, 'Demoforløb', demoPage({ csrf: c.get('csrf'), steps, mail: emailConfigured(c.env) }), NAV);
});

demo.get('/bilag', (c) => render(c, 'Bilagsforløb', demoPage({ csrf: c.get('csrf'), steps: null, mail: emailConfigured(c.env), bilag: true }), NAV));

demo.post('/bilag', async (c) => {
  const staff = { email: DEMO_USERS.medarbejder.email, name: DEMO_USERS.medarbejder.name };
  const steps = await runBilagScenario(c.env, c.get('settings'), actorOf(c), staff);
  return render(c, 'Bilagsforløb', demoPage({ csrf: c.get('csrf'), steps, mail: emailConfigured(c.env), bilag: true }), NAV);
});

demo.post('/nulstil', async (c) => {
  await resetDemo(c.env);
  return c.redirect('/lager?besked=nulstillet', 303);
});

export default demo;
