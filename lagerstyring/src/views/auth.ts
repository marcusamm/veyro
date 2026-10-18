import { html } from 'hono/html';
import { flash } from './common';
import { alert, csrfField, type H } from './layout';

export function loginPage(opts: { csrf: string; email?: string; error?: string; info?: string; next?: string | null; demo: boolean; company: string }): H {
  return html`<div class="narrow stack-lg" style="margin:0 auto">
  <div class="stack-sm">
    <div class="eyebrow">${opts.company}</div>
    <h1>Log ind</h1>
    <p class="muted">Lagerstyring, vareforbrug på job og indkøb. Du får et login-link på e-mail, så der er ingen adgangskode at huske.</p>
  </div>
  ${opts.error ? alert('err', opts.error) : ''}
  ${opts.info ? flash(opts.info) : ''}
  ${opts.demo
    ? html`<div class="card stack">
        <h2>Prøv demoen</h2>
        <p class="muted small">Log ind med ét klik. Data er fiktive og kan nulstilles under Indstillinger.</p>
        <div class="big-actions">
          <form method="post" action="/login/demo">
            ${csrfField(opts.csrf)}<input type="hidden" name="role" value="ejer">
            <button class="big-action primary btn-block" type="submit" style="text-align:left;cursor:pointer;font:inherit"><strong>Ejer / indkøber</strong><span>Lagerportal: lager, indkøb og fakturagrundlag</span></button>
          </form>
          <form method="post" action="/login/demo">
            ${csrfField(opts.csrf)}<input type="hidden" name="role" value="medarbejder">
            <button class="big-action btn-block" type="submit" style="text-align:left;cursor:pointer;font:inherit"><strong>Medarbejder</strong><span>Forbrugsportal: materialer på job</span></button>
          </form>
        </div>
      </div>`
    : ''}
  <form method="post" action="/login" class="card stack">
    ${csrfField(opts.csrf)}
    ${opts.next ? html`<input type="hidden" name="next" value="${opts.next}">` : ''}
    <div class="field">
      <label for="email">E-mail</label>
      <input id="email" name="email" type="email" autocomplete="email" required value="${opts.email ?? ''}">
    </div>
    <button class="btn btn-dark" type="submit">Send login-link</button>
  </form>
</div>`;
}

export function loginSentPage(devLink: string | null): H {
  return html`<div class="narrow stack-lg" style="margin:0 auto">
  <h1>Tjek din indbakke</h1>
  <p class="muted">Hvis e-mailen har adgang, har vi sendt et login-link. Linket virker i 15 minutter.</p>
  ${devLink ? alert('info', html`Udviklingstilstand: <a class="devlink" href="${devLink}">${devLink}</a>`) : ''}
  <a href="/login">Tilbage</a>
</div>`;
}

export function verifyPage(csrf: string, token: string, next: string | null): H {
  return html`<div class="narrow stack-lg" style="margin:0 auto">
  <h1>Bekræft login</h1>
  <form method="post" action="/login/bekraeft" class="card stack">
    ${csrfField(csrf)}
    <input type="hidden" name="token" value="${token}">
    ${next ? html`<input type="hidden" name="next" value="${next}">` : ''}
    <button class="btn btn-primary" type="submit">Log ind</button>
  </form>
</div>`;
}
