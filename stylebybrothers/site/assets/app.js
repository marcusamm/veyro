// StyleByBrothers — hjemmeside, booking og adminpanel (demo).
// Demoen gemmer alt i den besøgendes egen browser (localStorage). Intet sendes, og ingen tider reserveres hos salonen.
import * as E from './booking-engine.js';
import { SALON, defaultState } from './data.js';

const KEY = 'sbb-demo-v4';
const app = document.getElementById('app');

// ---------- lager ----------
function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && s.version === 4) return s;
    }
  } catch { /* privat vindue eller blokeret lager: kør videre i hukommelsen */ }
  return defaultState();
}
let state = load();
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); return true; } catch {
    toast('Kunne ikke gemme i browseren. Billedet er måske for stort.');
    return false;
  }
}

// ---------- hjælpere ----------
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kr = (n) => `${new Intl.NumberFormat('da-DK').format(n)} kr.`;
const now = () => Date.now();
const today = () => E.utcToZoned(now()).date;
const utcDate = (d) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd)); };
const fmtDate = (d, opts = { weekday: 'long', day: 'numeric', month: 'long' }) => new Intl.DateTimeFormat('da-DK', { ...opts, timeZone: 'UTC' }).format(utcDate(d));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const service = (id) => state.services.find((s) => s.id === id);
const barber = (id) => state.barbers.find((b) => b.id === id);
const initials = (name) => name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const uid = (p) => `${p}${Math.random().toString(36).slice(2, 8)}`;
const DAY_NAMES = ['søndag', 'mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag'];
const DAY_SHORT = ['søn', 'man', 'tir', 'ons', 'tor', 'fre', 'lør'];

/** Billedplads: viser billedet, eller en neutral flade med en note om, hvad der skal ind. */
function photo(src, alt, note, cls = '') {
  return `<div class="photo ${cls}">${src ? `<img src="${esc(src)}" alt="${esc(alt)}" loading="lazy" decoding="async">` : ''}<span class="ph">${esc(note || alt)}</span></div>`;
}
document.addEventListener('error', (e) => {
  const t = e.target;
  if (t.tagName === 'IMG' && t.closest('.photo')) t.remove();
}, true);

// Egen bekræftelsesdialog (window.confirm virker ikke i alle indlejrede visninger).
function ask(message, okLabel = 'Ja') {
  return new Promise((resolve) => {
    const d = document.createElement('div');
    d.className = 'ask';
    d.setAttribute('role', 'alertdialog');
    d.setAttribute('aria-modal', 'true');
    d.innerHTML = `<div class="ask-card"><p>${esc(message)}</p><div class="row"><button class="btn btn-sm" data-ok>${esc(okLabel)}</button><button class="btn btn-line btn-sm" data-no>Annuller</button></div></div>`;
    const done = (v) => { d.remove(); resolve(v); };
    d.addEventListener('click', (e) => { if (e.target.closest('[data-ok]')) done(true); else if (e.target.closest('[data-no]') || e.target === d) done(false); });
    d.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(false); });
    document.body.append(d);
    d.querySelector('[data-ok]').focus();
  });
}

let toastTimer;
function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); document.body.append(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

function bookAttrs(serviceId) {
  const ext = state.settings.externalBookingUrl;
  if (ext) return `href="${esc(ext)}" target="_blank" rel="noopener"`;
  return `href="#/booking${serviceId ? `?behandling=${encodeURIComponent(serviceId)}` : ''}"`;
}

// ---------- åbningstider (udledt af frisørernes arbejdstider) ----------
function salonDay(date) {
  if (E.isClosedDate(state.settings, date)) return null;
  const wd = E.weekday(date);
  let open = null;
  for (const b of state.barbers) {
    const h = b.active && !E.isAbsent(b, date) ? b.hours[wd] : null;
    if (!h?.start) continue;
    open = open ? { start: h.start < open.start ? h.start : open.start, end: h.end > open.end ? h.end : open.end } : { start: h.start, end: h.end };
  }
  return open;
}
function weekHours() {
  // Faste ugentlige tider (uden fravær og lukkedage), grupperet: "Mandag–fredag 11:30–17:30".
  const per = [1, 2, 3, 4, 5, 6, 0].map((wd) => {
    let open = null;
    for (const b of state.barbers) {
      const h = b.active ? b.hours[wd] : null;
      if (!h?.start) continue;
      open = open ? { start: h.start < open.start ? h.start : open.start, end: h.end > open.end ? h.end : open.end } : { start: h.start, end: h.end };
    }
    return { wd, text: open ? `${open.start}–${open.end}` : 'Lukket' };
  });
  const groups = [];
  for (const d of per) {
    const last = groups.at(-1);
    if (last && last.text === d.text) last.days.push(d.wd); else groups.push({ text: d.text, days: [d.wd] });
  }
  return groups.map((g) => ({
    label: cap(g.days.length > 1 ? `${DAY_NAMES[g.days[0]]}–${DAY_NAMES[g.days.at(-1)]}` : DAY_NAMES[g.days[0]]),
    text: g.text,
    today: g.days.includes(E.weekday(today())),
  }));
}
function todayLine() {
  const t = today();
  const nowMin = E.utcToZoned(now()).minutes;
  const h = salonDay(t);
  if (h && nowMin < E.parseTime(h.end)) {
    return nowMin < E.parseTime(h.start)
      ? { open: true, text: `Åbner i dag kl. ${h.start}` }
      : { open: true, text: `Åbent i dag til kl. ${h.end}` };
  }
  for (let i = 1; i <= 14; i++) {
    const d = E.addDays(t, i);
    const n = salonDay(d);
    if (n) return { open: false, text: `Lukket nu. Åbner ${i === 1 ? 'i morgen' : DAY_NAMES[E.weekday(d)]} kl. ${n.start}` };
  }
  return { open: false, text: 'Lukket' };
}

// ---------- fælles layout ----------
const demoBar = () => `<div class="demo-bar"><div class="wrap">Demo af en ny hjemmeside. Det er ikke salonens officielle side, og bookinger her er ikke rigtige.</div></div>`;

function header() {
  return `${demoBar()}<header class="site-header">
    <nav class="nav wrap" aria-label="Hovedmenu">
      <a class="wordmark" href="#/">StyleByBrothers</a>
      <ul class="nav-links">
        <li><a href="#/#priser">Priser</a></li>
        <li><a href="#/#klipninger">Klipninger</a></li>
        <li><a href="#/#salonen">Salonen</a></li>
        <li><a href="#/#find-os">Find os</a></li>
      </ul>
      <a class="btn" ${bookAttrs()}>Book tid</a>
      <button class="menu-btn" data-act="menu" aria-expanded="false" aria-controls="menu">Menu</button>
    </nav>
    <div class="mobile-menu wrap" id="menu" hidden>
      <ul>
        <li><a href="#/#priser">Priser</a></li>
        <li><a href="#/#klipninger">Klipninger</a></li>
        <li><a href="#/#salonen">Salonen</a></li>
        <li><a href="#/#find-os">Find os</a></li>
        <li><a href="#/min-booking">Flyt eller aflys en tid</a></li>
      </ul>
      <p>${SALON.street}, ${SALON.city} · ${SALON.phone}</p>
    </div>
  </header>`;
}

function footer() {
  return `<footer class="site-footer"><div class="wrap">
    <strong>StyleByBrothers</strong>
    <div class="foot-row"><span>${SALON.street}, ${SALON.city}</span><span>Tlf. ${SALON.phone}</span><span>CVR ${SALON.cvr}</span></div>
    <div class="foot-row"><a href="${SALON.facebook}" target="_blank" rel="noopener">Facebook</a><a href="${SALON.instagram}" target="_blank" rel="noopener">Instagram</a><a href="#/min-booking">Flyt eller aflys en tid</a><a href="#/admin">Admin</a></div>
  </div></footer>`;
}

// ---------- forside ----------
function renderHome(scrollTo) {
  const services = state.services.filter((s) => s.active);
  const open = todayLine();
  const team = state.barbers.filter((b) => b.active);
  const p = state.photos;
  app.innerHTML = `${header()}
  <main id="main">
    <div class="wrap intro">
      <div class="intro-text">
        <p class="kicker">Herrefrisør i Slagelse</p>
        <h1 class="t-xl">StyleByBrothers</h1>
        <p class="lead">Klip, fades og skæg på Sct. Mikkelsgade 26A. Find en tid online, eller ring på ${SALON.phone.replace('+45 ', '')}.</p>
        <div class="intro-actions"><a class="btn" ${bookAttrs()}>Book tid</a><a href="#/#priser">Se priser</a></div>
        <p class="open-now ${open.open ? '' : 'closed'}"><i aria-hidden="true"></i>${esc(open.text)}</p>
      </div>
      ${photo(p.hero.src, 'Fra salonen', p.hero.note)}
    </div>

    <section class="sec dark" id="priser" aria-labelledby="priser-titel">
      <div class="wrap prices">
        <div class="prices-head">
          <h2 class="t-l" id="priser-titel">Priser</h2>
          <p class="muted">Trænger du til en klipning? Tryk på en behandling, så ser du de ledige tider.</p>
        </div>
        <div>
          <ul class="price-list">
            ${services.map((s) => `<li><a ${bookAttrs(s.id)}>
              <span class="p-name">${esc(s.name)}</span><span class="p-price">${kr(s.price)}</span>
              <span class="p-desc">${esc(s.desc)}</span><span class="p-dur">${s.duration} min</span>
            </a></li>`).join('')}
          </ul>
          <p class="note" style="margin-top:14px">Betaling i salonen. Kan du ikke komme, så <a href="#/min-booking">flyt eller aflys din tid</a>.</p>
        </div>
      </div>
    </section>

    <section class="sec" id="klipninger" aria-labelledby="klip-titel">
      <div class="wrap">
        <h2 class="t-l sec-title" id="klip-titel">Klipninger</h2>
        <div class="gallery" id="gallery">${galleryItems()}</div>
        <p class="note gallery-note">Klipninger fra stolen på Sct. Mikkelsgade. Nyt arbejde lægges også op på <a href="${SALON.facebook}" target="_blank" rel="noopener">Facebook</a>.</p>
      </div>
    </section>

    <section class="sec" id="salonen" aria-labelledby="salon-titel">
      <div class="wrap">
        <div class="about">
          ${photo(p.salon.src, 'Salonen', p.salon.note)}
          <div class="about-text">
            <h2 class="t-l" id="salon-titel">Salonen</h2>
            <p>StyleByBrothers er en herrefrisør på Sct. Mikkelsgade i Slagelse. Vi klipper herrer og børn, mest fades, klassiske klip og skæg.</p>
            <p>Book online, ring, eller skriv til os på Facebook. Har du en fast frisør, kan du vælge ham, når du booker.</p>
          </div>
        </div>
        <h3 class="t-m" style="margin-top:56px">Holdet</h3>
        <div class="team" style="margin-top:14px">
          ${team.map((b) => `<div class="member">
            <div class="photo">${b.photo ? `<img src="${esc(b.photo)}" alt="${esc(b.name)}" loading="lazy">` : `<span class="initials">${esc(initials(b.name))}</span>`}</div>
            <div><h3>${esc(b.name)}</h3><p>${esc(b.role)}${b.role ? ' · ' : ''}${workDays(b)}</p><a class="small" href="#/booking?frisoer=${b.id}">Book hos ${esc(b.name)}</a></div>
          </div>`).join('')}
        </div>
      </div>
    </section>

    <section class="sec tight" id="find-os" aria-labelledby="find-titel">
      <div class="wrap contact">
        <div style="display:grid;gap:20px;align-content:start">
          <h2 class="t-l" id="find-titel">Find os</h2>
          <dl>
            <div><dt>Adresse</dt><dd>${SALON.street}<br>${SALON.city}<br><a class="small" href="${SALON.maps}" target="_blank" rel="noopener">Vis på kort</a></dd></div>
            <div><dt>Telefon</dt><dd><a href="${SALON.phoneHref}">${SALON.phone}</a></dd></div>
          </dl>
        </div>
        <dl>
          <div><dt>Åbningstider</dt><dd><table class="hours"><tbody>${weekHours().map((h) => `<tr class="${h.today ? 'is-today' : ''}"><td>${esc(h.label)}</td><td>${esc(h.text)}</td></tr>`).join('')}</tbody></table></dd></div>
          <div><dt>Følg med</dt><dd><a href="${SALON.facebook}" target="_blank" rel="noopener">Facebook</a> · <a href="${SALON.instagram}" target="_blank" rel="noopener">Instagram</a></dd></div>
        </dl>
        ${p.facade.src ? photo(p.facade.src, 'Facaden', p.facade.note) : ''}
      </div>
    </section>
  </main>
  ${footer()}`;
  document.title = 'StyleByBrothers · Herrefrisør i Slagelse';
  if (scrollTo) requestAnimationFrame(() => document.getElementById(scrollTo)?.scrollIntoView());
  else window.scrollTo(0, 0);
}

function workDays(b) {
  const days = [1, 2, 3, 4, 5, 6, 0].filter((d) => b.hours[d]?.start);
  if (!days.length) return '';
  const runs = [];
  for (const d of days) {
    const last = runs.at(-1);
    const idx = (x) => (x + 6) % 7; // mandag = 0
    if (last && idx(d) === idx(last.at(-1)) + 1) last.push(d); else runs.push([d]);
  }
  return runs.map((r) => (r.length > 2 ? `${DAY_SHORT[r[0]]}–${DAY_SHORT[r.at(-1)]}` : r.map((d) => DAY_SHORT[d]).join(', '))).join(', ');
}

function galleryItems() {
  return state.gallery.map((g) => `<figure class="g-item ${g.src ? 'has-img' : ''}">
      ${photo(g.src, g.title, g.title)}
      <figcaption class="g-cap">${esc(g.title)}</figcaption>
    </figure>`).join('');
}

function toggleMenu(open) {
  const m = document.getElementById('menu');
  if (!m) return;
  m.hidden = !open;
  document.querySelector('.menu-btn')?.setAttribute('aria-expanded', String(open));
  const btn = document.querySelector('.menu-btn');
  if (btn) btn.textContent = open ? 'Luk' : 'Menu';
}

// ---------- kalender (bruges af booking og flytning) ----------
function monthStart(d) { return `${d.slice(0, 7)}-01`; }
function addMonths(m, n) { const d = utcDate(m); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); }
function calendarHtml({ serviceId, barberId, month, selected, ignoreBookingId }) {
  const t = today();
  const last = E.addDays(t, state.settings.maxDaysAhead);
  const firstDow = (E.weekday(month) + 6) % 7; // mandag først
  const daysInMonth = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate();
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push('<span class="day blank"></span>');
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${month.slice(0, 8)}${String(d).padStart(2, '0')}`;
    const n = date < t || date > last ? 0 : E.availableSlots(state, { serviceId, barberId, date, now: now(), ignoreBookingId }).length;
    const closed = (state.settings.closedDates || []).find((c) => c.date === date);
    const label = `${fmtDate(date)}${n ? `, ${n} ledige tider` : closed ? `, lukket (${closed.note})` : ', ingen ledige tider'}`;
    cells.push(`<button type="button" class="day ${n ? 'avail' : ''} ${date === t ? 'is-today' : ''}" data-act="pick-date" data-date="${date}" aria-pressed="${date === selected}" aria-label="${esc(label)}" ${n ? '' : 'disabled'}>${d}</button>`);
  }
  const canPrev = month > monthStart(t);
  const canNext = addMonths(month, 1) <= last;
  const title = cap(new Intl.DateTimeFormat('da-DK', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(utcDate(month)));
  return `<div class="cal">
    <div class="cal-head"><strong>${title}</strong><div class="cal-nav"><button type="button" data-act="month" data-dir="-1" aria-label="Forrige måned" ${canPrev ? '' : 'disabled'}>‹</button><button type="button" data-act="month" data-dir="1" aria-label="Næste måned" ${canNext ? '' : 'disabled'}>›</button></div></div>
    <div class="cal-grid">${['ma', 'ti', 'on', 'to', 'fr', 'lø', 'sø'].map((d) => `<span class="cal-dow">${d}</span>`).join('')}${cells.join('')}</div>
    <p class="cal-note">Dage med fed skrift har ledige tider. Du kan booke op til ${state.settings.maxDaysAhead} dage frem.</p>
  </div>`;
}
function timesHtml({ serviceId, barberId, date, selected, ignoreBookingId }) {
  if (!date) return '';
  const slots = E.availableSlots(state, { serviceId, barberId, date, now: now(), ignoreBookingId });
  if (!slots.length) return `<div class="times"><p class="empty">Ingen ledige tider ${esc(fmtDate(date))}. Prøv en anden dag.</p></div>`;
  const groups = [['Formiddag', (m) => m < 720], ['Eftermiddag', (m) => m >= 720 && m < 1020], ['Aften', (m) => m >= 1020]];
  return `<div class="times" id="times"><p><strong>${esc(cap(fmtDate(date)))}</strong></p>
    ${groups.map(([name, f]) => {
      const g = slots.filter((x) => f(x.start));
      return g.length ? `<h3>${name}</h3><div class="time-grid">${g.map((x) => `<button type="button" class="time" data-act="pick-time" data-start="${x.start}" aria-pressed="${x.start === selected}">${E.fmtTime(x.start)}</button>`).join('')}</div>` : '';
    }).join('')}</div>`;
}
function firstAvailableDate(serviceId, barberId, ignoreBookingId) {
  const t = today();
  for (let i = 0; i <= state.settings.maxDaysAhead; i++) {
    const d = E.addDays(t, i);
    if (E.availableSlots(state, { serviceId, barberId, date: d, now: now(), ignoreBookingId }).length) return d;
  }
  return null;
}

// ---------- booking ----------
// Én side med fire trin under hinanden. Udfyldte trin viser valget og kan ændres.
let bk = null;

function startBooking(params) {
  const sid = params.get('behandling');
  const bid = params.get('frisoer');
  bk = { step: 1, serviceId: null, barberId: null, date: null, start: null, month: monthStart(today()), customer: { name: '', phone: '', email: '', note: '' }, errors: {}, notice: '' };
  if (bid && barber(bid)?.active) bk.presetBarber = bid;
  if (sid && service(sid)?.active) { bk.serviceId = sid; bk.step = 2; }
  if (bk.serviceId && bk.presetBarber && barber(bk.presetBarber).serviceIds.includes(bk.serviceId)) { bk.barberId = bk.presetBarber; goStep(3, false); }
  renderBooking();
  window.scrollTo(0, 0);
}

function goStep(n, render = true, focus = true) {
  bk.step = n;
  if (n !== 3) bk.notice = '';
  if (n === 3 && !bk.date) {
    bk.date = firstAvailableDate(bk.serviceId, bk.barberId);
    if (bk.date) bk.month = monthStart(bk.date);
  }
  if (render) {
    renderBooking();
    if (focus) document.querySelector('.step.current')?.scrollIntoView({ block: 'start' });
  }
}

function barberLabel(id) { return id === 'any' ? 'Første ledige' : barber(id)?.name || ''; }

function renderBooking() {
  if (!bk) return;
  const sv = service(bk.serviceId);
  const step = (n, title, value, body) => {
    const status = n < bk.step ? 'done' : n === bk.step ? 'current' : 'todo';
    return `<section class="step ${status}" aria-labelledby="step-${n}">
      <div class="step-head"><h2 id="step-${n}"><span>${n}</span>${title}</h2>${status === 'done' ? `<button class="link small" data-act="step" data-step="${n}">Ændr</button>` : ''}</div>
      ${status === 'done' ? `<p class="step-value">${value}</p>` : ''}
      ${status === 'current' ? `<div class="step-body">${body()}</div>` : ''}
    </section>`;
  };
  const s1 = () => `<ul class="choices" role="radiogroup" aria-label="Behandling">${state.services.filter((s) => s.active).map((s) => `<li>
      <button type="button" class="choice" role="radio" aria-checked="${s.id === bk.serviceId}" data-act="pick-service" data-id="${s.id}">
        <span class="dot"></span><span><strong>${esc(s.name)}</strong><small>${esc(s.desc)}</small></span>
        <span class="right">${kr(s.price)}<small>${s.duration} min</small></span>
      </button></li>`).join('')}</ul>`;
  const s2 = () => {
    const list = E.barbersFor(state, bk.serviceId, 'any');
    return `<ul class="choices" role="radiogroup" aria-label="Frisør">
      <li><button type="button" class="choice with-face" role="radio" aria-checked="${bk.barberId === 'any'}" data-act="pick-barber" data-id="any">
        <span class="dot"></span><span class="face" aria-hidden="true">–</span><span><strong>Første ledige</strong><small>Flest tider at vælge imellem</small></span></button></li>
      ${list.map((b) => `<li><button type="button" class="choice with-face" role="radio" aria-checked="${bk.barberId === b.id}" data-act="pick-barber" data-id="${b.id}">
        <span class="dot"></span><span class="face">${b.photo ? `<img src="${esc(b.photo)}" alt="">` : esc(initials(b.name))}</span><span><strong>${esc(b.name)}</strong><small>${esc(b.role)}${b.role ? ' · ' : ''}${workDays(b)}</small></span></button></li>`).join('')}
    </ul>`;
  };
  const s3 = () => `${bk.notice ? `<p class="notice danger" style="margin-bottom:16px">${esc(bk.notice)}</p>` : ''}
      ${bk.date ? '' : `<p class="empty">Der er ingen ledige tider de næste ${state.settings.maxDaysAhead} dage. Ring på ${SALON.phone}, så finder vi en tid.</p>`}
      ${calendarHtml({ serviceId: bk.serviceId, barberId: bk.barberId, month: bk.month, selected: bk.date })}
      ${timesHtml({ serviceId: bk.serviceId, barberId: bk.barberId, date: bk.date, selected: bk.start })}
      <div class="continue" id="continue">${bk.start != null ? `<button class="btn" data-act="step" data-step="4">Fortsæt med ${esc(fmtDate(bk.date, { weekday: 'short', day: 'numeric', month: 'short' }))} kl. ${E.fmtTime(bk.start)}</button>${bk.barberId === 'any' ? '<p class="note" style="margin-top:8px">Frisøren bliver valgt, når du bekræfter.</p>' : ''}` : ''}</div>`;
  const s4 = () => {
    const c = bk.customer;
    const err = bk.errors;
    const f = (id, label, type, extra = '', hint = '') => `<div class="field ${err[id] ? 'invalid' : ''}"><label for="f-${id}">${label}${hint ? ` <small>${hint}</small>` : ''}</label>
      <input id="f-${id}" name="${id}" type="${type}" value="${esc(c[id])}" ${extra} ${err[id] ? `aria-invalid="true" aria-describedby="e-${id}"` : ''}>${err[id] ? `<span class="err" id="e-${id}">${esc(err[id])}</span>` : ''}</div>`;
    return `<form class="form" id="customer-form" novalidate>
        ${f('name', 'Navn', 'text', 'autocomplete="name" required')}
        ${f('phone', 'Telefon', 'tel', 'autocomplete="tel" inputmode="tel" required', 'til påmindelse')}
        ${f('email', 'E-mail', 'email', 'autocomplete="email" required', 'til bekræftelsen')}
        <div class="field"><label for="f-note">Besked til frisøren <small>valgfri</small></label><textarea id="f-note" name="note" maxlength="500">${esc(c.note)}</textarea></div>
        <p class="note">Vi bruger kun dine oplysninger til bookingen. Demo: tiden bliver ikke reserveret, og der sendes ingen e-mail eller sms.</p>
        <div><button class="btn" type="submit">Book ${sv ? esc(sv.name.toLowerCase()) : 'tid'} ${bk.date ? `${esc(fmtDate(bk.date, { weekday: 'short', day: 'numeric', month: 'short' }))} kl. ${E.fmtTime(bk.start)}` : ''}</button></div>
      </form>`;
  };
  const timeValue = bk.date && bk.start != null ? `${esc(cap(fmtDate(bk.date)))} kl. ${E.fmtTime(bk.start)}` : '';
  app.innerHTML = `${header()}
  <main class="booking" id="main"><div class="wrap booking-grid">
    <div>
      <h1 class="t-l">Book tid</h1>
      <p class="booking-intro">Vælg behandling, frisør og tidspunkt. Du skal ikke oprette en konto.</p>
      ${step(1, 'Behandling', sv ? `${esc(sv.name)} · ${sv.duration} min · ${kr(sv.price)}` : '', s1)}
      ${step(2, 'Frisør', esc(barberLabel(bk.barberId)), s2)}
      ${step(3, 'Tidspunkt', timeValue, s3)}
      ${step(4, 'Dine oplysninger', '', s4)}
      <div class="steps-end"></div>
    </div>
    <aside class="summary" aria-label="Din booking"><h2>Din booking</h2>
      <dl>
        <div><dt>Behandling</dt><dd>${sv ? esc(sv.name) : '–'}</dd></div>
        <div><dt>Frisør</dt><dd>${bk.barberId ? esc(barberLabel(bk.barberId)) : '–'}</dd></div>
        <div><dt>Tid</dt><dd>${bk.start != null ? `${esc(fmtDate(bk.date, { weekday: 'short', day: 'numeric', month: 'short' }))}, ${E.fmtTime(bk.start)}` : '–'}</dd></div>
        <div class="total"><dt>Pris</dt><dd>${sv ? kr(sv.price) : '–'}</dd></div>
      </dl>
      <p>${SALON.street}, ${SALON.city}</p>
    </aside>
  </div></main>
  ${footer()}`;
  document.title = 'Book tid · StyleByBrothers';
  const form = document.getElementById('customer-form');
  if (form) {
    form.addEventListener('input', (e) => { bk.customer[e.target.name] = e.target.value; });
    form.addEventListener('submit', (e) => { e.preventDefault(); submitBooking(); });
    form.querySelector('[aria-invalid="true"]')?.focus();
  }
}

function submitBooking() {
  const r = E.createBooking(state, { serviceId: bk.serviceId, barberId: bk.barberId, date: bk.date, start: bk.start, customer: bk.customer }, now());
  if (!r.ok && r.error === 'invalid') { bk.errors = r.errors; renderBooking(); return; }
  if (!r.ok) {
    bk.start = null;
    bk.notice = 'Tiden blev taget, mens du bookede. Vælg en anden tid.';
    goStep(3);
    return;
  }
  queueMessages(r.booking, 'oprettet');
  save();
  history.replaceState(null, '', `#/booking/bekraeftet?ref=${r.booking.ref}`);
  renderConfirmation(r.booking);
}

// Simulerede udsendelser. I drift sendes e-mail via fx Resend og sms via en sms-udbyder (se README).
function queueMessages(b, kind) {
  const br = barber(b.barberId);
  const when = `${cap(fmtDate(b.date))} kl. ${E.fmtTime(b.start)}`;
  const at = new Date(now()).toISOString();
  const subject = { oprettet: `Din tid hos StyleByBrothers: ${when}`, flyttet: `Din tid er flyttet til ${when}`, aflyst: `Din tid ${when} er aflyst` }[kind];
  state.outbox.unshift({ id: uid('m'), at, type: 'E-mail', to: b.email, subject, body: `Hej ${b.name.split(' ')[0]}\n\n${b.serviceName} hos ${br?.name || 'StyleByBrothers'}\n${when}\n${SALON.street}, ${SALON.city}\nPris: ${kr(b.price)}\nBookingnummer: ${b.ref}\n\nFlyt eller aflys på hjemmesiden under "Flyt eller aflys en tid".` });
  if (kind === 'oprettet') state.outbox.unshift({ id: uid('m'), at, type: 'Sms', to: b.phone, subject: 'Sendes dagen før', body: `Hej ${b.name.split(' ')[0]}. Husk din tid hos StyleByBrothers i morgen kl. ${E.fmtTime(b.start)}. Bookingnr. ${b.ref}` });
  state.outbox = state.outbox.slice(0, 60);
}

function gcalLink(b) {
  const dt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const start = new Date(b.startUtc);
  const end = new Date(start.getTime() + (b.end - b.start) * 60000);
  const q = new URLSearchParams({ action: 'TEMPLATE', text: `${b.serviceName}, StyleByBrothers`, dates: `${dt(start)}/${dt(end)}`, location: `${SALON.street}, ${SALON.city}`, details: `Bookingnummer ${b.ref}` });
  return `https://calendar.google.com/calendar/render?${q}`;
}
function icsFor(b) {
  const dt = (iso) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const start = new Date(b.startUtc);
  const end = new Date(start.getTime() + (b.end - b.start) * 60000);
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//StyleByBrothers//Booking//DA', 'BEGIN:VEVENT', `UID:${b.id}@stylebybrothers`, `DTSTAMP:${dt(new Date().toISOString())}`,
    `DTSTART:${dt(start.toISOString())}`, `DTEND:${dt(end.toISOString())}`, `SUMMARY:${b.serviceName}\\, StyleByBrothers`,
    `LOCATION:${SALON.street}\\, ${SALON.city}`, `DESCRIPTION:Bookingnummer ${b.ref}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}

function renderConfirmation(b) {
  const br = barber(b.barberId);
  app.innerHTML = `${header()}
  <main class="booking" id="main"><div class="wrap narrow">
    <h1 class="t-l">Tak, ${esc(b.name.split(' ')[0])}. Du er booket.</h1>
    <p class="booking-intro">Bekræftelsen sendes til ${esc(b.email)}. <strong>Demo:</strong> der er ikke sendt noget, og tiden er ikke reserveret.</p>
    <dl class="receipt">
      <div><dt>Hvornår</dt><dd>${esc(cap(fmtDate(b.date)))} kl. ${E.fmtTime(b.start)}–${E.fmtTime(b.end)}</dd></div>
      <div><dt>Behandling</dt><dd>${esc(b.serviceName)}</dd></div>
      <div><dt>Frisør</dt><dd>${esc(br?.name || '')}</dd></div>
      <div><dt>Pris</dt><dd>${kr(b.price)} <span class="muted" style="font-weight:400">betales i salonen</span></dd></div>
      <div><dt>Adresse</dt><dd>${SALON.street}, ${SALON.city}<br><a class="small" style="font-weight:400" href="${SALON.maps}" target="_blank" rel="noopener">Vis på kort</a></dd></div>
      <div><dt>Bookingnr.</dt><dd class="ref">${esc(b.ref)}</dd></div>
    </dl>
    <div class="actions">
      <a class="btn" href="${gcalLink(b)}" target="_blank" rel="noopener">Læg i Google Kalender</a>
      <button class="btn btn-line" data-act="ics" data-ref="${b.ref}">Hent kalenderfil</button>
    </div>
    <p class="note" style="margin-top:28px">Kan du ikke komme? <a href="#/min-booking?ref=${b.ref}">Flyt eller aflys</a> senest ${state.settings.cancelNoticeMinutes / 60 >= 1 ? `${state.settings.cancelNoticeMinutes / 60} timer` : `${state.settings.cancelNoticeMinutes} minutter`} før, eller ring på ${SALON.phone}.</p>
  </div></main>
  ${footer()}`;
  document.title = 'Du er booket · StyleByBrothers';
  window.scrollTo(0, 0);
}

// ---------- flyt eller aflys ----------
let mb = null;
function renderManage(params) {
  if (!mb || params) mb = { ref: params?.get('ref') || '', phone: '', booking: null, moving: false, date: null, start: null, month: monthStart(today()), msg: '', msgKind: '' };
  const b = mb.booking;
  let inner;
  if (!b) {
    inner = `<form class="form" id="find-form" novalidate>
      <div class="field"><label for="m-ref">Bookingnummer <small>står i din bekræftelse</small></label><input id="m-ref" name="ref" value="${esc(mb.ref)}" autocomplete="off" autocapitalize="characters" required></div>
      <div class="field"><label for="m-phone">Telefonnummer</label><input id="m-phone" name="phone" type="tel" inputmode="tel" value="${esc(mb.phone)}" required></div>
      <div><button class="btn" type="submit">Find min tid</button></div>
    </form>`;
  } else {
    const br = barber(b.barberId);
    const changeable = E.canChange(state, b, now());
    const sel = b.anyBarber ? 'any' : b.barberId;
    inner = `<dl class="receipt">
        <div><dt>Hvornår</dt><dd>${esc(cap(fmtDate(b.date)))} kl. ${E.fmtTime(b.start)}</dd></div>
        <div><dt>Behandling</dt><dd>${esc(b.serviceName)}, ${kr(b.price)}</dd></div>
        <div><dt>Frisør</dt><dd>${esc(br?.name || '')}</dd></div>
        <div><dt>Status</dt><dd>${b.status === 'confirmed' ? 'Booket' : 'Aflyst'}</dd></div>
      </dl>
      ${b.status === 'confirmed' && !changeable ? `<p class="notice" style="margin-top:20px">Tiden er så tæt på, at den ikke kan ændres online. Ring på ${SALON.phone}.</p>` : ''}
      ${changeable && !mb.moving ? `<div class="actions"><button class="btn" data-act="mb-move">Flyt tiden</button><button class="btn btn-line" data-act="mb-cancel">Aflys tiden</button></div>` : ''}
      ${mb.moving ? `<div style="margin-top:32px"><h2 class="t-m" style="margin-bottom:14px">Vælg en ny tid</h2>
        ${calendarHtml({ serviceId: b.serviceId, barberId: sel, month: mb.month, selected: mb.date, ignoreBookingId: b.id })}
        ${timesHtml({ serviceId: b.serviceId, barberId: sel, date: mb.date, selected: mb.start, ignoreBookingId: b.id })}
        <div class="actions"><button class="btn" data-act="mb-save" ${mb.start == null ? 'disabled' : ''}>${mb.start != null ? `Flyt til ${esc(fmtDate(mb.date, { weekday: 'short', day: 'numeric', month: 'short' }))} kl. ${E.fmtTime(mb.start)}` : 'Vælg en tid'}</button><button class="btn btn-line" data-act="mb-stop">Fortryd</button></div></div>` : ''}
      <p style="margin-top:28px"><button class="link small" data-act="mb-reset">Find en anden booking</button></p>`;
  }
  app.innerHTML = `${header()}
  <main class="booking" id="main"><div class="wrap narrow">
    <h1 class="t-l">Flyt eller aflys en tid</h1>
    <p class="booking-intro">Skriv dit bookingnummer og det telefonnummer, du bookede med.</p>
    ${mb.msg ? `<p class="notice ${mb.msgKind}" style="margin-bottom:20px" role="status">${esc(mb.msg)}</p>` : ''}
    ${inner}
  </div></main>${footer()}`;
  document.title = 'Flyt eller aflys · StyleByBrothers';
  document.getElementById('find-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    mb.ref = fd.get('ref'); mb.phone = fd.get('phone');
    mb.booking = E.findBooking(state, mb.ref, mb.phone);
    mb.msg = mb.booking ? '' : 'Vi kan ikke finde en booking med det nummer og telefonnummer. Tjek bekræftelsen, eller ring til os.';
    mb.msgKind = mb.booking ? '' : 'danger';
    renderManage();
  });
}

// ---------- admin ----------
const ADMIN_TABS = [['bookinger', 'Bookinger'], ['behandlinger', 'Behandlinger'], ['frisoerer', 'Frisører'], ['regler', 'Tider og regler'], ['billeder', 'Billeder'], ['beskeder', 'Udsendelser']];
let adminDate = null;
let adminMove = null;
function isAdmin() { try { return sessionStorage.getItem('sbb-admin') === '1'; } catch { return window.__sbbAdmin === true; } }

function renderAdmin(tab = 'bookinger') {
  if (!isAdmin()) {
    app.innerHTML = `<div class="admin"><div class="wrap"><div class="login-card">
      <a class="wordmark" href="#/">StyleByBrothers</a>
      <h1>Admin</h1>
      <p class="muted">Når siden er i drift, logger ejeren og frisørerne ind med et link på e-mail. I demoen kan du gå direkte ind.</p>
      <button class="btn btn-block" data-act="admin-login">Gå til admin</button>
      <a class="small" href="#/">Tilbage til hjemmesiden</a>
    </div></div></div>`;
    document.title = 'Admin · StyleByBrothers';
    return;
  }
  if (!ADMIN_TABS.some(([id]) => id === tab)) tab = 'bookinger';
  const views = { bookinger: adminBookings, behandlinger: adminServices, frisoerer: adminBarbers, regler: adminRules, billeder: adminPhotos, beskeder: adminOutbox };
  app.innerHTML = `<div class="admin">
    <div class="admin-top">${demoBar()}<div class="nav wrap"><a class="wordmark" href="#/">StyleByBrothers<small>admin</small></a>
      <a class="btn btn-sm hide-sm" href="#/">Se siden</a><button class="btn btn-sm" data-act="admin-logout">Log ud</button></div>
      <nav class="admin-tabs wrap" aria-label="Admin">${ADMIN_TABS.map(([id, label]) => `<a href="#/admin/${id}" ${id === tab ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
    </div>
    <div class="wrap admin-body">${views[tab]()}</div>
  </div>`;
  document.title = `Admin · ${ADMIN_TABS.find(([id]) => id === tab)[1]} · StyleByBrothers`;
}

function adminBookings() {
  adminDate ||= today();
  const barbers = state.barbers.filter((b) => b.active);
  const dayBookings = state.bookings.filter((b) => b.date === adminDate).sort((a, b) => a.start - b.start);
  const upcoming = state.bookings.filter((b) => b.status === 'confirmed' && b.date >= today()).length;
  const closed = state.settings.closedDates.find((c) => c.date === adminDate);
  const card = (b) => {
    const moving = adminMove?.id === b.id;
    return `<article class="bk ${b.status}">
      <time>${E.fmtTime(b.start)}<small>${E.fmtTime(b.end)}</small></time>
      <div><h3>${esc(b.name)} ${b.status === 'cancelled' ? '<span class="tag off">Aflyst</span>' : ''}${b.example ? ' <span class="tag">Eksempel</span>' : ''}</h3>
        <p>${esc(b.serviceName)} · ${kr(b.price)}${b.anyBarber ? ' · første ledige' : ''}</p>
        <p>${esc(b.phone)} · ${esc(b.email)} · ${esc(b.ref)}</p>
        ${b.note ? `<p>“${esc(b.note)}”</p>` : ''}
        ${b.status === 'confirmed' ? (moving ? `<div class="grid-2" style="margin-top:10px">
            <div class="field"><label>Ny dato</label><input type="date" data-act-change="move-date" value="${adminMove.date}" min="${today()}"></div>
            <div class="field"><label>Ny tid</label><select data-act-change="move-time"><option value="">Vælg</option>${E.availableSlots(state, { serviceId: b.serviceId, barberId: adminMove.barberId, date: adminMove.date, now: now(), ignoreBookingId: b.id }).map((s) => `<option value="${s.start}" ${adminMove.start === s.start ? 'selected' : ''}>${E.fmtTime(s.start)}</option>`).join('')}</select></div>
            <div class="field"><label>Frisør</label><select data-act-change="move-barber"><option value="any">Første ledige</option>${E.barbersFor(state, b.serviceId, 'any').map((x) => `<option value="${x.id}" ${adminMove.barberId === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
            <div class="row"><button class="btn btn-sm" data-act="move-save" data-id="${b.id}">Gem</button><button class="btn btn-line btn-sm" data-act="move-stop">Fortryd</button></div>
          </div>` : `<div class="row"><button class="btn btn-line btn-sm" data-act="move-start" data-id="${b.id}">Flyt</button><button class="btn btn-line btn-sm" data-act="admin-cancel" data-id="${b.id}">Aflys</button></div>`) : ''}
      </div>
    </article>`;
  };
  return `<div class="row between" style="margin-bottom:18px"><div><h1>Bookinger</h1><p class="muted">${upcoming} kommende. Alt er demodata i din browser.</p></div>
      <button class="btn btn-line btn-sm" data-act="seed">Lav eksempelbookinger</button></div>
    <div class="panel" style="margin-bottom:16px"><div class="row between">
      <div class="row"><button class="btn btn-line btn-sm" data-act="admin-day" data-dir="-1" aria-label="Forrige dag">‹</button>
      <input class="input" type="date" value="${adminDate}" data-act-change="admin-date" style="width:auto" aria-label="Dato">
      <button class="btn btn-line btn-sm" data-act="admin-day" data-dir="1" aria-label="Næste dag">›</button>
      <button class="btn btn-sm" data-act="admin-today">I dag</button></div>
      <strong>${esc(cap(fmtDate(adminDate, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })))}</strong></div>
      ${closed ? `<p class="notice" style="margin-top:12px">Lukket: ${esc(closed.note)}</p>` : ''}
    </div>
    <div class="day-cols" style="--cols:${barbers.length}">
      ${barbers.map((br) => {
        const list = dayBookings.filter((b) => b.barberId === br.id);
        const h = br.hours[E.weekday(adminDate)];
        const off = !h || E.isAbsent(br, adminDate) || closed;
        return `<div><p class="col-head">${esc(br.name)} · ${off ? 'fri' : `${h.start}–${h.end}`}</p><div class="bk-list">${list.length ? list.map(card).join('') : '<p class="empty">Ingen bookinger</p>'}</div></div>`;
      }).join('')}
    </div>`;
}

function adminServices() {
  return `<div class="row between" style="margin-bottom:18px"><div><h1>Behandlinger</h1><p class="muted">Ændringer gemmes med det samme og vises på siden og i bookingen.</p></div><button class="btn btn-sm" data-act="service-add">Ny behandling</button></div>
    ${state.services.map((s, i) => `<div class="panel">
      <div class="row between"><h2>${esc(s.name)} ${s.active ? '' : '<span class="tag off">Skjult</span>'}</h2>
        <div class="row"><button class="btn btn-line btn-sm" data-act="service-move" data-id="${s.id}" data-dir="-1" aria-label="Flyt op" ${i === 0 ? 'disabled' : ''}>↑</button><button class="btn btn-line btn-sm" data-act="service-move" data-id="${s.id}" data-dir="1" aria-label="Flyt ned" ${i === state.services.length - 1 ? 'disabled' : ''}>↓</button></div></div>
      <div class="grid-2">
        <div class="field"><label>Navn</label><input data-path="services:${s.id}:name" value="${esc(s.name)}"></div>
        <div class="grid-2"><div class="field"><label>Pris (kr.)</label><input type="number" min="0" step="5" data-path="services:${s.id}:price" value="${s.price}"></div>
        <div class="field"><label>Varighed (min)</label><input type="number" min="5" max="240" step="5" data-path="services:${s.id}:duration" value="${s.duration}"></div></div>
        <div class="field" style="grid-column:1/-1"><label>Kort beskrivelse</label><input data-path="services:${s.id}:desc" maxlength="80" value="${esc(s.desc)}"></div>
      </div>
      <div class="row between" style="margin-top:10px"><label class="row"><input type="checkbox" data-path="services:${s.id}:active" ${s.active ? 'checked' : ''}> Vis på siden og i bookingen</label><button class="link small" data-act="service-del" data-id="${s.id}">Slet</button></div>
    </div>`).join('')}`;
}

function adminBarbers() {
  const days = [[1, 'Man'], [2, 'Tir'], [3, 'Ons'], [4, 'Tor'], [5, 'Fre'], [6, 'Lør'], [0, 'Søn']];
  return `<div class="row between" style="margin-bottom:18px"><div><h1>Frisører</h1><p class="muted">Hver frisør har sin egen kalender. Åbningstiderne på siden regnes ud fra arbejdstiderne her.</p></div><button class="btn btn-sm" data-act="barber-add">Ny frisør</button></div>
    ${state.barbers.map((b) => `<div class="panel">
      <div class="row" style="gap:16px;margin-bottom:12px">
        <div class="avatar-lg">${b.photo ? `<img src="${esc(b.photo)}" alt="">` : esc(initials(b.name))}</div>
        <div class="row"><span class="btn btn-line btn-sm file-btn">Upload billede<input type="file" accept="image/*" data-upload="barber" data-id="${b.id}" aria-label="Upload billede af ${esc(b.name)}"></span>${b.photo ? `<button class="link small" data-act="barber-photo-del" data-id="${b.id}">Fjern billede</button>` : ''}</div>
      </div>
      <div class="grid-2">
        <div class="field"><label>Navn</label><input data-path="barbers:${b.id}:name" value="${esc(b.name)}"></div>
        <div class="field"><label>Speciale</label><input data-path="barbers:${b.id}:role" value="${esc(b.role)}"></div>
      </div>
      <p class="col-head" style="margin-top:16px">Behandlinger</p>
      <div class="check-list">${state.services.map((s) => `<label><input type="checkbox" data-act-change="barber-service" data-id="${b.id}" data-service="${s.id}" ${b.serviceIds.includes(s.id) ? 'checked' : ''}> ${esc(s.name)}</label>`).join('')}</div>
      <p class="col-head" style="margin-top:16px">Arbejdstider</p>
      <div class="table-scroll"><table class="hours-table"><thead><tr><th>Dag</th><th>Arbejder</th><th>Fra</th><th>Til</th><th>Pause fra</th><th>Pause til</th></tr></thead><tbody>
        ${days.map(([d, label]) => { const h = b.hours[d]; return `<tr><td>${label}</td><td><input type="checkbox" data-act-change="barber-day" data-id="${b.id}" data-day="${d}" ${h ? 'checked' : ''} aria-label="Arbejder ${label}"></td>
          ${['start', 'end', 'breakStart', 'breakEnd'].map((k) => `<td><input type="time" step="900" data-path="barbers:${b.id}:hours:${d}:${k}" value="${h ? esc(h[k] || '') : ''}" ${h ? '' : 'disabled'} aria-label="${label} ${k}"></td>`).join('')}</tr>`; }).join('')}
      </tbody></table></div>
      <p class="col-head" style="margin-top:16px">Ferie og fravær</p>
      ${(b.absences || []).map((a, i) => `<div class="row" style="margin-bottom:6px"><span class="tag">${esc(fmtDate(a.from, { day: 'numeric', month: 'short' }))} – ${esc(fmtDate(a.to || a.from, { day: 'numeric', month: 'short', year: 'numeric' }))}</span><span class="muted">${esc(a.note || '')}</span><button class="link small" data-act="absence-del" data-id="${b.id}" data-i="${i}">Fjern</button></div>`).join('') || '<p class="muted small" style="margin-bottom:8px">Intet fravær.</p>'}
      <div class="grid-3" style="align-items:end"><div class="field"><label for="abs-from-${b.id}">Fra</label><input type="date" id="abs-from-${b.id}" min="${today()}"></div><div class="field"><label for="abs-to-${b.id}">Til</label><input type="date" id="abs-to-${b.id}" min="${today()}"></div><div class="row"><input class="input" id="abs-note-${b.id}" placeholder="Fx ferie" style="flex:1;min-width:120px" aria-label="Note"><button class="btn btn-sm" data-act="absence-add" data-id="${b.id}">Tilføj</button></div></div>
      <div class="row between" style="margin-top:14px"><label class="row"><input type="checkbox" data-path="barbers:${b.id}:active" ${b.active ? 'checked' : ''}> Kan bookes</label><button class="link small" data-act="barber-del" data-id="${b.id}">Slet frisør</button></div>
    </div>`).join('')}`;
}

function adminRules() {
  const s = state.settings;
  return `<h1>Tider og regler</h1><p class="muted" style="margin-bottom:18px">Bestemmer, hvilke tider kunderne kan booke.</p>
    <div class="panel"><h2>Booking</h2><div class="grid-3">
      <div class="field"><label>Tider starter hvert</label><select data-path="settings:slotStep" data-type="number">${[5, 10, 15, 20, 30].map((n) => `<option value="${n}" ${s.slotStep === n ? 'selected' : ''}>${n} min</option>`).join('')}</select></div>
      <div class="field"><label>Mindste varsel (min)</label><input type="number" min="0" step="15" data-path="settings:minNoticeMinutes" value="${s.minNoticeMinutes}"></div>
      <div class="field"><label>Book højst (dage frem)</label><input type="number" min="1" max="365" data-path="settings:maxDaysAhead" value="${s.maxDaysAhead}"></div>
      <div class="field"><label>Pause mellem kunder (min)</label><input type="number" min="0" step="5" data-path="settings:bufferMinutes" value="${s.bufferMinutes}"></div>
      <div class="field"><label>Flyt/aflys online indtil (min før)</label><input type="number" min="0" step="15" data-path="settings:cancelNoticeMinutes" value="${s.cancelNoticeMinutes}"></div>
    </div></div>
    <div class="panel"><h2>Lukkedage</h2>
      ${s.closedDates.slice().sort((a, b) => a.date.localeCompare(b.date)).map((c) => `<div class="row" style="margin-bottom:6px"><span class="tag">${esc(fmtDate(c.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }))}</span><span>${esc(c.note)}</span><button class="link small" data-act="closed-del" data-date="${c.date}">Fjern</button></div>`).join('')}
      <div class="row" style="margin-top:10px"><input class="input" type="date" id="closed-date" min="${today()}" style="width:auto" aria-label="Dato"><input class="input" id="closed-note" placeholder="Fx helligdag" style="flex:1;min-width:140px" aria-label="Note"><button class="btn btn-sm" data-act="closed-add">Tilføj lukkedag</button></div>
    </div>
    <div class="panel"><h2>Eksisterende bookingsystem</h2><p class="muted small" style="margin-bottom:10px">Bruger salonen allerede et bookingsystem (fx Planway, Booksy eller Fresha), kan alle "Book tid"-knapper sende kunden dertil i stedet.</p>
      <div class="field"><label for="ext-url">Link til bookingsystem <small>valgfrit</small></label><input id="ext-url" type="url" placeholder="https://" data-path="settings:externalBookingUrl" value="${esc(s.externalBookingUrl || '')}"></div>
    </div>
    <div class="panel"><h2>Demodata</h2><p class="muted small" style="margin-bottom:10px">Sletter alle ændringer, bookinger og billeder i denne browser.</p><button class="btn btn-line btn-sm" data-act="reset">Nulstil demo</button></div>`;
}

function adminPhotos() {
  const slots = [['hero', 'Forsiden'], ['salon', 'Salonen'], ['facade', 'Find os']];
  return `<h1>Billeder</h1><p class="muted" style="margin-bottom:18px">Brug salonens egne billeder. I demoen gemmes de kun i denne browser.</p>
    <h2 class="t-m" style="margin-bottom:10px">Faste billeder</h2>
    <div class="thumb-grid" style="margin-bottom:32px">${slots.map(([key, label]) => { const p = state.photos[key]; return `<div class="thumb">${photo(p.src, label, p.note)}
      <div class="body"><strong>${label}</strong><p class="muted small">${esc(p.note)}</p>
        <div class="row between"><span class="btn btn-line btn-sm file-btn">${p.src ? 'Udskift' : 'Upload'}<input type="file" accept="image/*" data-upload="photo" data-id="${key}" aria-label="Upload billede til ${label}"></span>${p.src ? `<button class="link small" data-act="photo-del" data-id="${key}">Fjern</button>` : ''}</div></div></div>`; }).join('')}</div>
    <div class="row between" style="margin-bottom:10px"><h2 class="t-m">Klipninger</h2><span class="btn btn-sm file-btn">Tilføj billede<input type="file" accept="image/*" data-upload="gallery-new" aria-label="Tilføj billede"></span></div>
    <div class="thumb-grid">${state.gallery.map((g) => `<div class="thumb">${photo(g.src, g.title, g.title)}
      <div class="body">
        <div class="field"><label>Titel</label><input data-path="gallery:${g.id}:title" value="${esc(g.title)}"></div>
        <div class="row between"><span class="btn btn-line btn-sm file-btn">${g.src ? 'Udskift' : 'Upload'}<input type="file" accept="image/*" data-upload="gallery" data-id="${g.id}" aria-label="Upload ${esc(g.title)}"></span><button class="link small" data-act="gallery-del" data-id="${g.id}">Slet</button></div>
      </div></div>`).join('')}</div>`;
}

function adminOutbox() {
  return `<h1>Udsendelser</h1><p class="muted" style="margin-bottom:18px">De e-mails og sms'er, siden sender, når den er i drift. I demoen sendes intet.</p>
    ${state.outbox.length ? `<div class="bk-list">${state.outbox.map((m) => `<div class="outbox-item"><div class="row between"><strong>${m.type} til ${esc(m.to)}</strong><span class="tag">Ikke sendt (demo)</span></div><p class="muted small">${esc(m.subject)} · ${new Date(m.at).toLocaleString('da-DK', { timeZone: E.TZ })}</p><pre>${esc(m.body)}</pre></div>`).join('')}</div>` : '<p class="empty">Ingen endnu. Book en tid på siden, så kan du se bekræftelsen og sms-påmindelsen her.</p>'}`;
}

function setPath(path, value) {
  const [coll, ...rest] = path.split(':');
  let obj;
  if (coll === 'settings') obj = state.settings;
  else obj = state[coll].find((x) => x.id === rest.shift());
  if (!obj) return;
  while (rest.length > 1) { const k = rest.shift(); obj[k] ??= {}; obj = obj[k]; }
  obj[rest[0]] = value;
}

async function fileToDataUrl(file, max) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.8);
  } finally { URL.revokeObjectURL(url); }
}

function seedBookings() {
  const names = ['Eksempel A', 'Eksempel B', 'Eksempel C', 'Eksempel D', 'Eksempel E', 'Eksempel F'];
  let made = 0;
  for (let d = 0; d < 7; d++) {
    const date = E.addDays(today(), d);
    let perDay = 0;
    for (const sv of state.services.filter((s) => s.active)) {
      if (perDay >= 3) break;
      const slots = E.availableSlots(state, { serviceId: sv.id, barberId: 'any', date, now: now() });
      if (!slots.length) continue;
      const pick = slots[Math.floor(Math.random() * slots.length)];
      const r = E.createBooking(state, { serviceId: sv.id, barberId: 'any', date, start: pick.start, customer: { name: names[made % names.length], phone: `2000000${made % 10}`, email: `kunde${made}@example.com` } }, now());
      if (r.ok) { r.booking.example = true; made++; perDay++; }
    }
  }
  return made;
}

// ---------- handlinger ----------
const onManage = () => location.hash.startsWith('#/min-booking');
const actions = {
  menu: () => toggleMenu(document.getElementById('menu')?.hidden),
  'pick-service': (el) => {
    bk.serviceId = el.dataset.id; bk.date = null; bk.start = null;
    if (bk.barberId && bk.barberId !== 'any' && !barber(bk.barberId)?.serviceIds.includes(bk.serviceId)) bk.barberId = null;
    if (bk.presetBarber && barber(bk.presetBarber)?.serviceIds.includes(bk.serviceId)) bk.barberId = bk.presetBarber;
    goStep(bk.barberId ? 3 : 2);
  },
  'pick-barber': (el) => { bk.barberId = el.dataset.id; bk.date = null; bk.start = null; goStep(3); },
  step: (el) => {
    const n = +el.dataset.step;
    if (n === 4 && bk.start == null) return;
    goStep(n);
  },
  month: (el) => {
    const target = onManage() ? mb : bk;
    target.month = addMonths(target.month, +el.dataset.dir);
    const y = window.scrollY;
    if (onManage()) renderManage(); else renderBooking();
    window.scrollTo(0, y);
  },
  'pick-date': (el) => {
    const y = window.scrollY;
    if (onManage()) { mb.date = el.dataset.date; mb.start = null; renderManage(); } else { bk.date = el.dataset.date; bk.start = null; bk.notice = ''; renderBooking(); }
    window.scrollTo(0, y);
    document.getElementById('times')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },
  'pick-time': (el) => {
    const y = window.scrollY;
    if (onManage()) { mb.start = +el.dataset.start; renderManage(); window.scrollTo(0, y); return; }
    bk.start = +el.dataset.start; renderBooking(); window.scrollTo(0, y);
    document.getElementById('continue')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },
  ics: (el) => {
    const b = state.bookings.find((x) => x.ref === el.dataset.ref);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([icsFor(b)], { type: 'text/calendar' }));
    a.download = `stylebybrothers-${b.ref}.ics`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  'mb-move': () => { const sel = mb.booking.anyBarber ? 'any' : mb.booking.barberId; mb.moving = true; mb.date = firstAvailableDate(mb.booking.serviceId, sel, mb.booking.id); mb.month = monthStart(mb.date || today()); mb.start = null; mb.msg = ''; renderManage(); },
  'mb-stop': () => { mb.moving = false; renderManage(); },
  'mb-save': () => {
    const r = E.moveBooking(state, mb.booking, { date: mb.date, start: mb.start }, now());
    if (r.ok) { queueMessages(mb.booking, 'flyttet'); save(); mb.moving = false; mb.msg = 'Din tid er flyttet.'; mb.msgKind = 'ok'; }
    else { mb.msg = r.error === 'too_late' ? 'Tiden er for tæt på til at blive ændret online.' : 'Tiden er ikke længere ledig. Vælg en anden.'; mb.msgKind = 'danger'; mb.start = null; }
    renderManage(); window.scrollTo(0, 0);
  },
  'mb-cancel': async () => {
    if (!(await ask('Vil du aflyse din tid?', 'Ja, aflys'))) return;
    const r = E.cancelBooking(state, mb.booking, now());
    if (r.ok) { queueMessages(mb.booking, 'aflyst'); save(); mb.msg = 'Din tid er aflyst.'; mb.msgKind = 'ok'; }
    else { mb.msg = 'Tiden er for tæt på til at blive aflyst online. Ring til os.'; mb.msgKind = 'danger'; }
    renderManage();
  },
  'mb-reset': () => { mb = null; history.replaceState(null, '', '#/min-booking'); renderManage(new URLSearchParams()); },
  'admin-login': () => { try { sessionStorage.setItem('sbb-admin', '1'); } catch { window.__sbbAdmin = true; } route(); },
  'admin-logout': () => { try { sessionStorage.removeItem('sbb-admin'); } catch { window.__sbbAdmin = false; } location.hash = '#/'; },
  'admin-day': (el) => { adminDate = E.addDays(adminDate, +el.dataset.dir); adminMove = null; route(); },
  'admin-today': () => { adminDate = today(); route(); },
  seed: () => { const n = seedBookings(); save(); toast(`${n} eksempelbookinger de næste 7 dage`); route(); },
  'move-start': (el) => { const b = state.bookings.find((x) => x.id === el.dataset.id); adminMove = { id: b.id, date: b.date, start: null, barberId: b.barberId }; route(); },
  'move-stop': () => { adminMove = null; route(); },
  'move-save': (el) => {
    const b = state.bookings.find((x) => x.id === el.dataset.id);
    if (adminMove.start == null) { toast('Vælg en ny tid'); return; }
    const r = E.moveBooking(state, b, { date: adminMove.date, start: adminMove.start, barberId: adminMove.barberId }, now(), 'salon');
    if (r.ok) { queueMessages(b, 'flyttet'); save(); adminMove = null; adminDate = b.date; toast('Bookingen er flyttet'); } else toast('Tiden er ikke ledig');
    route();
  },
  'admin-cancel': async (el) => {
    const b = state.bookings.find((x) => x.id === el.dataset.id);
    if (!(await ask(`Aflys ${b.name} kl. ${E.fmtTime(b.start)}?`, 'Ja, aflys'))) return;
    E.cancelBooking(state, b, now(), 'salon'); queueMessages(b, 'aflyst'); save(); toast('Bookingen er aflyst'); route();
  },
  'service-add': () => { state.services.push({ id: uid('s'), name: 'Ny behandling', desc: '', duration: 30, price: 0, active: false }); save(); route(); },
  'service-del': async (el) => { if (!(await ask('Slet behandlingen? Bookinger, der allerede er lavet, bliver ikke slettet.', 'Slet'))) return; state.services = state.services.filter((s) => s.id !== el.dataset.id); state.barbers.forEach((b) => { b.serviceIds = b.serviceIds.filter((id) => id !== el.dataset.id); }); save(); route(); },
  'service-move': (el) => { const i = state.services.findIndex((s) => s.id === el.dataset.id); const j = i + +el.dataset.dir; [state.services[i], state.services[j]] = [state.services[j], state.services[i]]; save(); route(); },
  'barber-add': () => { const base = defaultState().barbers[0]; state.barbers.push({ ...structuredClone(base), id: uid('b'), name: `Frisør ${state.barbers.length + 1}`, role: '', active: false }); save(); route(); },
  'barber-del': async (el) => { if (!(await ask('Slet frisøren? Bookinger, der allerede er lavet, bliver ikke slettet.', 'Slet'))) return; state.barbers = state.barbers.filter((b) => b.id !== el.dataset.id); save(); route(); },
  'barber-photo-del': (el) => { barber(el.dataset.id).photo = ''; save(); route(); },
  'photo-del': (el) => { state.photos[el.dataset.id].src = ''; save(); route(); },
  'absence-add': (el) => {
    const id = el.dataset.id;
    const from = document.getElementById(`abs-from-${id}`).value;
    const to = document.getElementById(`abs-to-${id}`).value || from;
    if (!from || to < from) { toast('Vælg en gyldig periode'); return; }
    barber(id).absences.push({ from, to, note: document.getElementById(`abs-note-${id}`).value.trim() });
    save(); toast('Fravær tilføjet'); route();
  },
  'absence-del': (el) => { barber(el.dataset.id).absences.splice(+el.dataset.i, 1); save(); route(); },
  'closed-add': () => {
    const date = document.getElementById('closed-date').value;
    if (!date) { toast('Vælg en dato'); return; }
    if (!state.settings.closedDates.some((c) => c.date === date)) state.settings.closedDates.push({ date, note: document.getElementById('closed-note').value.trim() || 'Lukket' });
    save(); toast('Lukkedag tilføjet'); route();
  },
  'closed-del': (el) => { state.settings.closedDates = state.settings.closedDates.filter((c) => c.date !== el.dataset.date); save(); route(); },
  'gallery-del': async (el) => { if (!(await ask('Slet billedet?', 'Slet'))) return; state.gallery = state.gallery.filter((g) => g.id !== el.dataset.id); save(); route(); },
  reset: async () => { if (!(await ask('Nulstil al demodata i denne browser?', 'Nulstil'))) return; state = defaultState(); save(); toast('Demoen er nulstillet'); route(); },
};

app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (el && actions[el.dataset.act]) {
    if (el.tagName === 'BUTTON') e.preventDefault();
    actions[el.dataset.act](el, e);
    return;
  }
  if (e.target.closest('#menu a')) toggleMenu(false);
});

const changeActions = {
  'admin-date': (el) => { if (el.value) { adminDate = el.value; adminMove = null; route(); } },
  'move-date': (el) => { adminMove.date = el.value; adminMove.start = null; route(); },
  'move-time': (el) => { adminMove.start = el.value === '' ? null : +el.value; },
  'move-barber': (el) => { adminMove.barberId = el.value; adminMove.start = null; route(); },
  'barber-service': (el) => {
    const b = barber(el.dataset.id);
    b.serviceIds = el.checked ? [...new Set([...b.serviceIds, el.dataset.service])] : b.serviceIds.filter((x) => x !== el.dataset.service);
    save(); toast('Gemt');
  },
  'barber-day': (el) => {
    const b = barber(el.dataset.id);
    b.hours[el.dataset.day] = el.checked ? { start: '11:30', end: '17:30', breakStart: '14:00', breakEnd: '14:30' } : null;
    save(); route();
  },
};

app.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.dataset.actChange) { changeActions[el.dataset.actChange]?.(el); return; }
  if (el.dataset.upload) {
    const file = el.files?.[0];
    if (!file) return;
    try {
      const kind = el.dataset.upload;
      const src = await fileToDataUrl(file, kind === 'barber' ? 600 : 1400);
      if (kind === 'barber') barber(el.dataset.id).photo = src;
      else if (kind === 'photo') state.photos[el.dataset.id].src = src;
      else if (kind === 'gallery') state.gallery.find((g) => g.id === el.dataset.id).src = src;
      else state.gallery.unshift({ id: uid('g'), title: 'Nyt billede', src });
      if (save()) toast('Billedet er gemt');
    } catch { toast('Billedet kunne ikke læses'); }
    route();
    return;
  }
  if (el.dataset.path) {
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (el.type === 'number' || el.dataset.type === 'number') v = Math.max(0, Number(v) || 0);
    setPath(el.dataset.path, v);
    if (save()) toast('Gemt');
    if (el.type === 'checkbox' || el.tagName === 'SELECT') route();
  }
});

// ---------- router ----------
let currentView = '';
function route() {
  const h = location.hash || '#/';
  const [path, query] = h.slice(1).split('?');
  const params = new URLSearchParams(query || '');
  toggleMenu(false);
  if (path.startsWith('/booking/bekraeftet')) {
    const b = state.bookings.find((x) => x.ref === params.get('ref'));
    currentView = 'confirm';
    if (b) renderConfirmation(b); else location.hash = '#/booking';
    return;
  }
  if (path.startsWith('/booking')) { currentView = 'booking'; startBooking(params); return; }
  if (path.startsWith('/min-booking')) { currentView = 'manage'; renderManage(params); window.scrollTo(0, 0); return; }
  if (path.startsWith('/admin')) { const y = currentView === 'admin' ? window.scrollY : 0; currentView = 'admin'; renderAdmin(path.split('/')[2]); window.scrollTo(0, y); return; }
  // Forside: "#/#priser" eller "#priser" ruller til sektionen.
  const target = h.includes('#', 1) ? h.slice(h.indexOf('#', 1) + 1) : (!h.startsWith('#/') ? h.slice(1) : '');
  if (currentView === 'home' && target) { document.getElementById(target)?.scrollIntoView(); return; }
  currentView = 'home';
  renderHome(target);
}
window.addEventListener('hashchange', route);
route();
