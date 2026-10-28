// StyleByBrothers — hjemmeside, booking og adminpanel.
// Bookinger, behandlinger og tider ligger på serveren (/api, se worker/). Browseren bruger samme bookingmotor
// til at vise ledige tider, og serveren tjekker tiden igen, når kunden bekræfter.
import * as E from './booking-engine.js';
import { SALON, PHOTOS, SERVICE_PHOTOS } from './data.js';

const app = document.getElementById('app');

// ---------- server ----------
let state = null; // { settings, services, barbers, bookings } – offentlig udgave, eller fuld udgave i admin
let admin = null; // { email, outbox } når man er logget ind

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api/${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = {};
  try { data = await res.json(); } catch { /* tomt svar */ }
  if (!res.ok) { const e = new Error(data.error || 'Der skete en fejl. Prøv igen.'); e.status = res.status; e.data = data; throw e; }
  return data;
}

async function loadPublic() {
  state = await api('state');
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
const chooseBarber = () => Boolean(state.settings.chooseBarber) && state.barbers.filter((b) => b.active).length > 1;
const DAY_NAMES = ['søndag', 'mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag'];
const DAY_SHORT = ['søn', 'man', 'tir', 'ons', 'tor', 'fre', 'lør'];

/** Billedplads: viser billedet, eller en neutral flade med en note om, hvad der skal ind. */
function photo(src, alt, note, cls = '') {
  return `<div class="photo ${cls}">${src ? `<img src="${esc(src)}" alt="${esc(alt)}" ${cls.includes('hero') ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async">` : ''}<span class="ph">${esc(note || alt)}</span></div>`;
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
// Logo: to bogstaver (S og B) i en cirkel, delt af en lodret streg, de to brødre side om side.
const LOGO_MARK = '<svg viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="20.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M22 10.5v23" stroke="currentColor" stroke-width="1.1"/><text y="26.8" font-size="13.5" font-weight="500" fill="currentColor" font-family="Inter, Arial, sans-serif" text-anchor="middle"><tspan x="15.4">S</tspan><tspan x="28.8">B</tspan></text></svg>';
function logo() {
  return `<a class="logo" href="#/" aria-label="StyleByBrothers, til forsiden"><span class="logo-mark">${LOGO_MARK}</span><span class="logo-name">StyleByBrothers</span></a>`;
}

function header() {
  return `<div class="topbar"><div class="wrap"><span>Herrefrisør i Slagelse · ${SALON.street}</span><a href="${SALON.phoneHref}">Ring ${SALON.phone.replace('+45 ', '')} <span aria-hidden="true">↗</span></a></div></div>
  <header class="site-header">
    <nav class="nav wrap" aria-label="Hovedmenu">
      ${logo()}
      <ul class="nav-links">
        <li><a href="#/#priser">Behandlinger</a></li>
        <li><a href="#/#galleri">Vores klip</a></li>
        <li><a href="#/#salonen">Salonen</a></li>
        <li><a href="#/#find-os">Find os</a></li>
      </ul>
      <div class="nav-right"><a href="#/min-booking">Min booking</a><a class="sbb-book" ${bookAttrs()}>Book tid <span aria-hidden="true">↗</span></a></div>
      <button class="menu-btn" data-act="menu" aria-expanded="false" aria-controls="menu">Menu</button>
      <a class="nav-book sbb-book" ${bookAttrs()}>Book tid <span aria-hidden="true">↗</span></a>
    </nav>
    <div class="mobile-menu wrap" id="menu" hidden>
      <ul>
        <li><a href="#/#priser">Behandlinger & priser</a></li>
        <li><a href="#/#galleri">Vores klip</a></li>
        <li><a href="#/#salonen">Salonen</a></li>
        <li><a href="#/#find-os">Find os</a></li>
        <li><a href="#/min-booking">Flyt eller aflys en tid</a></li>
      </ul>
      <p>${SALON.street}, ${SALON.city} · <a href="${SALON.phoneHref}">${SALON.phone}</a></p>
    </div>
  </header>`;
}

function footer() {
  return `<footer class="site-footer"><div class="wrap">
    ${currentView === 'home' ? `<div class="sbb-footer-cta"><div><p class="sbb-kicker">Næste klip starter her.</p><h2>Vi ses i stolen.</h2></div><a class="sbb-book" ${bookAttrs()}>Find en ledig tid <span aria-hidden="true">↗</span></a></div>` : ''}
    <div class="foot-cols">
      <div class="foot-brand">${logo()}<p>Klip, fades og skæg.<br>Midt i Slagelse.</p></div>
      <div><h3>Besøg os</h3><p>${SALON.street}<br>${SALON.city}</p><p><a href="${SALON.maps}" target="_blank" rel="noopener">Vis på kort ↗</a></p></div>
      <div><h3>Kontakt</h3><p><a href="${SALON.phoneHref}">${SALON.phone}</a></p><p>CVR ${SALON.cvr}</p></div>
      <div><h3>Din tid</h3><p><a ${bookAttrs()}>Book tid ↗</a></p><p><a href="#/min-booking">Flyt eller aflys</a></p></div>
      <div><h3>Følg med</h3><p><a href="${SALON.instagram}" target="_blank" rel="noopener">Instagram ↗</a></p><p><a href="${SALON.facebook}" target="_blank" rel="noopener">Facebook ↗</a></p></div>
    </div>
    <div class="foot-bottom"><span>© ${new Date().getFullYear()} StyleByBrothers</span><a href="#/privatliv">Privatliv og cookies</a><a href="#/admin">Log ind</a><span class="credit">Webudvikling: <a href="https://veyro.dk" target="_blank" rel="noopener">Veyro.dk</a></span></div>
  </div></footer>`;
}

// ---------- forside ----------
const LOOKS = [
  { src: 'img/kroeller-taper.jpg', title: 'Krøller & taper', detail: 'Tekstur med en skarp overgang' },
  { src: 'img/high-fade-skaeg.jpg', title: 'Fade & skæg', detail: 'Skarpe linjer. Ren finish.' },
  { src: 'img/slick-back.jpg', title: 'Klassisk slick back', detail: 'Et klassisk udtryk med kant' },
  { src: 'img/taper-tekstur.jpg', title: 'Taper & tekstur', detail: 'Detaljerne gør forskellen' },
  { src: 'img/mid-fade-skaeg.jpg', title: 'Mid fade', detail: 'En blød overgang og et skarpt skæg' },
];
let homeObserver;
let motionPaused = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function renderHome(scrollTo) {
  const services = state.services.filter((s) => s.active);
  const open = todayLine();
  const team = state.barbers.filter((b) => b.active);
  const haircut = services.find((s) => s.id === 'herreklip');
  app.innerHTML = `${header()}
  <main id="main" class="sbb-home ${motionPaused ? 'motion-paused' : ''}">
    <section class="sbb-hero" aria-labelledby="sbb-title">
      <div class="wrap sbb-hero__grid">
        <div class="sbb-hero__copy">
          <p class="sbb-kicker"><span aria-hidden="true"></span> Klip, fades og skæg</p>
          <h1 id="sbb-title">Herrefrisør<br><em>i Slagelse.</em></h1>
          <p class="sbb-hero__intro">Fades, klassiske klip og skæg på Sct. Mikkelsgade. Book en tid, og sæt dig godt til rette.</p>
          <div class="sbb-hero__actions"><a class="sbb-book" ${bookAttrs()}>Book en tid <span aria-hidden="true">↗</span></a><a class="sbb-text-link" href="#/#priser">Se behandlinger <span aria-hidden="true">↓</span></a></div>
          <div class="sbb-hero__meta"><div><span>Din lokale herrefrisør</span><strong>${SALON.street}</strong></div>${haircut ? `<div><span>${esc(haircut.name)} · ${haircut.duration} min.</span><strong>${kr(haircut.price)} <small>inkl. moms</small></strong></div>` : ''}</div>
        </div>
        <div class="sbb-hero__visual">
          <div class="sbb-hero__composition">
            <div class="sbb-hero__image">${photo('img/kroeller-taper.jpg', 'Taper fade med krøller, klippet hos StyleByBrothers', '', 'hero-photo')}</div>
            <a class="sbb-hero__salon" href="#/#salonen" aria-label="Se salonen på Sct. Mikkelsgade">${photo('img/salonen.jpg', 'Indenfor i StyleByBrothers med sorte og gyldne barberstole', '', 'hero-salon-photo')}<span>Indenfor hos os <span aria-hidden="true">↗</span></span></a>
          </div>
          <div class="sbb-hero__status"><span class="open-now ${open.open ? '' : 'closed'}"><i aria-hidden="true"></i>${esc(open.text)}</span><span>Klip. Fade. Skæg.</span></div>
        </div>
      </div>
      <div class="wrap sbb-hero__bottom"><span>Godt håndværk. Hele vejen rundt.</span><button type="button" data-act="motion-toggle" aria-pressed="${motionPaused}">${motionPaused?'Start':'Sæt'} bevægelse ${motionPaused?'på siden':'på pause'} <span aria-hidden="true">${motionPaused?'▷':'Ⅱ'}</span></button><a href="#/#galleri">Se vores klip <span aria-hidden="true">↓</span></a></div>
    </section>

    <section class="sbb-services sbb-section" id="priser" aria-labelledby="priser-titel">
      <div class="wrap">
        <div class="sbb-section-head"><div><p class="sbb-kicker">Behandlinger & priser</p><h2 id="priser-titel">Find dit næste klip.</h2></div><p>Fra et hurtigt trim til klippet<br>til den store dag.</p></div>
        <div class="sbb-services__grid">
          <div class="sbb-services__story" data-reveal>${photo('img/high-fade-skaeg.jpg', 'Fade og skæg med skarpe konturer fra StyleByBrothers', '')}<div><span>Til hverdag.<br>Og de store dage.</span><span aria-hidden="true">↗</span></div></div>
          <div class="sbb-services__list"><div class="cards">
            ${services.map((s,i)=>`<a class="card sbb-treatment" ${bookAttrs(s.id)}><span class="sbb-treatment__number" aria-hidden="true">${String(i+1).padStart(2,'0')}</span>${photo(SERVICE_PHOTOS[s.id] || '', '', s.name)}<div class="sbb-treatment__copy"><h3>${esc(s.name)}</h3><p>${esc(s.desc)}</p><span>${s.duration} min.</span></div><span class="sbb-treatment__price">${kr(s.price)}<span aria-hidden="true">↗</span></span></a>`).join('')}
          </div><p class="cards-note">Alle priser er inkl. moms. Du betaler i salonen.<br>Allerede en tid? <a href="#/min-booking">Flyt eller aflys din booking ↗</a></p></div>
        </div>
      </div>
    </section>

    <section class="sbb-gallery sbb-section" id="galleri" aria-labelledby="galleri-titel">
      <div class="wrap sbb-section-head"><div><p class="sbb-kicker">Klip fra salonen</p><h2 id="galleri-titel">Forskellige hoveder.<br><em>Hver sit udtryk.</em></h2></div><div class="sbb-gallery__controls"><p>Et lille udvalg af vores arbejde.</p><div><button type="button" data-act="gallery-prev" aria-label="Se forrige klip">←</button><button type="button" data-act="gallery-next" aria-label="Se flere klip">→</button></div></div></div>
      <div class="sbb-gallery__track" role="region" aria-label="Galleri med salonens klipninger" tabindex="0">${LOOKS.map((look,i)=>`<button type="button" class="sbb-look" data-act="look-open" data-index="${i}" aria-label="Se større billede: ${esc(look.title)}"><span class="sbb-look__image">${photo(look.src,look.title,'')}<span class="sbb-look__zoom" aria-hidden="true">↗</span></span><span class="sbb-look__caption"><span><strong>${look.title}</strong><span>${look.detail}</span></span><span aria-hidden="true">0${i+1}</span></span></button>`).join('')}</div>
      <div class="wrap sbb-gallery__bottom"><span>Træk eller brug pilene for at se mere.</span><a href="${SALON.instagram}" target="_blank" rel="noopener">Følg med på Instagram ↗</a></div>
      <dialog class="sbb-lightbox" aria-labelledby="look-title"><div class="sbb-lightbox__top"><p id="look-title"></p><button type="button" data-act="look-close" aria-label="Luk billedet">Luk <span aria-hidden="true">×</span></button></div><img src="${LOOKS[0].src}" alt="${LOOKS[0].title}" loading="lazy"><div class="sbb-lightbox__bottom"><button type="button" data-act="look-prev" aria-label="Forrige billede">←</button><span data-look-counter>1 / ${LOOKS.length}</span><button type="button" data-act="look-next" aria-label="Næste billede">→</button></div></dialog>
    </section>

    <section class="sbb-about sbb-section" id="salonen" aria-labelledby="salonen-titel"><div class="wrap">
      <div class="sbb-about__grid"><div class="sbb-about__photo" data-reveal>${photo(PHOTOS.hero.src,'De sorte og gyldne barberstole i StyleByBrothers på Sct. Mikkelsgade','')}<span class="sbb-about__photo-label">Sct. Mikkelsgade 26A · Slagelse</span></div><div class="sbb-about__copy"><p class="sbb-kicker">StyleByBrothers</p><h2 id="salonen-titel">En stol<br><em>midt i byen.</em></h2><p>Herrefrisør midt i Slagelse. Fades, klassiske klip og skæg — vi tager os tid til at få det rigtigt.</p><p>Kom ind med en idé, eller lad os finde udtrykket sammen. Det handler om et klip, der passer til dig.${chooseBarber()?' Du kan vælge din faste frisør, når du booker.':''}</p><a class="sbb-book" ${bookAttrs()}>Book en tid hos os <span aria-hidden="true">↗</span></a>${chooseBarber()?`<div class="team">${team.map(b=>`<div class="member"><span class="initials">${esc(initials(b.name))}</span><div><h3>${esc(b.name)}</h3><p>${workDays(b)}</p></div></div>`).join('')}</div>`:''}</div></div>
      <div class="sbb-how"><div><span>01</span><p><strong>Vælg behandling</strong>Klip, skæg eller den store dag.</p></div><div><span>02</span><p><strong>Find en ledig tid</strong>Se tiderne og book online.</p></div><div><span>03</span><p><strong>Vi ses i salonen</strong>Sæt dig godt til rette. Vi klarer resten.</p></div></div>
    </div></section>

    <section class="sbb-find sbb-section" id="find-os" aria-labelledby="find-titel"><div class="wrap"><div class="sbb-section-head"><div><p class="sbb-kicker">Find vej</p><h2 id="find-titel">Kom forbi.</h2></div><p>Sct. Mikkelsgade 26A.<br>Lige midt i Slagelse.</p></div><div class="sbb-find__grid"><div class="sbb-find__address"><span class="sbb-address-number" aria-hidden="true">26A</span><div><p class="sbb-kicker">StyleByBrothers</p><h3>${SALON.street}</h3><p>${SALON.city}</p></div><a class="sbb-text-link" href="${SALON.maps}" target="_blank" rel="noopener">Find vej til salonen <span aria-hidden="true">↗</span></a><a class="sbb-find__phone" href="${SALON.phoneHref}">${SALON.phone.replace('+45 ','')} <span aria-hidden="true">↗</span></a></div><div class="sbb-find__hours"><div><h3>Åbningstider</h3><span class="open-now ${open.open?'':'closed'}"><i aria-hidden="true"></i>${esc(open.text)}</span></div><table class="hours"><tbody>${weekHours().map(h=>`<tr class="${h.today?'is-today':''}"><th scope="row">${esc(h.label)}</th><td>${esc(h.text)}</td></tr>`).join('')}</tbody></table><p>Vil du være sikker på en tid? <a ${bookAttrs()}>Book inden du kommer ↗</a></p></div></div></div></section>
  </main>
  ${footer()}`;
  document.title = 'StyleByBrothers · Herrefrisør i Slagelse';
  enhanceHome();
  if (scrollTo) requestAnimationFrame(() => document.getElementById(scrollTo)?.scrollIntoView());
  else window.scrollTo(0, 0);
}

function enhanceHome() {
  homeObserver?.disconnect();
  if (!motionPaused && !window.matchMedia('(prefers-reduced-motion: reduce)').matches && 'IntersectionObserver' in window) {
    homeObserver = new IntersectionObserver(entries => entries.forEach(entry => { if (entry.isIntersecting) { entry.target.classList.add('is-in'); homeObserver.unobserve(entry.target); } }), { threshold: .1 });
    document.querySelectorAll('[data-reveal]').forEach(el=>homeObserver.observe(el));
  }
  const track = document.querySelector('.sbb-gallery__track');
  if (track) {
    let drag = null, dragged = false;
    track.addEventListener('dragstart', e => e.preventDefault());
    track.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      drag = { x:e.clientX, left:track.scrollLeft, pointer:e.pointerId };
      dragged = false;
    });
    track.addEventListener('pointermove', e => {
      if (!drag) return;
      if (!(e.buttons & 1)) { stopDrag(); return; }
      const delta = e.clientX - drag.x;
      if (!dragged && Math.abs(delta) < 6) return;
      dragged = true;
      track.setPointerCapture(drag.pointer);
      track.classList.add('is-dragging');
      track.scrollLeft = drag.left - delta;
      e.preventDefault();
    });
    const stopDrag = () => { if (drag && track.hasPointerCapture(drag.pointer)) track.releasePointerCapture(drag.pointer); drag=null; track.classList.remove('is-dragging'); };
    track.addEventListener('pointerup', stopDrag);
    track.addEventListener('pointercancel', stopDrag);
    track.addEventListener('pointerleave', () => { if (drag && !track.hasPointerCapture(drag.pointer)) stopDrag(); });
    track.addEventListener('click', e => { if (dragged) { e.preventDefault(); e.stopImmediatePropagation(); dragged=false; } }, true);
  }
  const dialog = document.querySelector('.sbb-lightbox');
  dialog?.addEventListener('click',e=>{if(e.target===dialog)dialog.close();});
  dialog?.addEventListener('keydown',e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();showLook((Number(dialog.dataset.index)||0)+(e.key==='ArrowRight'?1:-1));}});
}
function showLook(index) {
  const dialog = document.querySelector('.sbb-lightbox');
  if (!dialog) return;
  const i=(index+LOOKS.length)%LOOKS.length,look=LOOKS[i];
  dialog.dataset.index=i;
  const img=dialog.querySelector('img');img.src=look.src;img.alt=look.title;
  dialog.querySelector('#look-title').textContent=look.title;
  dialog.querySelector('[data-look-counter]').textContent=`${i+1} / ${LOOKS.length}`;
  if (!dialog.open) dialog.showModal();
}
function scrollGallery(direction) {
  const track=document.querySelector('.sbb-gallery__track');
  if (!track) return;
  track.scrollBy({left:direction*(track.querySelector('.sbb-look')?.getBoundingClientRect().width+24||320),behavior:motionPaused?'instant':'smooth'});
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
    <p class="cal-note">Dage med hvid baggrund har ledige tider. Du kan booke op til ${state.settings.maxDaysAhead} dage frem.</p>
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
  if (!chooseBarber()) bk.barberId = 'any';
  else if (bid && barber(bid)?.active) bk.presetBarber = bid;
  if (sid && service(sid)?.active) { bk.serviceId = sid; bk.step = 2; if (bk.barberId) goStep(3, false); }
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
  const choose = chooseBarber();
  const step = (n, title, value, body) => {
    if (n === 2 && !choose) return '';
    const status = n < bk.step ? 'done' : n === bk.step ? 'current' : 'todo';
    return `<section class="step ${status}" aria-labelledby="step-${n}">
      <div class="step-head"><h2 id="step-${n}"><span>${!choose && n > 2 ? n - 1 : n}</span>${title}</h2>${status === 'done' ? `<button class="link small" data-act="step" data-step="${n}">Ændr</button>` : ''}</div>
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
        <span class="dot"></span><span class="face">${esc(initials(b.name))}</span><span><strong>${esc(b.name)}</strong><small>${esc(b.role)}${b.role ? ' · ' : ''}${workDays(b)}</small></span></button></li>`).join('')}
    </ul>`;
  };
  const s3 = () => `${bk.notice ? `<p class="notice danger" style="margin-bottom:16px">${esc(bk.notice)}</p>` : ''}
      ${bk.date ? '' : `<p class="empty">Der er ingen ledige tider de næste ${state.settings.maxDaysAhead} dage. Ring på ${SALON.phone}, så finder vi en tid.</p>`}
      ${calendarHtml({ serviceId: bk.serviceId, barberId: bk.barberId, month: bk.month, selected: bk.date })}
      ${timesHtml({ serviceId: bk.serviceId, barberId: bk.barberId, date: bk.date, selected: bk.start })}
      <div class="continue" id="continue">${bk.start != null ? `<button class="btn" data-act="step" data-step="4">Fortsæt med ${esc(fmtDate(bk.date, { weekday: 'short', day: 'numeric', month: 'short' }))} kl. ${E.fmtTime(bk.start)}</button>${bk.barberId === 'any' && choose ? '<p class="note" style="margin-top:8px">Frisøren bliver valgt, når du bekræfter.</p>' : ''}` : ''}</div>`;
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
        ${bk.serverError ? `<p class="notice danger" role="alert">${esc(bk.serverError)}</p>` : ''}
        <p class="note">Vi bruger kun dine oplysninger til at håndtere din booking og sende bekræftelse og påmindelse. Læs mere i vores <a href="#/privatliv">privatlivspolitik</a>.</p>
        <div><button class="btn" type="submit" ${bk.sending ? 'disabled' : ''}>Book ${sv ? esc(sv.name.toLowerCase()) : 'tid'} ${bk.date ? `${esc(fmtDate(bk.date, { weekday: 'short', day: 'numeric', month: 'short' }))} kl. ${E.fmtTime(bk.start)}` : ''}</button></div>
      </form>`;
  };
  const timeValue = bk.date && bk.start != null ? `${esc(cap(fmtDate(bk.date)))} kl. ${E.fmtTime(bk.start)}` : '';
  app.innerHTML = `${header()}
  <main class="booking" id="main"><div class="wrap booking-grid">
    <div>
      <h1 class="t-l">Book tid</h1>
      <p class="booking-intro">Vælg ${choose ? 'behandling, frisør og tidspunkt' : 'behandling og tidspunkt'}. Du skal ikke oprette en konto.</p>
      ${step(1, 'Behandling', sv ? `${esc(sv.name)} · ${sv.duration} min · ${kr(sv.price)}` : '', s1)}
      ${step(2, 'Frisør', esc(barberLabel(bk.barberId)), s2)}
      ${step(3, 'Tidspunkt', timeValue, s3)}
      ${step(4, 'Dine oplysninger', '', s4)}
      <div class="steps-end"></div>
    </div>
    <aside class="summary" aria-label="Din booking"><h2>Din booking</h2>
      <dl>
        <div><dt>Behandling</dt><dd>${sv ? esc(sv.name) : '–'}</dd></div>
        ${choose ? `<div><dt>Frisør</dt><dd>${bk.barberId ? esc(barberLabel(bk.barberId)) : '–'}</dd></div>` : ''}
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

let lastBooking = null;
function rememberBooking(b) {
  lastBooking = b;
  try { sessionStorage.setItem('sbb-last', JSON.stringify(b)); } catch { /* ikke vigtigt */ }
}
function recallBooking(ref) {
  if (lastBooking?.ref === ref) return lastBooking;
  try { const b = JSON.parse(sessionStorage.getItem('sbb-last') || 'null'); return b?.ref === ref ? b : null; } catch { return null; }
}

async function submitBooking() {
  const errors = E.validateCustomer(bk.customer);
  bk.serverError = '';
  if (Object.keys(errors).length) { bk.errors = errors; renderBooking(); return; }
  bk.errors = {}; bk.sending = true; renderBooking();
  try {
    const r = await api('bookings', { method: 'POST', body: { serviceId: bk.serviceId, barberId: bk.barberId, date: bk.date, start: bk.start, customer: bk.customer } });
    state = r.state;
    rememberBooking(r.booking);
    history.replaceState(null, '', `#/booking/bekraeftet?ref=${r.booking.ref}`);
    renderConfirmation(r.booking);
  } catch (e) {
    bk.sending = false;
    if (e.status === 409) {
      await loadPublic().catch(() => {});
      bk.start = null;
      bk.notice = 'Tiden blev taget, mens du bookede. Vælg en anden tid.';
      goStep(3);
      return;
    }
    if (e.status === 400 && e.data?.errors && Object.keys(e.data.errors).length) bk.errors = e.data.errors;
    else bk.serverError = e.message;
    renderBooking();
  }
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
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//StyleByBrothers//Booking//DA', 'BEGIN:VEVENT', `UID:${b.ref}@stylebybrothers`, `DTSTAMP:${dt(new Date().toISOString())}`,
    `DTSTART:${dt(start.toISOString())}`, `DTEND:${dt(end.toISOString())}`, `SUMMARY:${b.serviceName}\\, StyleByBrothers`,
    `LOCATION:${SALON.street}\\, ${SALON.city}`, `DESCRIPTION:Bookingnummer ${b.ref}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}

function renderConfirmation(b) {
  const br = barber(b.barberId);
  app.innerHTML = `${header()}
  <main class="booking" id="main"><div class="wrap narrow">
    <h1 class="t-l">Tak, ${esc(b.name.split(' ')[0])}. Du er booket.</h1>
    <p class="booking-intro">Vi har sendt en bekræftelse til ${esc(b.email)}. Du får også en påmindelse dagen før.</p>
    <dl class="receipt">
      <div><dt>Hvornår</dt><dd>${esc(cap(fmtDate(b.date)))} kl. ${E.fmtTime(b.start)}–${E.fmtTime(b.end)}</dd></div>
      <div><dt>Behandling</dt><dd>${esc(b.serviceName)}</dd></div>
      ${chooseBarber() ? `<div><dt>Frisør</dt><dd>${esc(br?.name || '')}</dd></div>` : ''}
      <div><dt>Pris</dt><dd>${kr(b.price)} <span class="muted" style="font-weight:400">inkl. moms, betales i salonen</span></dd></div>
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
  if (!mb || params) mb = { ref: params?.get('ref') || '', phone: '', booking: null, moving: false, date: null, start: null, month: monthStart(today()), msg: '', msgKind: '', busy: false };
  const b = mb.booking;
  let inner;
  if (!b) {
    inner = `<form class="form" id="find-form" novalidate>
      <div class="field"><label for="m-ref">Bookingnummer <small>står i din bekræftelse</small></label><input id="m-ref" name="ref" value="${esc(mb.ref)}" autocomplete="off" autocapitalize="characters" required></div>
      <div class="field"><label for="m-phone">Telefonnummer</label><input id="m-phone" name="phone" type="tel" inputmode="tel" value="${esc(mb.phone)}" required></div>
      <div><button class="btn" type="submit" ${mb.busy ? 'disabled' : ''}>Find min tid</button></div>
    </form>`;
  } else {
    const br = barber(b.barberId);
    const changeable = b.status === 'confirmed' && b.canChange;
    const sel = b.anyBarber ? 'any' : b.barberId;
    inner = `<dl class="receipt">
        <div><dt>Hvornår</dt><dd>${esc(cap(fmtDate(b.date)))} kl. ${E.fmtTime(b.start)}</dd></div>
        <div><dt>Behandling</dt><dd>${esc(b.serviceName)}, ${kr(b.price)}</dd></div>
        ${chooseBarber() ? `<div><dt>Frisør</dt><dd>${esc(br?.name || '')}</dd></div>` : ''}
        <div><dt>Status</dt><dd>${b.status === 'confirmed' ? 'Booket' : 'Aflyst'}</dd></div>
      </dl>
      ${b.status === 'confirmed' && !changeable ? `<p class="notice" style="margin-top:20px">Tiden er så tæt på, at den ikke kan ændres online. Ring på ${SALON.phone}.</p>` : ''}
      ${changeable && !mb.moving ? `<div class="actions"><button class="btn" data-act="mb-move">Flyt tiden</button><button class="btn btn-line" data-act="mb-cancel">Aflys tiden</button></div>` : ''}
      ${mb.moving ? `<div style="margin-top:32px"><h2 class="t-m" style="margin-bottom:14px">Vælg en ny tid</h2>
        ${calendarHtml({ serviceId: b.serviceId, barberId: sel, month: mb.month, selected: mb.date, ignoreBookingId: b.pid })}
        ${timesHtml({ serviceId: b.serviceId, barberId: sel, date: mb.date, selected: mb.start, ignoreBookingId: b.pid })}
        <div class="actions"><button class="btn" data-act="mb-save" ${mb.start == null || mb.busy ? 'disabled' : ''}>${mb.start != null ? `Flyt til ${esc(fmtDate(mb.date, { weekday: 'short', day: 'numeric', month: 'short' }))} kl. ${E.fmtTime(mb.start)}` : 'Vælg en tid'}</button><button class="btn btn-line" data-act="mb-stop">Fortryd</button></div></div>` : ''}
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
  document.getElementById('find-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    mb.ref = String(fd.get('ref') || '').trim(); mb.phone = String(fd.get('phone') || '').trim();
    mb.busy = true; renderManage();
    try {
      mb.booking = (await api('bookings/find', { method: 'POST', body: { ref: mb.ref, phone: mb.phone } })).booking;
      mb.msg = ''; mb.msgKind = '';
    } catch (err) { mb.msg = err.message; mb.msgKind = 'danger'; }
    mb.busy = false; renderManage();
  });
}

async function manageChange(kind) {
  mb.busy = true;
  try {
    const body = { ref: mb.booking.ref, phone: mb.phone, ...(kind === 'move' ? { date: mb.date, start: mb.start } : {}) };
    const r = await api(`bookings/${kind}`, { method: 'POST', body });
    state = r.state; mb.booking = r.booking; mb.moving = false;
    mb.msg = kind === 'move' ? 'Din tid er flyttet. Du får en bekræftelse på e-mail.' : 'Din tid er aflyst.'; mb.msgKind = 'ok';
  } catch (e) {
    mb.msgKind = 'danger'; mb.start = null;
    mb.msg = e.data?.error === 'too_late' ? 'Tiden er for tæt på til at blive ændret online. Ring til os.' : e.data?.error === 'taken' ? 'Tiden er ikke længere ledig. Vælg en anden.' : e.message;
    if (e.status === 409) await loadPublic().catch(() => {});
  }
  mb.busy = false;
  renderManage(); window.scrollTo(0, 0);
}

// ---------- privatliv ----------
function renderPrivacy() {
  app.innerHTML = `${header()}
  <main class="booking" id="main"><div class="wrap narrow legal">
    <h1 class="t-l">Privatlivspolitik og cookies</h1>
    <p class="booking-intro">Senest opdateret 27. oktober 2026.</p>
    <h2>Dataansvarlig</h2>
    <p>StyleByBrothers, ${SALON.street}, ${SALON.city}. CVR ${SALON.cvr}. Telefon <a href="${SALON.phoneHref}">${SALON.phone}</a>.</p>
    <h2>Hvad vi gemmer, og hvorfor</h2>
    <p>Når du booker en tid, gemmer vi dit navn, telefonnummer, din e-mail, en eventuel besked til frisøren og den tid og behandling, du har valgt. Vi bruger oplysningerne til at håndtere din booking: reservere tiden, sende bekræftelse og påmindelse på e-mail og kontakte dig, hvis tiden skal ændres.</p>
    <p>Grundlaget er, at det er nødvendigt for at opfylde aftalen med dig (databeskyttelsesforordningens artikel 6, stk. 1, litra b). Vi bruger ikke oplysningerne til markedsføring og sælger dem ikke.</p>
    <h2>Hvor længe</h2>
    <p>Bookinger slettes automatisk 12 måneder efter tidspunktet for besøget. Log over udsendte e-mails rummer kun de seneste udsendelser og overskrives løbende.</p>
    <h2>Hvem der behandler oplysningerne for os</h2>
    <p>Hjemmesiden er udviklet og drives af Veyro (veyro.dk) som databehandler. Siden og bookingerne ligger hos Cloudflare, og e-mails sendes gennem Resend. Begge er databehandlere og må kun bruge oplysningerne til at levere deres tjeneste. Oplysningerne kan blive behandlet uden for EU. Det sker i så fald efter EU-Kommissionens standardkontraktbestemmelser eller EU-U.S. Data Privacy Framework.</p>
    <h2>Dine rettigheder</h2>
    <p>Du har ret til at få indsigt i de oplysninger, vi har om dig, og til at få dem rettet eller slettet. Du kan også gøre indsigelse eller bede om at få begrænset behandlingen. Ring til os på ${SALON.phone}, eller kom forbi salonen. Du kan klage til Datatilsynet, <a href="https://www.datatilsynet.dk" target="_blank" rel="noopener">datatilsynet.dk</a>.</p>
    <h2>Cookies</h2>
    <p>Siden bruger ikke cookies til statistik, annoncer eller sporing, og den indlæser ikke indhold fra andre tjenester. Derfor spørger vi ikke om samtykke. Efter en booking husker din browser bookingen, så længe fanen er åben, så du kan se bekræftelsen igen. Salonens medarbejdere får en nødvendig login-cookie, når de logger ind i admin.</p>
  </div></main>${footer()}`;
  document.title = 'Privatlivspolitik · StyleByBrothers';
  window.scrollTo(0, 0);
}

// ---------- admin ----------
const ADMIN_TABS = [['kalender', 'Kalender'], ['behandlinger', 'Priser'], ['frisoerer', 'Stole og arbejdstider'], ['regler', 'Regler og lukkedage'], ['beskeder', 'Sendte e-mails']];
let adminDate = null;
let adminMove = null;
let adminNew = null;
let adminRefresh = null;
let showCancelled = false;

async function loadAdmin() {
  const r = await api('admin/state');
  state = r.state;
  admin = { email: r.email, admins: r.admins, outbox: r.outbox };
}

function adminShell(tab, body) {
  return `<div class="admin">
    <div class="admin-top"><div class="nav wrap"><a class="wordmark" href="#/">StyleByBrothers<small>admin</small></a>
      <a class="btn btn-sm hide-sm" href="#/">Se siden</a><button class="btn btn-sm" data-act="admin-logout">Log ud</button></div>
      <nav class="admin-tabs wrap" aria-label="Admin">${ADMIN_TABS.map(([id, label]) => `<a href="#/admin/${id}" ${id === tab ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
    </div>
    <div class="wrap admin-body">${body}</div>
  </div>`;
}

function renderLogin(msg = '', kind = '') {
  app.innerHTML = `<div class="admin"><div class="wrap"><form class="login-card" id="login-form" novalidate>
      <a class="wordmark" href="#/">StyleByBrothers</a>
      <h1>Log ind</h1>
      <p class="muted">Skriv din e-mail, så sender vi et link, du logger ind med.</p>
      ${msg ? `<p class="notice ${kind}" role="status">${msg}</p>` : ''}
      <div class="field"><label for="l-email">E-mail</label><input id="l-email" name="email" type="email" autocomplete="email" required></div>
      <button class="btn btn-block" type="submit">Send login-link</button>
      <a class="small" href="#/">Tilbage til hjemmesiden</a>
    </form></div></div>`;
  document.title = 'Log ind · StyleByBrothers';
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = new FormData(e.target).get('email');
    try {
      const r = await api('admin/login', { method: 'POST', body: { email } });
      renderLogin(r.devLink ? `Udvikling: <a href="${esc(r.devLink)}">log ind her</a>` : 'Hvis adressen har adgang, har vi sendt et login-link. Tjek din indbakke.', 'ok');
    } catch (err) { renderLogin(esc(err.message), 'danger'); }
  });
}

async function renderAdmin(tab, params) {
  clearInterval(adminRefresh);
  if (tab === 'login') {
    try {
      await api('admin/verify', { method: 'POST', body: { token: params.get('t') || '' } });
      history.replaceState(null, '', '#/admin');
      tab = 'kalender';
    } catch (e) { renderLogin(esc(e.message), 'danger'); return; }
  }
  if (!admin) {
    try { await loadAdmin(); } catch (e) {
      if (e.status === 401) { renderLogin(); return; }
      renderLogin(esc(e.message), 'danger'); return;
    }
  }
  if (!ADMIN_TABS.some(([id]) => id === tab)) tab = 'kalender';
  const views = { kalender: adminCalendar, behandlinger: adminServices, frisoerer: adminBarbers, regler: adminRules, beskeder: adminOutbox };
  app.innerHTML = adminShell(tab, views[tab]());
  document.title = `${ADMIN_TABS.find(([id]) => id === tab)[1]} · StyleByBrothers`;
  if (tab === 'kalender') {
    // Hent nye bookinger hvert minut, så skærmen i salonen altid er opdateret.
    adminRefresh = setInterval(async () => {
      if (adminMove || adminNew || document.hidden || !location.hash.startsWith('#/admin')) return;
      try { await loadAdmin(); const y = window.scrollY; app.innerHTML = adminShell('kalender', adminCalendar()); window.scrollTo(0, y); } catch { /* prøv igen næste gang */ }
    }, 60000);
  }
}

const chairs = () => state.barbers.filter((b) => b.active);

function adminCalendar() {
  adminDate ||= today();
  const t = today();
  const weekStart = E.addDays(adminDate, -((E.weekday(adminDate) + 6) % 7));
  const confirmed = (d) => state.bookings.filter((b) => b.status === 'confirmed' && b.date === d);
  const dayAll = state.bookings.filter((b) => b.date === adminDate);
  const cancelledCount = dayAll.filter((b) => b.status === 'cancelled').length;
  // Aflyste tider fylder kun, så de er skjult, medmindre frisøren beder om at se dem.
  const list = dayAll.filter((b) => showCancelled || b.status !== 'cancelled').sort((a, b) => a.start - b.start || (a.status === 'cancelled') - (b.status === 'cancelled'));
  const closed = state.settings.closedDates.find((c) => c.date === adminDate);
  const open = salonDay(adminDate);
  const many = chairs().length > 1;
  const nowMin = E.utcToZoned(now()).minutes;
  const card = (b) => {
    const moving = adminMove?.id === b.id;
    const past = adminDate < t || (adminDate === t && b.end <= nowMin);
    return `<article class="bk ${b.status} ${past ? 'past' : ''}">
      <time>${E.fmtTime(b.start)}<small>${E.fmtTime(b.end)}</small></time>
      <div><h3>${esc(b.name)} ${b.status === 'cancelled' ? '<span class="tag off">Aflyst</span>' : ''}${many ? ` <span class="tag">${esc(barber(b.barberId)?.name || '')}</span>` : ''}</h3>
        <p><strong>${esc(b.serviceName)}</strong> · ${kr(b.price)}</p>
        <p><a href="tel:${esc(b.phone)}">${esc(b.phone)}</a>${b.email ? ` · ${esc(b.email)}` : ''}</p>
        ${b.note ? `<p class="bk-note">${esc(b.note)}</p>` : ''}
        ${b.status === 'confirmed' && !past ? (moving ? `<div class="grid-2" style="margin-top:10px">
            <div class="field"><label>Ny dato</label><input type="date" data-act-change="move-date" value="${adminMove.date}" min="${t}"></div>
            <div class="field"><label>Ny tid</label><select data-act-change="move-time"><option value="">Vælg</option>${E.availableSlots(state, { serviceId: b.serviceId, barberId: adminMove.barberId, date: adminMove.date, now: now(), ignoreBookingId: b.id }).map((s) => `<option value="${s.start}" ${adminMove.start === s.start ? 'selected' : ''}>${E.fmtTime(s.start)}</option>`).join('')}</select></div>
            ${many ? `<div class="field"><label>Stol</label><select data-act-change="move-barber"><option value="any">Første ledige</option>${E.barbersFor(state, b.serviceId, 'any').map((x) => `<option value="${x.id}" ${adminMove.barberId === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>` : ''}
            <div class="row"><button class="btn btn-sm" data-act="move-save" data-id="${b.id}">Gem</button><button class="btn btn-line btn-sm" data-act="move-stop">Fortryd</button></div>
          </div>` : `<div class="row"><button class="btn btn-line btn-sm" data-act="move-start" data-id="${b.id}">Flyt</button><button class="btn btn-line btn-sm" data-act="admin-cancel" data-id="${b.id}">Aflys</button></div>`) : ''}
      </div>
    </article>`;
  };
  const week = Array.from({ length: 7 }, (_, i) => E.addDays(weekStart, i));
  return `<div class="row between" style="margin-bottom:16px">
      <div class="row"><button class="btn btn-line btn-sm" data-act="admin-day" data-dir="-7" aria-label="Forrige uge">‹‹</button><button class="btn btn-line btn-sm" data-act="admin-day" data-dir="-1" aria-label="Forrige dag">‹</button>
      <button class="btn btn-sm" data-act="admin-today">I dag</button>
      <button class="btn btn-line btn-sm" data-act="admin-day" data-dir="1" aria-label="Næste dag">›</button><button class="btn btn-line btn-sm" data-act="admin-day" data-dir="7" aria-label="Næste uge">››</button></div>
      <button class="btn btn-sm" data-act="new-start">Ny booking</button>
    </div>
    <div class="week" role="group" aria-label="Uge">${week.map((d) => `<button class="wk-day ${d === adminDate ? 'sel' : ''} ${d === t ? 'is-today' : ''}" data-act="admin-pick" data-date="${d}"><span>${DAY_SHORT[E.weekday(d)]}</span><strong>${+d.slice(8)}</strong><small>${confirmed(d).length || ''}</small></button>`).join('')}</div>
    <h1 class="cal-title">${esc(cap(fmtDate(adminDate, { weekday: 'long', day: 'numeric', month: 'long' })))}</h1>
    <p class="muted" style="margin-bottom:16px">${closed ? `Lukket: ${esc(closed.note)}` : open ? `Åbent ${open.start}–${open.end} · ${confirmed(adminDate).length} ${confirmed(adminDate).length === 1 ? 'booking' : 'bookinger'}` : 'Lukket'}</p>
    ${adminNew ? adminNewForm() : ''}
    <div class="bk-list">${list.length ? list.map(card).join('') : '<p class="empty">Ingen bookinger denne dag.</p>'}</div>
    ${cancelledCount ? `<p style="margin-top:14px"><button class="link small" data-act="toggle-cancelled">${showCancelled ? 'Skjul aflyste' : `Vis ${cancelledCount} ${cancelledCount === 1 ? 'aflyst' : 'aflyste'}`}</button></p>` : ''}`;
}

function adminNewForm() {
  const n = adminNew;
  const svs = state.services.filter((s) => s.active);
  const slots = n.serviceId ? E.availableSlots({ ...state, settings: { ...state.settings, minNoticeMinutes: 0 } }, { serviceId: n.serviceId, barberId: n.barberId, date: n.date, now: now() }) : [];
  const f = (id, label, type, extra = '') => `<div class="field ${n.errors[id] ? 'invalid' : ''}"><label for="n-${id}">${label}</label><input id="n-${id}" data-new="${id}" type="${type}" value="${esc(n[id] || '')}" ${extra}>${n.errors[id] ? `<span class="err">${esc(n.errors[id])}</span>` : ''}</div>`;
  return `<div class="panel" style="margin-bottom:16px"><h2>Ny booking</h2>
    <div class="grid-3">
      <div class="field"><label for="n-service">Behandling</label><select id="n-service" data-act-change="new-service">${svs.map((s) => `<option value="${s.id}" ${s.id === n.serviceId ? 'selected' : ''}>${esc(s.name)} (${s.duration} min)</option>`).join('')}</select></div>
      <div class="field"><label for="n-date">Dato</label><input id="n-date" type="date" data-act-change="new-date" value="${n.date}" min="${today()}"></div>
      <div class="field"><label for="n-time">Tid</label><select id="n-time" data-act-change="new-time"><option value="">${slots.length ? 'Vælg' : 'Ingen ledige'}</option>${slots.map((s) => `<option value="${s.start}" ${n.start === s.start ? 'selected' : ''}>${E.fmtTime(s.start)}</option>`).join('')}</select></div>
      ${chairs().length > 1 ? `<div class="field"><label for="n-barber">Stol</label><select id="n-barber" data-act-change="new-barber"><option value="any">Første ledige</option>${E.barbersFor(state, n.serviceId, 'any').map((x) => `<option value="${x.id}" ${n.barberId === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>` : ''}
      ${f('name', 'Navn', 'text', 'autocomplete="off"')}
      ${f('phone', 'Telefon', 'tel', 'inputmode="tel"')}
      ${f('email', 'E-mail (valgfri, så får kunden en bekræftelse)', 'email')}
      ${f('note', 'Note (valgfri)', 'text')}
    </div>
    ${n.error ? `<p class="notice danger" style="margin-top:10px">${esc(n.error)}</p>` : ''}
    <div class="row" style="margin-top:12px"><button class="btn btn-sm" data-act="new-save">Opret booking</button><button class="btn btn-line btn-sm" data-act="new-stop">Fortryd</button></div>
  </div>`;
}

function adminServices() {
  return `<div class="row between" style="margin-bottom:18px"><div><h1>Priser og behandlinger</h1><p class="muted">Ændringer gemmes med det samme og vises på siden og i bookingen. Priser er inkl. moms.</p></div><button class="btn btn-sm" data-act="service-add">Ny behandling</button></div>
    ${state.services.map((s, i) => `<div class="panel">
      <div class="row between"><h2>${esc(s.name)} ${s.active ? '' : '<span class="tag off">Skjult</span>'}</h2>
        <div class="row"><button class="btn btn-line btn-sm" data-act="service-move" data-id="${s.id}" data-dir="-1" aria-label="Flyt op" ${i === 0 ? 'disabled' : ''}>↑</button><button class="btn btn-line btn-sm" data-act="service-move" data-id="${s.id}" data-dir="1" aria-label="Flyt ned" ${i === state.services.length - 1 ? 'disabled' : ''}>↓</button></div></div>
      <div class="grid-2">
        <div class="field"><label>Navn</label><input data-path="services:${s.id}:name" value="${esc(s.name)}"></div>
        <div class="grid-2"><div class="field"><label>Pris (kr.)</label><input type="number" min="0" step="5" data-path="services:${s.id}:price" value="${s.price}"></div>
        <div class="field"><label>Varighed (min)</label><input type="number" min="5" max="480" step="5" data-path="services:${s.id}:duration" value="${s.duration}"></div></div>
        <div class="field" style="grid-column:1/-1"><label>Kort beskrivelse</label><input data-path="services:${s.id}:desc" maxlength="120" value="${esc(s.desc)}"></div>
      </div>
      <div class="row between" style="margin-top:10px"><label class="row"><input type="checkbox" data-path="services:${s.id}:active" ${s.active ? 'checked' : ''}> Vis på siden og i bookingen</label><button class="link small" data-act="service-del" data-id="${s.id}">Slet</button></div>
    </div>`).join('')}`;
}

function adminBarbers() {
  const days = [[1, 'Man'], [2, 'Tir'], [3, 'Ons'], [4, 'Tor'], [5, 'Fre'], [6, 'Lør'], [0, 'Søn']];
  return `<div class="row between" style="margin-bottom:18px"><div><h1>Stole og arbejdstider</h1><p class="muted">Hver stol (eller frisør) er en kalender. Har salonen to stole, kan to kunder bookes samtidig. Åbningstiderne på siden regnes ud fra tiderne her.</p></div><button class="btn btn-sm" data-act="barber-add">Tilføj stol</button></div>
    ${state.barbers.map((b) => `<div class="panel">
      <div class="grid-2">
        <div class="field"><label>Navn <small>fx "Stol 1" eller frisørens navn</small></label><input data-path="barbers:${b.id}:name" value="${esc(b.name)}"></div>
        <div class="field"><label>Speciale <small>valgfrit</small></label><input data-path="barbers:${b.id}:role" value="${esc(b.role)}"></div>
      </div>
      <p class="col-head" style="margin-top:16px">Behandlinger</p>
      <div class="check-list">${state.services.map((s) => `<label><input type="checkbox" data-act-change="barber-service" data-id="${b.id}" data-service="${s.id}" ${b.serviceIds.includes(s.id) ? 'checked' : ''}> ${esc(s.name)}</label>`).join('')}</div>
      <p class="col-head" style="margin-top:16px">Arbejdstider</p>
      <div class="table-scroll"><table class="hours-table"><thead><tr><th>Dag</th><th>Åben</th><th>Fra</th><th>Til</th><th>Pause fra</th><th>Pause til</th></tr></thead><tbody>
        ${days.map(([d, label]) => { const h = b.hours[d]; return `<tr><td>${label}</td><td><input type="checkbox" data-act-change="barber-day" data-id="${b.id}" data-day="${d}" ${h ? 'checked' : ''} aria-label="Åben ${label}"></td>
          ${['start', 'end', 'breakStart', 'breakEnd'].map((k) => `<td><input type="time" step="900" data-path="barbers:${b.id}:hours:${d}:${k}" value="${h ? esc(h[k] || '') : ''}" ${h ? '' : 'disabled'} aria-label="${label} ${k}"></td>`).join('')}</tr>`; }).join('')}
      </tbody></table></div>
      <p class="col-head" style="margin-top:16px">Ferie og fravær</p>
      ${(b.absences || []).map((a, i) => `<div class="row" style="margin-bottom:6px"><span class="tag">${esc(fmtDate(a.from, { day: 'numeric', month: 'short' }))} – ${esc(fmtDate(a.to || a.from, { day: 'numeric', month: 'short', year: 'numeric' }))}</span><span class="muted">${esc(a.note || '')}</span><button class="link small" data-act="absence-del" data-id="${b.id}" data-i="${i}">Fjern</button></div>`).join('') || '<p class="muted small" style="margin-bottom:8px">Intet fravær.</p>'}
      <div class="grid-3" style="align-items:end"><div class="field"><label for="abs-from-${b.id}">Fra</label><input type="date" id="abs-from-${b.id}" min="${today()}"></div><div class="field"><label for="abs-to-${b.id}">Til</label><input type="date" id="abs-to-${b.id}" min="${today()}"></div><div class="row"><input class="input" id="abs-note-${b.id}" placeholder="Fx ferie" style="flex:1;min-width:120px" aria-label="Note"><button class="btn btn-sm" data-act="absence-add" data-id="${b.id}">Tilføj</button></div></div>
      <div class="row between" style="margin-top:14px"><label class="row"><input type="checkbox" data-path="barbers:${b.id}:active" ${b.active ? 'checked' : ''}> Kan bookes</label><button class="link small" data-act="barber-del" data-id="${b.id}">Slet</button></div>
    </div>`).join('')}`;
}

function adminRules() {
  const s = state.settings;
  return `<h1>Regler og lukkedage</h1><p class="muted" style="margin-bottom:18px">Bestemmer, hvilke tider kunderne kan booke, og hvem der får besked.</p>
    <div class="panel"><h2>Besked om bookinger</h2>
      <div class="field"><label for="notify">Send nye, flyttede og aflyste bookinger til <small>e-mails, adskilt med komma</small></label><input id="notify" type="text" data-act-change="notify" value="${esc((s.notifyEmails || []).join(', '))}" placeholder="${esc(admin.admins[0] || '')}"></div>
      <p class="muted small" style="margin-top:6px">${s.notifyEmails?.length ? '' : `Er feltet tomt, går beskeden til ${esc(admin.admins[0] || '')}.`}</p>
    </div>
    <div class="panel"><h2>Booking</h2><div class="grid-3">
      <div class="field"><label>Tider starter hvert</label><select data-path="settings:slotStep" data-type="number">${[5, 10, 15, 20, 30].map((n) => `<option value="${n}" ${s.slotStep === n ? 'selected' : ''}>${n} min</option>`).join('')}</select></div>
      <div class="field"><label>Mindste varsel (min)</label><input type="number" min="0" step="15" data-path="settings:minNoticeMinutes" value="${s.minNoticeMinutes}"></div>
      <div class="field"><label>Book højst (dage frem)</label><input type="number" min="1" max="365" data-path="settings:maxDaysAhead" value="${s.maxDaysAhead}"></div>
      <div class="field"><label>Pause mellem kunder (min)</label><input type="number" min="0" step="5" data-path="settings:bufferMinutes" value="${s.bufferMinutes}"></div>
      <div class="field"><label>Flyt/aflys online indtil (min før)</label><input type="number" min="0" step="15" data-path="settings:cancelNoticeMinutes" value="${s.cancelNoticeMinutes}"></div>
    </div>
    <label class="row" style="margin-top:12px"><input type="checkbox" data-path="settings:chooseBarber" ${s.chooseBarber ? 'checked' : ''}> Kunden vælger selv frisør (kræver mindst to stole med frisørernes navne)</label></div>
    <div class="panel"><h2>Lukkedage</h2>
      ${s.closedDates.slice().sort((a, b) => a.date.localeCompare(b.date)).map((c) => `<div class="row" style="margin-bottom:6px"><span class="tag">${esc(fmtDate(c.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }))}</span><span>${esc(c.note)}</span><button class="link small" data-act="closed-del" data-date="${c.date}">Fjern</button></div>`).join('')}
      <div class="row" style="margin-top:10px"><input class="input" type="date" id="closed-date" min="${today()}" style="width:auto" aria-label="Dato"><input class="input" id="closed-note" placeholder="Fx helligdag" style="flex:1;min-width:140px" aria-label="Note"><button class="btn btn-sm" data-act="closed-add">Tilføj lukkedag</button></div>
    </div>`;
}

function adminOutbox() {
  const list = admin.outbox || [];
  return `<h1>Sendte e-mails</h1><p class="muted" style="margin-bottom:18px">Bekræftelser, påmindelser og beskeder til salonen. De seneste 150.</p>
    ${list.length ? `<div class="bk-list">${list.map((m) => `<div class="outbox-item"><div class="row between"><strong>${esc(m.to)}</strong>${m.ok ? '<span class="tag ok">Sendt</span>' : `<span class="tag off" title="${esc(m.error)}">Ikke sendt</span>`}</div><p class="muted small">${esc(m.subject)} · ${new Date(m.at).toLocaleString('da-DK', { timeZone: E.TZ })}</p><pre>${esc(m.text)}</pre></div>`).join('')}</div>` : '<p class="empty">Ingen endnu.</p>'}`;
}

// Gem indstillinger på serveren lidt efter sidste ændring.
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await api('admin/config', { method: 'PUT', body: { settings: state.settings, services: state.services, barbers: state.barbers } });
      toast('Gemt');
    } catch (e) {
      toast(e.status === 401 ? 'Du er logget ud. Log ind igen.' : `Ikke gemt: ${e.message}`);
    }
  }, 500);
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

async function adminBooking(path, body, okMsg) {
  try {
    await api(path, { method: 'POST', body });
    await loadAdmin();
    toast(okMsg);
    return true;
  } catch (e) {
    toast(e.data?.error === 'taken' ? 'Tiden er ikke ledig' : e.message);
    return false;
  }
}

// ---------- handlinger ----------
const onManage = () => location.hash.startsWith('#/min-booking');
const actions = {
  'gallery-prev': () => scrollGallery(-1),
  'gallery-next': () => scrollGallery(1),
  'look-open': el => showLook(Number(el.dataset.index)),
  'look-close': () => document.querySelector('.sbb-lightbox')?.close(),
  'look-prev': () => showLook(Number(document.querySelector('.sbb-lightbox')?.dataset.index)-1),
  'look-next': () => showLook(Number(document.querySelector('.sbb-lightbox')?.dataset.index)+1),
  'motion-toggle': el => {
    motionPaused=!motionPaused;
    document.querySelector('.sbb-home')?.classList.toggle('motion-paused',motionPaused);
    el.setAttribute('aria-pressed',String(motionPaused));
    el.innerHTML=`${motionPaused?'Start':'Sæt'} bevægelse ${motionPaused?'på siden':'på pause'} <span aria-hidden="true">${motionPaused?'▷':'Ⅱ'}</span>`;
    if(motionPaused)homeObserver?.disconnect();
  },
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
    const b = recallBooking(el.dataset.ref);
    if (!b) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([icsFor(b)], { type: 'text/calendar' }));
    a.download = `stylebybrothers-${b.ref}.ics`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  'mb-move': () => { const sel = mb.booking.anyBarber ? 'any' : mb.booking.barberId; mb.moving = true; mb.date = firstAvailableDate(mb.booking.serviceId, sel, mb.booking.pid); mb.month = monthStart(mb.date || today()); mb.start = null; mb.msg = ''; renderManage(); },
  'mb-stop': () => { mb.moving = false; renderManage(); },
  'mb-save': () => manageChange('move'),
  'mb-cancel': async () => {
    if (!(await ask('Vil du aflyse din tid?', 'Ja, aflys'))) return;
    manageChange('cancel');
  },
  'mb-reset': () => { mb = null; history.replaceState(null, '', '#/min-booking'); renderManage(new URLSearchParams()); },
  'admin-logout': async () => { await api('admin/logout', { method: 'POST', body: {} }).catch(() => {}); admin = null; clearInterval(adminRefresh); await loadPublic().catch(() => {}); location.hash = '#/'; },
  'admin-day': (el) => { adminDate = E.addDays(adminDate, +el.dataset.dir); adminMove = null; route(); },
  'admin-pick': (el) => { adminDate = el.dataset.date; adminMove = null; route(); },
  'toggle-cancelled': () => { showCancelled = !showCancelled; route(); },
  'admin-today': () => { adminDate = today(); adminMove = null; route(); },
  'move-start': (el) => { const b = state.bookings.find((x) => x.id === el.dataset.id); adminMove = { id: b.id, date: b.date, start: null, barberId: b.barberId }; route(); },
  'move-stop': () => { adminMove = null; route(); },
  'move-save': async (el) => {
    if (adminMove.start == null) { toast('Vælg en ny tid'); return; }
    if (await adminBooking('admin/bookings/move', { id: el.dataset.id, date: adminMove.date, start: adminMove.start, barberId: adminMove.barberId }, 'Bookingen er flyttet. Kunden har fået besked.')) { adminDate = adminMove.date; adminMove = null; }
    route();
  },
  'admin-cancel': async (el) => {
    const b = state.bookings.find((x) => x.id === el.dataset.id);
    if (!(await ask(`Aflys ${b.name} kl. ${E.fmtTime(b.start)}? Kunden får besked på e-mail.`, 'Ja, aflys'))) return;
    await adminBooking('admin/bookings/cancel', { id: b.id }, 'Bookingen er aflyst');
    route();
  },
  'new-start': () => { const sv = state.services.find((s) => s.active); adminNew = { serviceId: sv?.id, date: adminDate < today() ? today() : adminDate, start: null, barberId: 'any', name: '', phone: '', email: '', note: '', errors: {} }; route(); },
  'new-stop': () => { adminNew = null; route(); },
  'new-save': async () => {
    const n = adminNew;
    for (const k of ['name', 'phone', 'email', 'note']) n[k] = document.querySelector(`[data-new="${k}"]`)?.value || '';
    n.errors = E.validateCustomer(n, { requireEmail: false });
    n.error = n.start == null ? 'Vælg en tid.' : '';
    if (Object.keys(n.errors).length || n.error) { route(); return; }
    try {
      await api('admin/bookings', { method: 'POST', body: { serviceId: n.serviceId, barberId: n.barberId, date: n.date, start: n.start, customer: { name: n.name, phone: n.phone, email: n.email, note: n.note } } });
      await loadAdmin();
      adminDate = n.date; adminNew = null; toast('Bookingen er oprettet');
    } catch (e) { n.error = e.data?.error === 'taken' ? 'Tiden er ikke længere ledig.' : e.message; }
    route();
  },
  'service-add': () => { state.services.push({ id: uid('s'), name: 'Ny behandling', desc: '', duration: 30, price: 0, active: false }); save(); route(); },
  'service-del': async (el) => { if (!(await ask('Slet behandlingen? Bookinger, der allerede er lavet, bliver ikke slettet.', 'Slet'))) return; state.services = state.services.filter((s) => s.id !== el.dataset.id); state.barbers.forEach((b) => { b.serviceIds = b.serviceIds.filter((id) => id !== el.dataset.id); }); save(); route(); },
  'service-move': (el) => { const i = state.services.findIndex((s) => s.id === el.dataset.id); const j = i + +el.dataset.dir; [state.services[i], state.services[j]] = [state.services[j], state.services[i]]; save(); route(); },
  'barber-add': () => { const base = state.barbers[0]; state.barbers.push({ id: uid('b'), name: `Stol ${state.barbers.length + 1}`, role: '', active: false, serviceIds: state.services.map((s) => s.id), hours: structuredClone(base?.hours || {}), absences: [] }); save(); route(); },
  'barber-del': async (el) => { if (!(await ask('Slet stolen? Bookinger, der allerede er lavet, bliver ikke slettet.', 'Slet'))) return; state.barbers = state.barbers.filter((b) => b.id !== el.dataset.id); save(); route(); },
  'absence-add': (el) => {
    const id = el.dataset.id;
    const from = document.getElementById(`abs-from-${id}`).value;
    const to = document.getElementById(`abs-to-${id}`).value || from;
    if (!from || to < from) { toast('Vælg en gyldig periode'); return; }
    barber(id).absences.push({ from, to, note: document.getElementById(`abs-note-${id}`).value.trim() });
    save(); route();
  },
  'absence-del': (el) => { barber(el.dataset.id).absences.splice(+el.dataset.i, 1); save(); route(); },
  'closed-add': () => {
    const date = document.getElementById('closed-date').value;
    if (!date) { toast('Vælg en dato'); return; }
    if (!state.settings.closedDates.some((c) => c.date === date)) state.settings.closedDates.push({ date, note: document.getElementById('closed-note').value.trim() || 'Lukket' });
    save(); route();
  },
  'closed-del': (el) => { state.settings.closedDates = state.settings.closedDates.filter((c) => c.date !== el.dataset.date); save(); route(); },
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
  'move-date': (el) => { adminMove.date = el.value; adminMove.start = null; route(); },
  'move-time': (el) => { adminMove.start = el.value === '' ? null : +el.value; },
  'move-barber': (el) => { adminMove.barberId = el.value; adminMove.start = null; route(); },
  'new-service': (el) => { keepNewInputs(); adminNew.serviceId = el.value; adminNew.start = null; route(); },
  'new-date': (el) => { keepNewInputs(); adminNew.date = el.value; adminNew.start = null; route(); },
  'new-time': (el) => { adminNew.start = el.value === '' ? null : +el.value; },
  'new-barber': (el) => { keepNewInputs(); adminNew.barberId = el.value; adminNew.start = null; route(); },
  notify: (el) => { state.settings.notifyEmails = el.value.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean); save(); },
  'barber-service': (el) => {
    const b = barber(el.dataset.id);
    b.serviceIds = el.checked ? [...new Set([...b.serviceIds, el.dataset.service])] : b.serviceIds.filter((x) => x !== el.dataset.service);
    save();
  },
  'barber-day': (el) => {
    const b = barber(el.dataset.id);
    b.hours[el.dataset.day] = el.checked ? { start: '10:00', end: '18:00', breakStart: '', breakEnd: '' } : null;
    save(); route();
  },
};
function keepNewInputs() { for (const k of ['name', 'phone', 'email', 'note']) adminNew[k] = document.querySelector(`[data-new="${k}"]`)?.value ?? adminNew[k]; }

app.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.actChange) { changeActions[el.dataset.actChange]?.(el); return; }
  if (el.dataset.path) {
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (el.type === 'number' || el.dataset.type === 'number') v = Math.max(0, Number(v) || 0);
    setPath(el.dataset.path, v);
    save();
    if (el.type === 'checkbox' || el.tagName === 'SELECT') route();
  }
});

// ---------- router ----------
let currentView = '';
async function route() {
  document.querySelector('.sbb-lightbox[open]')?.close();
  const h = location.hash || '#/';
  const [path, query] = h.slice(1).split('?');
  const params = new URLSearchParams(query || '');
  toggleMenu(false);
  if (path.startsWith('/admin')) { const y = currentView === 'admin' ? window.scrollY : 0; currentView = 'admin'; await renderAdmin(path.split('/')[2] || 'kalender', params); window.scrollTo(0, y); return; }
  clearInterval(adminRefresh);
  if (path.startsWith('/booking/bekraeftet')) {
    const b = recallBooking(params.get('ref'));
    currentView = 'confirm';
    if (b) renderConfirmation(b); else location.hash = `#/min-booking?ref=${encodeURIComponent(params.get('ref') || '')}`;
    return;
  }
  if (path.startsWith('/booking')) { currentView = 'booking'; startBooking(params); return; }
  if (path.startsWith('/min-booking')) { currentView = 'manage'; renderManage(params); window.scrollTo(0, 0); return; }
  if (path.startsWith('/privatliv')) { currentView = 'privacy'; renderPrivacy(); return; }
  // Forside: "#/#priser" eller "#priser" ruller til sektionen.
  const target = h.includes('#', 1) ? h.slice(h.indexOf('#', 1) + 1) : (!h.startsWith('#/') ? h.slice(1) : '');
  if (currentView === 'home' && target) { document.getElementById(target)?.scrollIntoView(); return; }
  currentView = 'home';
  renderHome(target);
}

async function boot() {
  try {
    await loadPublic();
  } catch {
    app.innerHTML = `<main class="wrap" style="padding-block:80px"><h1 class="t-l">StyleByBrothers</h1><p class="lead">Siden kunne ikke hentes lige nu. Ring på <a href="${SALON.phoneHref}">${SALON.phone}</a> for at booke, eller prøv igen om lidt.</p><p>${SALON.street}, ${SALON.city}</p></main>`;
    return;
  }
  window.addEventListener('hashchange', route);
  route();
}
boot();
