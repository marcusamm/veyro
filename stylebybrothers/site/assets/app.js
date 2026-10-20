// StyleByBrothers — hjemmeside, booking og adminpanel (demo).
// Demoen gemmer alt i den besøgendes egen browser (localStorage). Intet sendes, og ingen tider reserveres hos salonen.
import * as E from './booking-engine.js';
import { SALON, defaultState, GALLERY_CATEGORIES } from './data.js';

const KEY = 'sbb-demo-v1';
const app = document.getElementById('app');

// ---------- lager ----------
function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && s.version === 1) return s;
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
const fmtDur = (m) => `${m} min`;
const service = (id) => state.services.find((s) => s.id === id);
const barber = (id) => state.barbers.find((b) => b.id === id);
const initials = (name) => name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const uid = (p) => `${p}${Math.random().toString(36).slice(2, 8)}`;
const icon = {
  arrow: '<svg class="arrow" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1 8h13M9 3l5 5-5 5" stroke="currentColor" stroke-width="1.6"/></svg>',
  left: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3 5 8l5 5" stroke="currentColor" stroke-width="1.6"/></svg>',
  right: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 3 5 5-5 5" stroke="currentColor" stroke-width="1.6"/></svg>',
  plus: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="1.6"/></svg>',
  close: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="m3 3 12 12M15 3 3 15" stroke="currentColor" stroke-width="1.6"/></svg>',
  clock: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.4"/><path d="M8 4.5V8l2.5 1.5" stroke="currentColor" stroke-width="1.4"/></svg>',
  check: '<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M7 16.5 13 22 25 10" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

function isExample(src) { return typeof src === 'string' && src.startsWith('img/'); }
function media(src, alt, { label, cls = '', eager = false, tag = true } = {}) {
  return `<div class="media ${cls}">${src ? `<img src="${esc(src)}" alt="${esc(alt)}" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async">` : ''}${src && tag && isExample(src) ? '<span class="example-tag">Eksempelbillede</span>' : ''}<span class="ph-label">${esc(label ?? alt)}</span></div>`;
}
// Mangler et billede, vises den mørke flade med tekst i stedet.
document.addEventListener('error', (e) => {
  const t = e.target;
  if (t.tagName === 'IMG' && t.closest('.media')) { t.parentElement.querySelector('.example-tag')?.remove(); t.remove(); }
}, true);

let toastTimer;
function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); document.body.append(el); }
  el.textContent = msg;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function bookHref(serviceId) {
  return `#/booking${serviceId ? `?behandling=${encodeURIComponent(serviceId)}` : ''}`;
}
function bookAttrs(serviceId) {
  const ext = state.settings.externalBookingUrl;
  return ext ? `href="${esc(ext)}" target="_blank" rel="noopener"` : `href="${bookHref(serviceId)}"`;
}

// ---------- fælles layout ----------
const demoBar = () => `<div class="demo-bar">Uofficiel demo<span class="hide-sm"> til præsentation</span> · Ingen rigtige bookinger<span class="hide-sm"> · Priser og billeder er eksempler</span></div>`;

function header({ overHero = false } = {}) {
  return `<header class="site-header ${overHero ? 'over-hero' : ''}" id="top">
    ${demoBar()}
    <div class="nav-wrap"><nav class="nav wrap" aria-label="Hovedmenu">
      <a class="logo" href="#/" aria-label="StyleByBrothers forside">Style<b>By</b>Brothers</a>
      <ul class="nav-links">
        <li><a href="#/#behandlinger">Behandlinger</a></li>
        <li><a href="#/#galleri">Galleri</a></li>
        <li><a href="#/#om">Om os</a></li>
        <li><a href="#/#kontakt">Kontakt</a></li>
      </ul>
      <div class="nav-actions">
        <a class="btn btn-accent" ${bookAttrs()}>Book tid</a>
        <button class="menu-btn" data-act="menu" aria-label="Åbn menu" aria-expanded="false"><span></span></button>
      </div>
    </nav></div>
  </header>`;
}

function mobileMenu() {
  return `<div class="mobile-menu" id="menu" role="dialog" aria-modal="true" aria-label="Menu" hidden>
    <div class="nav"><a class="logo" href="#/" data-act="close-menu">Style<b>By</b>Brothers</a><button class="close-btn" data-act="close-menu" aria-label="Luk menu">${icon.close}</button></div>
    <ul>
      <li><a href="#/#behandlinger" data-act="close-menu">Behandlinger <span>01</span></a></li>
      <li><a href="#/#galleri" data-act="close-menu">Galleri <span>02</span></a></li>
      <li><a href="#/#om" data-act="close-menu">Om os <span>03</span></a></li>
      <li><a href="#/#kontakt" data-act="close-menu">Kontakt <span>04</span></a></li>
      <li><a href="#/min-booking" data-act="close-menu">Min booking <span>05</span></a></li>
    </ul>
    <a class="btn btn-accent btn-xl btn-block" ${bookAttrs()} data-act="close-menu">Book tid ${icon.arrow}</a>
    <div class="menu-foot"><a href="${SALON.phoneHref}">${SALON.phone}</a><span>${SALON.street}, ${SALON.city}</span></div>
  </div>`;
}

function footer() {
  return `<footer class="site-footer">
    <div class="wrap">
      <p class="footer-big">Style<b>By</b><br>Brothers</p>
      <div class="footer-grid">
        <div><h4>Salonen</h4><p style="margin:0">${SALON.street}<br>${SALON.city}<br><a href="${SALON.phoneHref}">${SALON.phone}</a></p></div>
        <div><h4>Menu</h4><ul><li><a href="#/#behandlinger">Behandlinger</a></li><li><a href="#/#galleri">Galleri</a></li><li><a ${bookAttrs()}>Book tid</a></li><li><a href="#/min-booking">Flyt eller aflys</a></li></ul></div>
        <div><h4>Følg os</h4><ul><li><a href="${SALON.facebook}" target="_blank" rel="noopener">Facebook</a></li><li><a href="${SALON.instagram}" target="_blank" rel="noopener">Instagram</a></li></ul></div>
        <div><h4>Salon</h4><ul><li><a href="#/admin">Adminpanel (demo)</a></li></ul></div>
      </div>
      <div class="footer-legal"><span>© ${new Date().getFullYear()} ${SALON.legalName} · CVR ${SALON.cvr}</span><span>Uofficielt hjemmesidekoncept — ikke godkendt af salonen</span></div>
    </div>
  </footer>`;
}

// ---------- forside ----------
function renderHome(scrollTo) {
  const services = state.services.filter((s) => s.active);
  const s = state.settings;
  app.innerHTML = `${header({ overHero: true })}
  <main id="main">
    <section class="hero" aria-labelledby="hero-title">
      ${media('img/hero.jpg', 'Barber udfører en præcis herreklipning i et mørkt, stilrent rum', { label: '', eager: true })}
      <div class="wrap hero-inner hero-reveal">
        <p class="eyebrow">Barbershop · Slagelse</p>
        <h1 class="display h1" id="hero-title"><span>Your style.</span><span class="accent">Our craft.</span></h1>
        <p class="lead">Præcise klipninger. Skarpe detaljer. Din barbershop i hjertet af Slagelse.</p>
        <div class="hero-ctas">
          <a class="btn btn-accent btn-xl" ${bookAttrs()}>Book tid ${icon.arrow}</a>
          <a class="btn btn-ghost btn-xl" href="#/#galleri">Udforsk vores arbejde</a>
        </div>
        <div class="hero-meta"><span>${SALON.street}</span><span>${esc(s.openingHours[0]?.label || '')} ${esc(s.openingHours[0]?.value || '')}</span><span>Herreklip & skægpleje</span></div>
      </div>
      <a class="scroll-cue" href="#/#om">Scroll</a>
    </section>

    <section class="section" id="om" aria-labelledby="om-title">
      <div class="wrap intro-grid">
        <div class="reveal">
          <p class="eyebrow" id="om-title">StyleByBrothers</p>
          <p class="intro-quote">Din stil fortjener opmærksomhed på detaljen. Hos StyleByBrothers er <em>godt håndværk</em> og den personlige oplevelse i centrum.</p>
        </div>
        <div class="intro-side reveal reveal-d2">
          <p class="muted" style="margin:0">Vi er en moderne herrefrisør og barbershop midt i Slagelse. Fra skarpe skin fades til klassiske klip og velplejet skæg: hver klipning starter med en snak om, hvad du vil have, og slutter først, når linjerne sidder.</p>
          <div class="stats">
            <div class="stat"><strong>${services.length}</strong><span>Behandlinger</span></div>
            <div class="stat"><strong>24/7</strong><span>Online booking</span></div>
            <div class="stat"><strong>4200</strong><span>Slagelse C</span></div>
          </div>
          <a class="btn btn-outline" ${bookAttrs()} style="width:fit-content">Book din tid ${icon.arrow}</a>
        </div>
      </div>
    </section>

    <div class="marquee" aria-hidden="true"><div class="marquee-track">${Array(2).fill(['Skin fades', 'Taper', 'Skægpleje', 'Klassiske klip', 'Styling', 'Konturer'].map((w) => `<span>${w}</span>`).join('')).join('')}</div></div>

    <section class="section dark" id="behandlinger" aria-labelledby="beh-title">
      <div class="wrap">
        <div class="section-head split">
          <div class="reveal"><p class="eyebrow">Behandlinger & priser</p><h2 class="display h2" id="beh-title">Vælg dit<br>snit</h2></div>
          <div class="reveal reveal-d1" style="display:grid;gap:16px">
            <p class="muted" style="margin:0">Vælg en behandling, og gå direkte videre til booking. Behandlingen er valgt for dig, så du kun mangler barber og tidspunkt.</p>
            <span class="unconfirmed">Foreløbige priser og varigheder · ikke bekræftet af salonen</span>
          </div>
        </div>
        <div class="services">
          ${services.map((sv, i) => `<article class="service reveal ${i % 3 ? `reveal-d${i % 3}` : ''}">
            <div class="service-top"><span class="service-num">${String(i + 1).padStart(2, '0')}</span><span class="duration">${icon.clock} ${fmtDur(sv.duration)}</span></div>
            <h3>${esc(sv.name)}</h3>
            <p>${esc(sv.desc)}</p>
            <div class="service-meta"><span class="price">${new Intl.NumberFormat('da-DK').format(sv.price)}<small>KR.</small></span><a class="btn btn-light btn-sm" ${bookAttrs(sv.id)} aria-label="Book ${esc(sv.name)}">Book ${icon.arrow}</a></div>
          </article>`).join('')}
        </div>
        <div class="services-foot"><span>Alle priser er inkl. moms. Betaling i salonen.</span><a class="link" href="#/min-booking">Flyt eller aflys en tid</a></div>
      </div>
    </section>

    <section class="section" id="galleri" aria-labelledby="gal-title">
      <div class="wrap">
        <div class="section-head split">
          <div class="reveal"><p class="eyebrow">Galleri</p><h2 class="display h2" id="gal-title">Our<br>work</h2></div>
          <p class="muted reveal reveal-d1" style="margin:0">Fades, klassiske klip, skæg og styling. Tryk på et billede for at se det i fuld størrelse.</p>
        </div>
        <div class="filters" role="group" aria-label="Filtrér galleriet">
          ${GALLERY_CATEGORIES.map((c, i) => `<button class="chip" data-act="filter" data-cat="${c.id}" aria-pressed="${i === 0}">${c.label}</button>`).join('')}
        </div>
        <div class="gallery" id="gallery">${galleryItems()}</div>
        <p class="gallery-note">Billederne er midlertidige eksempelbilleder og viser ikke StyleByBrothers' eget arbejde. De udskiftes med salonens egne billeder i adminpanelet.</p>
      </div>
    </section>

    <section class="section charcoal" aria-labelledby="exp-title">
      <div class="wrap">
        <div class="split-feature" style="margin-bottom:clamp(48px,8vw,96px)">
          ${media('img/oplevelse.jpg', 'Barber finpudser en kontur med trimmer', { cls: 'reveal' })}
          <div class="reveal reveal-d1">
            <p class="eyebrow">Oplevelsen</p>
            <h2 class="display h2" id="exp-title">Detaljen<br>er alt</h2>
            <p class="muted" style="max-width:42ch">En god klipning handler om mere end længden. Det handler om proportioner, hårets retning, linjer der holder og en finish, der passer til dig, også om tre uger.</p>
            <a class="btn btn-accent" ${bookAttrs()} style="margin-top:12px">Book tid ${icon.arrow}</a>
          </div>
        </div>
        <div class="pillars">
          <div class="pillar reveal"><span class="n">01</span><h3>Konsultation</h3><p>Vi starter med dit hår, din stil og din hverdag, så resultatet passer til dig.</p></div>
          <div class="pillar reveal reveal-d1"><span class="n">02</span><h3>Præcision</h3><p>Saks, maskine og kniv. Rene overgange, skarpe konturer og ingen genveje.</p></div>
          <div class="pillar reveal reveal-d2"><span class="n">03</span><h3>Finish</h3><p>Styling og råd til, hvordan du holder looket hjemme mellem besøgene.</p></div>
        </div>
      </div>
    </section>

    <section class="section stone" aria-labelledby="team-title">
      <div class="wrap">
        <div class="section-head split">
          <div class="reveal"><p class="eyebrow">Barbererne</p><h2 class="display h2" id="team-title">Holdet</h2></div>
          <p class="muted reveal reveal-d1" style="margin:0">Vælg din faste barber, når du booker, eller tag første ledige tid. Navne og billeder af holdet kommer, når salonen har leveret dem.</p>
        </div>
        <div class="team">
          ${state.barbers.filter((b) => b.active).map((b, i) => `<div class="member reveal ${i % 3 ? `reveal-d${i % 3}` : ''}">
            <div class="media">${b.photo ? `<img src="${esc(b.photo)}" alt="${esc(b.name)}" loading="lazy">` : `<span class="avatar-fallback">${esc(initials(b.name))}</span>`}</div>
            <div><h3>${esc(b.name)}</h3><p>${esc(b.role)}</p></div>
            <a class="link" href="#/booking?barber=${b.id}">Book hos ${esc(b.name)}</a>
          </div>`).join('')}
        </div>
      </div>
    </section>

    <section class="cta-band" aria-labelledby="cta-title">
      ${media('img/cta.jpg', '', { tag: false, label: '' })}
      <div class="wrap reveal">
        <p class="eyebrow" style="justify-content:center">Klar til et frisk snit?</p>
        <h2 class="display h2" id="cta-title">Book din<br>næste tid</h2>
        <p>Vælg behandling, barber og tidspunkt på under et minut. Ingen konto, ingen ventetid i telefonen.</p>
        <div class="hero-ctas" style="justify-content:center"><a class="btn btn-accent btn-xl" ${bookAttrs()}>Book tid ${icon.arrow}</a><a class="btn btn-ghost btn-xl" href="${SALON.phoneHref}">Ring ${SALON.phone}</a></div>
      </div>
    </section>

    <section class="section" id="kontakt" aria-labelledby="kontakt-title">
      <div class="wrap contact-grid">
        <div class="reveal">
          <p class="eyebrow">Find os</p>
          <h2 class="display h2" id="kontakt-title" style="margin-bottom:36px">Kontakt</h2>
          <dl class="info-list">
            <div class="info-row"><dt>Adresse</dt><dd><a href="${SALON.maps}" target="_blank" rel="noopener">${SALON.street}<br>${SALON.city}</a></dd></div>
            <div class="info-row"><dt>Telefon</dt><dd><a href="${SALON.phoneHref}">${SALON.phone}</a></dd></div>
            <div class="info-row"><dt>Åbent</dt><dd><table class="hours"><tbody>${s.openingHours.map((h) => `<tr><td>${esc(h.label)}</td><td>${esc(h.value)}</td></tr>`).join('')}</tbody></table><small class="muted">Åbningstider skal bekræftes af salonen.</small></dd></div>
            <div class="info-row"><dt>Følg os</dt><dd><a href="${SALON.facebook}" target="_blank" rel="noopener">Facebook</a> · <a href="${SALON.instagram}" target="_blank" rel="noopener">Instagram</a></dd></div>
            <div class="info-row"><dt>CVR</dt><dd>${SALON.cvr}</dd></div>
          </dl>
        </div>
        <a class="map-card reveal reveal-d1" href="${SALON.maps}" target="_blank" rel="noopener" aria-label="Åbn ${SALON.street} i Google Maps">
          ${mapArt()}
          <span class="pin"><span>StyleByBrothers</span><i></i></span>
          <span class="open">Åbn i Google Maps ↗</span>
        </a>
      </div>
    </section>
  </main>
  ${footer()}
  <div class="sticky-book" id="sticky-book"><a class="btn btn-accent btn-xl" ${bookAttrs()}>Book tid ${icon.arrow}</a></div>
  ${mobileMenu()}`;
  document.title = 'StyleByBrothers · Barbershop i Slagelse';
  afterRender();
  if (scrollTo) requestAnimationFrame(() => document.getElementById(scrollTo)?.scrollIntoView());
  else window.scrollTo(0, 0);
}

function galleryItems() {
  const layout = ['tall', '', '', 'wide', '', 'tall', '', '', 'wide'];
  return state.gallery.map((g, i) => {
    const cat = GALLERY_CATEGORIES.find((c) => c.id === g.category);
    return `<button class="g-item ${layout[i % layout.length]}" data-act="lightbox" data-id="${g.id}" data-cat="${g.category}" aria-label="Åbn ${esc(g.title)}">
      ${media(g.src, g.title, { label: `${cat?.label || ''} · billede kommer` })}
      <span class="zoom">${icon.plus}</span>
      <span class="g-cap"><small>${esc(cat?.label || '')}</small><strong>${esc(g.title)}</strong></span>
    </button>`;
  }).join('');
}

function mapArt() {
  // Stiliseret kort (ikke et rigtigt kortudsnit) — åbner Google Maps ved tryk.
  return `<svg viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <rect width="400" height="300" fill="#1f1f1f"/>
    <g stroke="#2f2f2f" stroke-width="14" fill="none" stroke-linecap="round">
      <path d="M-20 140 C 80 120, 160 150, 420 110"/><path d="M200 -20 C 190 80, 215 180, 205 320"/>
      <path d="M-20 240 L 420 210"/><path d="M60 -20 L 110 320"/><path d="M320 -20 L 300 320"/>
    </g>
    <g stroke="#3a3a3a" stroke-width="5" fill="none"><path d="M-20 60 L 420 40"/><path d="M140 -20 L 160 320"/><path d="M-20 190 C 120 200, 260 170, 420 180"/><path d="M250 -20 L 260 320"/></g>
    <g fill="#262626"><rect x="215" y="150" width="34" height="22"/><rect x="165" y="70" width="28" height="40"/><rect x="270" y="190" width="24" height="16"/><rect x="80" y="160" width="40" height="26"/></g>
  </svg>`;
}

// ---------- efter rendering ----------
let io;
let scrollHandler;
function afterRender() {
  io?.disconnect();
  io = new IntersectionObserver((entries) => entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } }), { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  document.querySelectorAll('.reveal').forEach((el) => io.observe(el));
  if (scrollHandler) window.removeEventListener('scroll', scrollHandler);
  const hdr = document.querySelector('.site-header.over-hero');
  const sticky = document.getElementById('sticky-book');
  const hero = document.querySelector('.hero');
  const contact = document.getElementById('kontakt');
  scrollHandler = () => {
    const y = window.scrollY;
    hdr?.classList.toggle('solid', y > 40);
    if (sticky && hero) {
      const beyond = y > hero.offsetHeight * 0.75;
      const nearEnd = contact && contact.getBoundingClientRect().top < window.innerHeight * 0.6;
      sticky.classList.toggle('show', beyond && !nearEnd);
    }
  };
  window.addEventListener('scroll', scrollHandler, { passive: true });
  scrollHandler();
}

// ---------- lightbox ----------
let lb = { list: [], i: 0 };
function openLightbox(id) {
  const active = document.querySelector('.chip[aria-pressed="true"]')?.dataset.cat || 'alle';
  lb.list = state.gallery.filter((g) => active === 'alle' || g.category === active);
  lb.i = Math.max(0, lb.list.findIndex((g) => g.id === id));
  let el = document.getElementById('lightbox');
  if (!el) {
    el = document.createElement('div');
    el.id = 'lightbox';
    el.className = 'lightbox';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Billede i fuld størrelse');
    el.innerHTML = `<div class="lb-top"><span id="lb-count"></span><button class="lb-btn" data-lb="close" aria-label="Luk">${icon.close}</button></div>
      <div class="lb-stage" id="lb-stage"></div>
      <div class="lb-bottom"><div><small class="eyebrow" style="margin:0 0 6px" id="lb-cat"></small><br><strong id="lb-title"></strong></div><div class="lb-nav"><button class="lb-btn" data-lb="prev" aria-label="Forrige">${icon.left}</button><button class="lb-btn" data-lb="next" aria-label="Næste">${icon.right}</button></div></div>`;
    document.body.append(el);
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-lb]');
      if (b) lbAction(b.dataset.lb);
      else if (e.target.id === 'lb-stage') lbAction('close');
    });
    let x0 = null;
    el.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
    el.addEventListener('touchend', (e) => {
      if (x0 === null) return;
      const dx = e.changedTouches[0].clientX - x0;
      if (Math.abs(dx) > 50) lbAction(dx < 0 ? 'next' : 'prev');
      x0 = null;
    });
  }
  lbShow(false);
  el.classList.add('open');
  document.body.style.overflow = 'hidden';
  el.querySelector('[data-lb="close"]').focus();
}
function lbShow(animate = true) {
  const g = lb.list[lb.i];
  if (!g) return;
  const stage = document.getElementById('lb-stage');
  const html = media(g.src, g.title, { label: 'Billede kommer' });
  if (animate && stage.querySelector('img')) {
    stage.querySelector('img').classList.add('swap');
    setTimeout(() => { stage.innerHTML = html; }, 180);
  } else stage.innerHTML = html;
  document.getElementById('lb-count').textContent = `${String(lb.i + 1).padStart(2, '0')} / ${String(lb.list.length).padStart(2, '0')}`;
  document.getElementById('lb-cat').textContent = GALLERY_CATEGORIES.find((c) => c.id === g.category)?.label || '';
  document.getElementById('lb-title').textContent = g.title;
}
function lbAction(a) {
  const el = document.getElementById('lightbox');
  if (a === 'close') { el.classList.remove('open'); document.body.style.overflow = ''; return; }
  lb.i = (lb.i + (a === 'next' ? 1 : -1) + lb.list.length) % lb.list.length;
  lbShow();
}
document.addEventListener('keydown', (e) => {
  const el = document.getElementById('lightbox');
  if (el?.classList.contains('open')) {
    if (e.key === 'Escape') lbAction('close');
    if (e.key === 'ArrowRight') lbAction('next');
    if (e.key === 'ArrowLeft') lbAction('prev');
    return;
  }
  if (e.key === 'Escape' && document.getElementById('menu')?.classList.contains('open')) toggleMenu(false);
});

function toggleMenu(open) {
  const m = document.getElementById('menu');
  if (!m) return;
  if (open) { m.hidden = false; requestAnimationFrame(() => m.classList.add('open')); document.body.style.overflow = 'hidden'; }
  else { m.classList.remove('open'); document.body.style.overflow = ''; setTimeout(() => { m.hidden = true; }, 350); }
  document.querySelector('.menu-btn')?.setAttribute('aria-expanded', String(open));
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
    cells.push(`<button type="button" class="day ${n ? 'avail' : ''} ${date === t ? 'today' : ''}" data-act="pick-date" data-date="${date}" aria-pressed="${date === selected}" aria-label="${esc(label)}" ${n ? '' : 'disabled'}>${d}</button>`);
  }
  const canPrev = month > monthStart(t);
  const canNext = addMonths(month, 1) <= last;
  const title = cap(new Intl.DateTimeFormat('da-DK', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(utcDate(month)));
  return `<div class="cal">
    <div class="cal-head"><strong>${title}</strong><div class="cal-nav"><button type="button" class="icon-btn" data-act="month" data-dir="-1" aria-label="Forrige måned" ${canPrev ? '' : 'disabled'}>${icon.left}</button><button type="button" class="icon-btn" data-act="month" data-dir="1" aria-label="Næste måned" ${canNext ? '' : 'disabled'}>${icon.right}</button></div></div>
    <div class="cal-grid">${['Man', 'Tir', 'Ons', 'Tor', 'Fre', 'Lør', 'Søn'].map((d) => `<span class="cal-dow">${d}</span>`).join('')}${cells.join('')}</div>
    <div class="cal-legend"><span><i></i>Ledige tider</span><span>Booking op til ${state.settings.maxDaysAhead} dage frem</span></div>
  </div>`;
}
function timesHtml({ serviceId, barberId, date, selected, ignoreBookingId }) {
  if (!date) return '';
  const slots = E.availableSlots(state, { serviceId, barberId, date, now: now(), ignoreBookingId });
  if (!slots.length) return `<div class="times"><div class="empty">Ingen ledige tider ${esc(fmtDate(date))}. Prøv en anden dag.</div></div>`;
  const groups = [['Formiddag', (m) => m < 720], ['Eftermiddag', (m) => m >= 720 && m < 1020], ['Aften', (m) => m >= 1020]];
  return `<div class="times"><p class="step-sub" style="margin:0"><strong>${esc(cap(fmtDate(date)))}</strong> · ${slots.length} ledige tider</p>
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
let bk = null;
const STEPS = ['Behandling', 'Barber', 'Tidspunkt', 'Oplysninger', 'Bekræftelse'];

function startBooking(params) {
  const sid = params.get('behandling');
  const bid = params.get('barber');
  bk = { step: 1, serviceId: null, barberId: null, date: null, start: null, month: monthStart(today()), customer: { name: '', phone: '', email: '', note: '' }, errors: {}, notice: '' };
  if (bid && barber(bid)?.active) bk.presetBarber = bid;
  if (sid && service(sid)?.active) { bk.serviceId = sid; bk.step = 2; }
  if (bk.serviceId && bk.presetBarber && barber(bk.presetBarber).serviceIds.includes(bk.serviceId)) { bk.barberId = bk.presetBarber; goStep(3, false); }
  renderBooking();
}

function goStep(n, render = true) {
  bk.step = n;
  bk.notice = n === 3 ? bk.notice : '';
  if (n === 3 && !bk.date) {
    bk.date = firstAvailableDate(bk.serviceId, bk.barberId);
    if (bk.date) bk.month = monthStart(bk.date);
  }
  if (render) { renderBooking(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
}

function bookingSummary() {
  const sv = service(bk.serviceId);
  const br = bk.barberId === 'any' ? 'Første ledige' : barber(bk.barberId)?.name;
  return `<dl>
    <div><dt>Behandling</dt><dd>${sv ? esc(sv.name) : '—'}</dd></div>
    <div><dt>Varighed</dt><dd>${sv ? fmtDur(sv.duration) : '—'}</dd></div>
    <div><dt>Barber</dt><dd>${br ? esc(br) : '—'}</dd></div>
    <div><dt>Dato</dt><dd>${bk.date && bk.step > 2 ? esc(cap(fmtDate(bk.date))) : '—'}</dd></div>
    <div><dt>Tid</dt><dd>${bk.start != null ? `${E.fmtTime(bk.start)}–${E.fmtTime(bk.start + sv.duration)}` : '—'}</dd></div>
  </dl>
  <div class="total"><span class="muted">I alt</span><strong>${sv ? kr(sv.price) : '—'}</strong></div>
  <small class="muted">Foreløbig pris (ikke bekræftet). Betaling i salonen.</small>`;
}

function renderBooking() {
  if (!bk) return;
  const sv = service(bk.serviceId);
  let body = '';
  let bar = '';
  if (bk.step === 1) {
    body = `<h2 class="step-title">Vælg behandling</h2><p class="step-sub">Alle priser og varigheder er foreløbige eksempler.</p>
      <div class="options" role="radiogroup" aria-label="Behandlinger">${state.services.filter((s) => s.active).map((s) => `
        <button type="button" class="option" role="radio" aria-checked="${s.id === bk.serviceId}" data-act="pick-service" data-id="${s.id}">
          <span class="radio"></span><span><strong>${esc(s.name)}</strong><small>${esc(s.desc)}</small></span>
          <span class="right"><strong>${new Intl.NumberFormat('da-DK').format(s.price)} kr.</strong><small>${fmtDur(s.duration)}</small></span>
        </button>`).join('')}</div>`;
    bar = `<div class="sel"><small>Trin 1 af 4</small><strong>Vælg en behandling</strong></div>`;
  } else if (bk.step === 2) {
    const list = E.barbersFor(state, bk.serviceId, 'any');
    body = `<button class="back-link" data-act="step" data-step="1">${icon.left} Skift behandling</button>
      <h2 class="step-title">Vælg barber</h2><p class="step-sub">Vælg en bestemt barber, eller få den første ledige tid.</p>
      <div class="options" role="radiogroup" aria-label="Barberer">
        <button type="button" class="option" role="radio" aria-checked="${bk.barberId === 'any'}" data-act="pick-barber" data-id="any">
          <span class="avatar any">${icon.arrow}</span><span><strong>Første ledige barber</strong><small>Flest ledige tider · barberen tildeles automatisk</small></span><span class="right"></span>
        </button>
        ${list.map((b) => `<button type="button" class="option" role="radio" aria-checked="${bk.barberId === b.id}" data-act="pick-barber" data-id="${b.id}">
          <span class="avatar">${b.photo ? `<img src="${esc(b.photo)}" alt="">` : esc(initials(b.name))}</span><span><strong>${esc(b.name)}</strong><small>${esc(b.role)}</small></span><span class="right"></span>
        </button>`).join('')}
      </div>
      ${list.length ? '' : '<div class="empty">Ingen barberer udfører denne behandling lige nu.</div>'}`;
    bar = `<div class="sel"><small>${esc(sv.name)} · ${kr(sv.price)}</small><strong>Vælg barber</strong></div>`;
  } else if (bk.step === 3) {
    body = `<button class="back-link" data-act="step" data-step="2">${icon.left} Skift barber</button>
      <h2 class="step-title">Vælg tidspunkt</h2><p class="step-sub">Kun ledige tider vises. Alle tider er dansk tid.</p>
      ${bk.notice ? `<div class="notice danger" style="margin-bottom:16px">${esc(bk.notice)}</div>` : ''}
      ${bk.date ? '' : '<div class="empty" style="margin-bottom:16px">Der er ingen ledige tider i bookingperioden. Ring til salonen, så finder vi en tid.</div>'}
      ${calendarHtml({ serviceId: bk.serviceId, barberId: bk.barberId, month: bk.month, selected: bk.date })}
      ${timesHtml({ serviceId: bk.serviceId, barberId: bk.barberId, date: bk.date, selected: bk.start })}
      ${bk.barberId === 'any' && bk.start != null ? '<p class="muted" style="font-size:14px">Barberen tildeles automatisk, når du bekræfter.</p>' : ''}
      <button class="btn btn-block btn-xl desk-only" data-act="step" data-step="4" ${bk.start == null ? 'disabled' : ''} style="margin-top:20px">Fortsæt ${icon.arrow}</button>`;
    bar = `<div class="sel"><small>${esc(sv.name)}</small><strong>${bk.start != null ? `${esc(fmtDate(bk.date, { weekday: 'short', day: 'numeric', month: 'short' }))} · ${E.fmtTime(bk.start)}` : 'Vælg et tidspunkt'}</strong></div><button class="btn btn-accent" data-act="step" data-step="4" ${bk.start == null ? 'disabled' : ''}>Fortsæt</button>`;
  } else if (bk.step === 4) {
    const c = bk.customer;
    const err = bk.errors;
    const f = (id, label, type, extra = '', hint = '') => `<div class="field ${err[id] ? 'invalid' : ''}"><label for="f-${id}">${label}${hint ? ` <small>${hint}</small>` : ''}</label>
      <input id="f-${id}" name="${id}" type="${type}" value="${esc(c[id])}" ${extra} ${err[id] ? `aria-invalid="true" aria-describedby="e-${id}"` : ''}>${err[id] ? `<span class="err" id="e-${id}">${esc(err[id])}</span>` : ''}</div>`;
    body = `<button class="back-link" data-act="step" data-step="3">${icon.left} Skift tidspunkt</button>
      <h2 class="step-title">Dine oplysninger</h2><p class="step-sub">Ingen konto. Vi bruger kun dine oplysninger til at håndtere bookingen.</p>
      <form class="form" id="customer-form" novalidate>
        ${f('name', 'Navn', 'text', 'autocomplete="name" required')}
        ${f('phone', 'Telefon', 'tel', 'autocomplete="tel" inputmode="tel" required', '(til påmindelse og ændringer)')}
        ${f('email', 'E-mail', 'email', 'autocomplete="email" required', '(til bekræftelsen)')}
        <div class="field"><label for="f-note">Bemærkning <small>(valgfri)</small></label><textarea id="f-note" name="note" maxlength="500" placeholder="Fx ønsker til klipningen">${esc(c.note)}</textarea></div>
        <div class="notice">Dette er en demo. Bookingen gemmes kun i din egen browser, og der reserveres ingen tid, sendes ingen e-mail og ingen SMS.</div>
        <p class="consent">Når du bekræfter, behandler ${SALON.legalName} dine oplysninger for at gennemføre bookingen og sende bekræftelse og påmindelse.</p>
        <button class="btn btn-xl btn-block" type="submit">Bekræft booking ${icon.arrow}</button>
      </form>`;
    bar = `<div class="sel"><small>${esc(cap(fmtDate(bk.date, { weekday: 'short', day: 'numeric', month: 'short' })))} · ${E.fmtTime(bk.start)}</small><strong>${esc(sv.name)} · ${kr(sv.price)}</strong></div><button class="btn btn-accent" data-act="submit-booking">Bekræft</button>`;
  } else if (bk.step === 5) {
    renderConfirmation(bk.result);
    return;
  }
  app.innerHTML = `${header()}
  <main class="flow" id="main">
    <div class="flow-head"><div class="wrap">
      <h1 class="display">Book tid</h1>
      <ol class="steps">${STEPS.map((s, i) => `<li class="${i + 1 < bk.step ? 'done' : i + 1 === bk.step ? 'current' : ''}" ${i + 1 === bk.step ? 'aria-current="step"' : ''}><b>0${i + 1}</b><span>${s}</span></li>`).join('')}</ol>
    </div></div>
    <div class="wrap flow-body"><div class="flow-grid">
      <div>${body}</div>
      <aside class="summary summary-desktop" aria-label="Din booking"><h2>Din booking</h2>${bookingSummary()}</aside>
    </div></div>
  </main>
  <div class="flow-bar">${bar}</div>
  ${mobileMenu()}`;
  document.title = `Book tid · ${STEPS[bk.step - 1]} · StyleByBrothers`;
  const form = document.getElementById('customer-form');
  if (form) {
    form.addEventListener('input', (e) => { bk.customer[e.target.name] = e.target.value; });
    form.addEventListener('submit', (e) => { e.preventDefault(); submitBooking(); });
    const firstErr = form.querySelector('[aria-invalid="true"]');
    if (firstErr) firstErr.focus();
  }
}

function submitBooking() {
  const r = E.createBooking(state, { serviceId: bk.serviceId, barberId: bk.barberId, date: bk.date, start: bk.start, customer: bk.customer }, now());
  if (!r.ok && r.error === 'invalid') { bk.errors = r.errors; renderBooking(); return; }
  if (!r.ok) {
    bk.start = null;
    bk.notice = 'Tiden blev desværre taget, mens du bookede. Vælg en anden tid.';
    goStep(3);
    return;
  }
  queueMessages(r.booking, 'oprettet');
  save();
  bk.result = r.booking;
  bk.step = 5;
  history.replaceState(null, '', `#/booking/bekraeftet?ref=${r.booking.ref}`);
  renderConfirmation(r.booking);
}

// Simulerede udsendelser. I drift sendes e-mail via fx Resend og SMS via en SMS-udbyder (se README).
function queueMessages(b, kind) {
  const sv = service(b.serviceId);
  const br = barber(b.barberId);
  const when = `${cap(fmtDate(b.date))} kl. ${E.fmtTime(b.start)}`;
  const at = new Date(now()).toISOString();
  const texts = {
    oprettet: { subject: `Booking bekræftet: ${b.serviceName} ${when}`, sms: `Påmindelse: ${b.serviceName} hos StyleByBrothers i morgen kl. ${E.fmtTime(b.start)}. Flyt/aflys: ref ${b.ref}`, smsAt: 'Sendes 24 timer før' },
    flyttet: { subject: `Din tid er flyttet: ${when}`, sms: null },
    aflyst: { subject: `Din tid ${when} er aflyst`, sms: null },
  }[kind];
  state.outbox.unshift({ id: uid('m'), at, type: 'E-mail', to: b.email, subject: texts.subject, body: `Hej ${b.name}\n\n${b.serviceName} (${sv ? fmtDur(sv.duration) : ''}) hos ${br?.name || 'StyleByBrothers'}\n${when}\n${SALON.street}, ${SALON.city}\nPris: ${kr(b.price)}\nBookingnummer: ${b.ref}\n\nFlyt eller aflys på hjemmesiden under "Min booking".` });
  if (texts.sms) state.outbox.unshift({ id: uid('m'), at, type: 'SMS', to: b.phone, subject: texts.smsAt, body: texts.sms });
  state.outbox = state.outbox.slice(0, 60);
}

function icsFor(b) {
  const dt = (iso) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const start = new Date(b.startUtc);
  const end = new Date(start.getTime() + (b.end - b.start) * 60000);
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//StyleByBrothers//Booking//DA', 'BEGIN:VEVENT', `UID:${b.id}@stylebybrothers`, `DTSTAMP:${dt(new Date().toISOString())}`,
    `DTSTART:${dt(start.toISOString())}`, `DTEND:${dt(end.toISOString())}`, `SUMMARY:${b.serviceName} – StyleByBrothers`,
    `LOCATION:${SALON.street}\\, ${SALON.city}`, `DESCRIPTION:Bookingnummer ${b.ref}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}

function renderConfirmation(b) {
  const br = barber(b.barberId);
  app.innerHTML = `${header()}
  <main class="confirm" id="main">
    <section class="confirm-hero"><div class="wrap">
      <div class="check">${icon.check}</div>
      <p class="eyebrow">Booking bekræftet</p>
      <h1 class="display h2">Tak, ${esc(b.name.split(' ')[0])}.<br>Vi ses i stolen.</h1>
      <div class="ref">Bookingnummer <b>${esc(b.ref)}</b></div>
    </div></section>
    <section class="section" style="padding-top:40px"><div class="wrap narrow">
      <div class="notice" style="margin-bottom:28px"><strong>Demo:</strong> Ingen tid er reserveret hos salonen, og der er ikke sendt nogen e-mail eller SMS. I drift får kunden bekræftelsen på e-mail med det samme.</div>
      <dl class="receipt">
        <div><dt>Behandling</dt><dd>${esc(b.serviceName)}</dd></div>
        <div><dt>Pris</dt><dd>${kr(b.price)} <small class="muted">(foreløbig)</small></dd></div>
        <div><dt>Barber</dt><dd>${esc(br?.name || '')}${b.anyBarber ? ' <small class="muted">(første ledige)</small>' : ''}</dd></div>
        <div><dt>Dato</dt><dd>${esc(cap(fmtDate(b.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })))}</dd></div>
        <div><dt>Tidspunkt</dt><dd>${E.fmtTime(b.start)}–${E.fmtTime(b.end)}</dd></div>
        <div><dt>Adresse</dt><dd><a href="${SALON.maps}" target="_blank" rel="noopener">${SALON.street}, ${SALON.city}</a></dd></div>
      </dl>
      <div class="confirm-actions">
        <button class="btn" data-act="ics" data-ref="${b.ref}">Tilføj til kalender</button>
        <a class="btn btn-outline" href="#/min-booking?ref=${b.ref}">Flyt eller aflys</a>
        <a class="btn btn-outline" href="#/">Til forsiden</a>
      </div>
      <p class="muted" style="font-size:14px;margin-top:24px">Kan du ikke komme? Flyt eller aflys senest ${fmtDur(state.settings.cancelNoticeMinutes)} før med dit bookingnummer og telefonnummer, eller ring på <a href="${SALON.phoneHref}">${SALON.phone}</a>.</p>
    </div></section>
  </main>
  ${footer()}${mobileMenu()}`;
  document.title = 'Booking bekræftet · StyleByBrothers';
  window.scrollTo(0, 0);
}

// ---------- min booking (aflys / flyt) ----------
let mb = null;
function renderManage(params) {
  if (!mb || params) mb = { ref: params?.get('ref') || '', phone: '', booking: null, moving: false, date: null, start: null, month: monthStart(today()), msg: '', msgKind: '' };
  const b = mb.booking;
  let inner;
  if (!b) {
    inner = `<form class="form" id="find-form" novalidate>
      <div class="field"><label for="m-ref">Bookingnummer</label><input id="m-ref" name="ref" value="${esc(mb.ref)}" autocomplete="off" autocapitalize="characters" required placeholder="Fx K7PQ2M"></div>
      <div class="field"><label for="m-phone">Telefonnummer</label><input id="m-phone" name="phone" type="tel" inputmode="tel" value="${esc(mb.phone)}" required></div>
      <button class="btn btn-xl btn-block" type="submit">Find booking ${icon.arrow}</button>
    </form>`;
  } else {
    const br = barber(b.barberId);
    const changeable = E.canChange(state, b, now());
    inner = `<dl class="receipt">
        <div><dt>Status</dt><dd>${b.status === 'confirmed' ? '<span class="tag ok">Bekræftet</span>' : '<span class="tag off">Aflyst</span>'}</dd></div>
        <div><dt>Behandling</dt><dd>${esc(b.serviceName)} · ${kr(b.price)}</dd></div>
        <div><dt>Barber</dt><dd>${esc(br?.name || '')}</dd></div>
        <div><dt>Tid</dt><dd>${esc(cap(fmtDate(b.date)))} kl. ${E.fmtTime(b.start)}</dd></div>
      </dl>
      ${b.status === 'confirmed' && !changeable ? `<div class="notice" style="margin-top:20px">Tiden er for tæt på til at ændre online. Ring på <a href="${SALON.phoneHref}">${SALON.phone}</a>.</div>` : ''}
      ${changeable && !mb.moving ? `<div class="confirm-actions"><button class="btn" data-act="mb-move">Flyt tid</button><button class="btn btn-outline" data-act="mb-cancel">Aflys tid</button></div>` : ''}
      ${mb.moving ? `<div style="margin-top:28px"><h2 class="step-title" style="font-size:32px">Vælg ny tid</h2>
        ${calendarHtml({ serviceId: b.serviceId, barberId: b.anyBarber ? 'any' : b.barberId, month: mb.month, selected: mb.date, ignoreBookingId: b.id })}
        ${timesHtml({ serviceId: b.serviceId, barberId: b.anyBarber ? 'any' : b.barberId, date: mb.date, selected: mb.start, ignoreBookingId: b.id })}
        <div class="confirm-actions"><button class="btn" data-act="mb-save" ${mb.start == null ? 'disabled' : ''}>Flyt til ${mb.start != null ? E.fmtTime(mb.start) : 'valgt tid'}</button><button class="btn btn-outline" data-act="mb-stop">Fortryd</button></div></div>` : ''}
      <p style="margin-top:24px"><button class="link" data-act="mb-reset">Find en anden booking</button></p>`;
  }
  app.innerHTML = `${header()}
  <main id="main">
    <section class="flow-head" style="padding-bottom:36px"><div class="wrap"><p class="eyebrow">Min booking</p><h1 class="display" style="font-size:clamp(40px,9vw,80px)">Flyt eller aflys</h1><p class="muted" style="margin:0">Brug bookingnummeret fra din bekræftelse og dit telefonnummer.</p></div></section>
    <section class="section" style="padding-top:36px"><div class="wrap narrow">
      ${mb.msg ? `<div class="notice ${mb.msgKind}" style="margin-bottom:20px" role="status">${esc(mb.msg)}</div>` : ''}
      ${inner}
    </div></section>
  </main>${footer()}${mobileMenu()}`;
  document.title = 'Min booking · StyleByBrothers';
  document.getElementById('find-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    mb.ref = fd.get('ref'); mb.phone = fd.get('phone');
    mb.booking = E.findBooking(state, mb.ref, mb.phone);
    mb.msg = mb.booking ? '' : 'Vi kunne ikke finde en booking med det bookingnummer og telefonnummer.';
    mb.msgKind = mb.booking ? '' : 'danger';
    renderManage();
  });
}

// ---------- admin ----------
const ADMIN_TABS = [['bookinger', 'Bookinger'], ['behandlinger', 'Behandlinger'], ['barberer', 'Barberer'], ['regler', 'Tider & regler'], ['galleri', 'Galleri'], ['beskeder', 'Udsendelser']];
let adminDate = null;
let adminMove = null;
function isAdmin() { try { return sessionStorage.getItem('sbb-admin') === '1'; } catch { return window.__sbbAdmin === true; } }

function renderAdmin(tab = 'bookinger') {
  if (!isAdmin()) {
    app.innerHTML = `<div class="admin"><div class="wrap"><div class="login-card">
      <a class="logo" href="#/" style="color:var(--black)">Style<b>By</b>Brothers</a>
      <h1 style="margin-top:20px">Admin</h1>
      <p class="muted">I den færdige løsning logger ejeren og barbererne ind med e-mail. I demoen kan du gå direkte ind.</p>
      <button class="btn btn-block btn-xl" data-act="admin-login">Gå til adminpanel (demo)</button>
      <p style="margin-top:16px"><a class="link" href="#/">Tilbage til hjemmesiden</a></p>
    </div></div></div>`;
    document.title = 'Admin · StyleByBrothers';
    return;
  }
  if (!ADMIN_TABS.some(([id]) => id === tab)) tab = 'bookinger';
  const views = { bookinger: adminBookings, behandlinger: adminServices, barberer: adminBarbers, regler: adminRules, galleri: adminGallery, beskeder: adminOutbox };
  app.innerHTML = `<div class="admin">
    <div class="admin-top">${demoBar()}<div class="nav wrap"><a class="logo" href="#/">Style<b>By</b>Brothers <span style="font:600 11px var(--sans);letter-spacing:.2em;color:var(--muted-dark);margin-left:10px">ADMIN</span></a>
      <div class="row"><a class="btn btn-ghost btn-sm" href="#/">Se siden</a><button class="btn btn-ghost btn-sm" data-act="admin-logout">Log ud</button></div></div>
      <div class="admin-tabs-bg"><nav class="admin-tabs wrap" aria-label="Admin">${ADMIN_TABS.map(([id, label]) => `<a href="#/admin/${id}" ${id === tab ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</nav></div>
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
        <p><a href="tel:${esc(b.phone)}">${esc(b.phone)}</a> · ${esc(b.email)} · Ref ${esc(b.ref)}</p>
        ${b.note ? `<p>“${esc(b.note)}”</p>` : ''}
        ${b.status === 'confirmed' ? (moving ? `<div class="grid-2" style="margin-top:10px">
            <div class="field"><label>Ny dato</label><input type="date" data-act-change="move-date" value="${adminMove.date}" min="${today()}"></div>
            <div class="field"><label>Ny tid</label><select data-act-change="move-time"><option value="">Vælg</option>${E.availableSlots(state, { serviceId: b.serviceId, barberId: adminMove.barberId, date: adminMove.date, now: now(), ignoreBookingId: b.id }).map((s) => `<option value="${s.start}" ${adminMove.start === s.start ? 'selected' : ''}>${E.fmtTime(s.start)}</option>`).join('')}</select></div>
            <div class="field"><label>Barber</label><select data-act-change="move-barber"><option value="any">Første ledige</option>${E.barbersFor(state, b.serviceId, 'any').map((x) => `<option value="${x.id}" ${adminMove.barberId === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
            <div class="row"><button class="btn btn-sm" data-act="move-save" data-id="${b.id}">Gem</button><button class="btn btn-outline btn-sm" data-act="move-stop">Fortryd</button></div>
          </div>` : `<div class="row"><button class="btn btn-outline btn-sm" data-act="move-start" data-id="${b.id}">Flyt</button><button class="btn btn-outline btn-sm" data-act="admin-cancel" data-id="${b.id}">Aflys</button></div>`) : ''}
      </div>
    </article>`;
  };
  return `<div class="row between" style="margin-bottom:18px"><div><h1>Bookinger</h1><p class="muted" style="margin:0">${upcoming} kommende bookinger · alt er demodata i din browser</p></div>
      <button class="btn btn-outline btn-sm" data-act="seed">${icon.plus} Lav eksempelbookinger</button></div>
    <div class="panel" style="margin-bottom:16px"><div class="row between">
      <div class="row"><button class="icon-btn" data-act="admin-day" data-dir="-1" aria-label="Forrige dag">${icon.left}</button>
      <input class="input" type="date" value="${adminDate}" data-act-change="admin-date" style="width:auto">
      <button class="icon-btn" data-act="admin-day" data-dir="1" aria-label="Næste dag">${icon.right}</button></div>
      <strong>${esc(cap(fmtDate(adminDate, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })))}</strong>
      <button class="btn btn-sm" data-act="admin-today">I dag</button></div>
      ${closed ? `<p class="notice" style="margin:12px 0 0">Lukket: ${esc(closed.note)}</p>` : ''}
    </div>
    <div class="day-cols" style="--cols:${barbers.length}">
      ${barbers.map((br) => {
        const list = dayBookings.filter((b) => b.barberId === br.id);
        const h = br.hours[E.weekday(adminDate)];
        const off = !h || E.isAbsent(br, adminDate) || closed;
        return `<div><p class="col-head">${esc(br.name)} · ${off ? 'fri' : `${h.start}–${h.end}`}</p><div class="bk-list">${list.length ? list.map(card).join('') : '<div class="empty">Ingen bookinger</div>'}</div></div>`;
      }).join('')}
    </div>`;
}

function adminServices() {
  return `<div class="row between" style="margin-bottom:18px"><div><h1>Behandlinger</h1><p class="muted" style="margin:0">Ændringer gemmes med det samme og vises på siden og i bookingen.</p></div><button class="btn btn-sm" data-act="service-add">${icon.plus} Ny behandling</button></div>
    ${state.services.map((s, i) => `<div class="panel">
      <div class="row between"><h2>${esc(s.name)} ${s.active ? '<span class="tag ok">Vises</span>' : '<span class="tag off">Skjult</span>'}</h2>
        <div class="row"><button class="icon-btn" data-act="service-move" data-id="${s.id}" data-dir="-1" aria-label="Flyt op" ${i === 0 ? 'disabled' : ''}>↑</button><button class="icon-btn" data-act="service-move" data-id="${s.id}" data-dir="1" aria-label="Flyt ned" ${i === state.services.length - 1 ? 'disabled' : ''}>↓</button></div></div>
      <div class="grid-2">
        <div class="field"><label>Navn</label><input data-path="services:${s.id}:name" value="${esc(s.name)}"></div>
        <div class="grid-2"><div class="field"><label>Pris (kr.)</label><input type="number" min="0" step="5" data-path="services:${s.id}:price" value="${s.price}"></div>
        <div class="field"><label>Varighed (min)</label><input type="number" min="5" max="240" step="5" data-path="services:${s.id}:duration" value="${s.duration}"></div></div>
        <div class="field" style="grid-column:1/-1"><label>Kort beskrivelse</label><textarea data-path="services:${s.id}:desc" maxlength="160">${esc(s.desc)}</textarea></div>
      </div>
      <div class="row between" style="margin-top:10px"><label class="row"><input type="checkbox" data-path="services:${s.id}:active" ${s.active ? 'checked' : ''}> Vis på siden og i booking</label><button class="link" data-act="service-del" data-id="${s.id}">Slet</button></div>
    </div>`).join('')}`;
}

function adminBarbers() {
  const days = [[1, 'Man'], [2, 'Tir'], [3, 'Ons'], [4, 'Tor'], [5, 'Fre'], [6, 'Lør'], [0, 'Søn']];
  return `<div class="row between" style="margin-bottom:18px"><div><h1>Barberer</h1><p class="muted" style="margin:0">Hver barber har sin egen kalender, arbejdstid, pause, fravær og behandlinger.</p></div><button class="btn btn-sm" data-act="barber-add">${icon.plus} Ny barber</button></div>
    ${state.barbers.map((b) => `<div class="panel">
      <div class="row" style="gap:16px;margin-bottom:12px">
        <div class="avatar" style="width:72px;height:72px;border-radius:50%;overflow:hidden;background:var(--dark);color:var(--cream);display:grid;place-items:center;font-family:var(--display);font-size:26px">${b.photo ? `<img src="${esc(b.photo)}" alt="" style="width:100%;height:100%;object-fit:cover">` : esc(initials(b.name))}</div>
        <div class="row"><span class="btn btn-outline btn-sm file-btn">Upload billede<input type="file" accept="image/*" data-upload="barber" data-id="${b.id}" aria-label="Upload billede af ${esc(b.name)}"></span>${b.photo ? `<button class="link" data-act="barber-photo-del" data-id="${b.id}">Fjern billede</button>` : ''}</div>
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
      ${(b.absences || []).map((a, i) => `<div class="row" style="margin-bottom:6px"><span class="tag accent">${esc(fmtDate(a.from, { day: 'numeric', month: 'short' }))} – ${esc(fmtDate(a.to || a.from, { day: 'numeric', month: 'short', year: 'numeric' }))}</span><span class="muted">${esc(a.note || '')}</span><button class="link" data-act="absence-del" data-id="${b.id}" data-i="${i}">Fjern</button></div>`).join('') || '<p class="muted" style="margin:0 0 8px">Intet fravær registreret.</p>'}
      <div class="grid-3" style="align-items:end"><div class="field"><label>Fra</label><input type="date" id="abs-from-${b.id}" min="${today()}"></div><div class="field"><label>Til</label><input type="date" id="abs-to-${b.id}" min="${today()}"></div><div class="row"><input class="input" id="abs-note-${b.id}" placeholder="Note, fx ferie" style="flex:1;min-width:120px"><button class="btn btn-sm" data-act="absence-add" data-id="${b.id}">Tilføj</button></div></div>
      <div class="row between" style="margin-top:14px"><label class="row"><input type="checkbox" data-path="barbers:${b.id}:active" ${b.active ? 'checked' : ''}> Aktiv (kan bookes)</label><button class="link" data-act="barber-del" data-id="${b.id}">Slet barber</button></div>
    </div>`).join('')}`;
}

function adminRules() {
  const s = state.settings;
  return `<h1>Tider & regler</h1><p class="muted" style="margin:0 0 18px">Styrer, hvilke tider kunderne kan booke.</p>
    <div class="panel"><h2>Bookingvindue</h2><div class="grid-3">
      <div class="field"><label>Tider starter hvert</label><select data-path="settings:slotStep" data-type="number">${[5, 10, 15, 20, 30].map((n) => `<option value="${n}" ${s.slotStep === n ? 'selected' : ''}>${n} min</option>`).join('')}</select></div>
      <div class="field"><label>Mindste varsel (min)</label><input type="number" min="0" step="15" data-path="settings:minNoticeMinutes" value="${s.minNoticeMinutes}"></div>
      <div class="field"><label>Book højst (dage frem)</label><input type="number" min="1" max="365" data-path="settings:maxDaysAhead" value="${s.maxDaysAhead}"></div>
      <div class="field"><label>Pause mellem kunder (min)</label><input type="number" min="0" step="5" data-path="settings:bufferMinutes" value="${s.bufferMinutes}"></div>
      <div class="field"><label>Kunden kan flytte/aflyse indtil (min før)</label><input type="number" min="0" step="15" data-path="settings:cancelNoticeMinutes" value="${s.cancelNoticeMinutes}"></div>
    </div></div>
    <div class="panel"><h2>Lukkedage</h2>
      ${s.closedDates.slice().sort((a, b) => a.date.localeCompare(b.date)).map((c) => `<div class="row" style="margin-bottom:6px"><span class="tag accent">${esc(fmtDate(c.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }))}</span><span>${esc(c.note)}</span><button class="link" data-act="closed-del" data-date="${c.date}">Fjern</button></div>`).join('')}
      <div class="row" style="margin-top:10px"><input class="input" type="date" id="closed-date" min="${today()}" style="width:auto"><input class="input" id="closed-note" placeholder="Fx helligdag" style="flex:1;min-width:140px"><button class="btn btn-sm" data-act="closed-add">Tilføj lukkedag</button></div>
    </div>
    <div class="panel"><h2>Åbningstider på siden</h2><p class="muted" style="margin-top:0">Den tekst, der vises under Kontakt. Selve bookingtiderne styres af barbernes arbejdstider.</p>
      ${s.openingHours.map((h, i) => `<div class="grid-2" style="margin-bottom:8px"><input class="input" data-path="settings:openingHours:${i}:label" value="${esc(h.label)}"><input class="input" data-path="settings:openingHours:${i}:value" value="${esc(h.value)}"></div>`).join('')}
    </div>
    <div class="panel"><h2>Eksisterende bookingsystem</h2><p class="muted" style="margin-top:0">Bruger salonen allerede et bookingsystem (fx Planway, Booksy eller Fresha), kan alle "Book tid"-knapper sende kunden dertil i stedet for den indbyggede booking.</p>
      <div class="field"><label>Link til eksternt bookingsystem (valgfrit)</label><input type="url" placeholder="https://" data-path="settings:externalBookingUrl" value="${esc(s.externalBookingUrl || '')}"></div>
    </div>
    <div class="panel"><h2>Demodata</h2><p class="muted" style="margin-top:0">Nulstil alle ændringer, bookinger og billeder i denne browser.</p><button class="btn btn-outline btn-sm" data-act="reset">Nulstil demo</button></div>`;
}

function adminGallery() {
  return `<div class="row between" style="margin-bottom:18px"><div><h1>Galleri</h1><p class="muted" style="margin:0">Udskift eksempelbillederne med salonens egne. Billeder gemmes i denne browser i demoen.</p></div>
    <span class="btn btn-sm file-btn">${icon.plus} Tilføj billede<input type="file" accept="image/*" data-upload="gallery-new" aria-label="Tilføj billede"></span></div>
    <div class="thumb-grid">${state.gallery.map((g) => `<div class="thumb">${media(g.src, g.title, { label: 'Intet billede' })}
      <div class="body">
        <div class="field"><label>Titel</label><input data-path="gallery:${g.id}:title" value="${esc(g.title)}"></div>
        <div class="field"><label>Kategori</label><select data-path="gallery:${g.id}:category">${GALLERY_CATEGORIES.slice(1).map((c) => `<option value="${c.id}" ${g.category === c.id ? 'selected' : ''}>${c.label}</option>`).join('')}</select></div>
        <div class="row between"><span class="btn btn-outline btn-sm file-btn">Udskift<input type="file" accept="image/*" data-upload="gallery" data-id="${g.id}" aria-label="Udskift ${esc(g.title)}"></span><button class="link" data-act="gallery-del" data-id="${g.id}">Slet</button></div>
      </div></div>`).join('')}</div>`;
}

function adminOutbox() {
  return `<h1>Udsendelser</h1><p class="muted" style="margin:0 0 18px">De e-mails og SMS'er, systemet ville sende i drift. I demoen sendes intet.</p>
    ${state.outbox.length ? `<div class="bk-list">${state.outbox.map((m) => `<div class="outbox-item"><div class="row between"><strong>${m.type} til ${esc(m.to)}</strong><span class="tag">Ikke sendt · demo</span></div><small class="muted">${esc(m.subject)} · ${new Date(m.at).toLocaleString('da-DK', { timeZone: E.TZ })}</small><pre>${esc(m.body)}</pre></div>`).join('')}</div>` : '<div class="empty">Ingen udsendelser endnu. Lav en booking på siden, så ses bekræftelsen og SMS-påmindelsen her.</div>'}`;
}

function setPath(path, value) {
  const [coll, ...rest] = path.split(':');
  let obj;
  if (coll === 'settings') obj = state.settings;
  else { obj = state[coll].find((x) => x.id === rest.shift()); }
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
  const names = ['Eksempel Kunde A', 'Eksempel Kunde B', 'Eksempel Kunde C', 'Eksempel Kunde D', 'Eksempel Kunde E', 'Eksempel Kunde F'];
  let made = 0;
  for (let d = 0; d < 7 && made < 14; d++) {
    const date = E.addDays(today(), d);
    for (const sv of state.services.filter((s) => s.active)) {
      const slots = E.availableSlots(state, { serviceId: sv.id, barberId: 'any', date, now: now() });
      if (!slots.length) continue;
      const pick = slots[Math.floor(Math.random() * slots.length)];
      const r = E.createBooking(state, { serviceId: sv.id, barberId: 'any', date, start: pick.start, customer: { name: names[made % names.length], phone: `2000000${made % 10}`, email: `kunde${made}@example.com` } }, now());
      if (r.ok) { r.booking.example = true; made++; }
      if (made % 3 === 0) break;
    }
  }
  return made;
}

// ---------- handlinger ----------
const actions = {
  menu: () => toggleMenu(true),
  'close-menu': () => toggleMenu(false),
  filter: (el) => {
    document.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === el)));
    const cat = el.dataset.cat;
    document.querySelectorAll('.g-item').forEach((g) => g.classList.toggle('hide', cat !== 'alle' && g.dataset.cat !== cat));
  },
  lightbox: (el) => openLightbox(el.dataset.id),
  'pick-service': (el) => {
    bk.serviceId = el.dataset.id; bk.date = null; bk.start = null;
    const preset = bk.presetBarber && barber(bk.presetBarber)?.serviceIds.includes(bk.serviceId);
    if (bk.barberId && bk.barberId !== 'any' && !barber(bk.barberId)?.serviceIds.includes(bk.serviceId)) bk.barberId = null;
    if (preset) { bk.barberId = bk.presetBarber; goStep(3); } else goStep(2);
  },
  'pick-barber': (el) => { bk.barberId = el.dataset.id; bk.date = null; bk.start = null; goStep(3); },
  step: (el) => {
    const n = +el.dataset.step;
    if (n === 4 && bk.start == null) return;
    goStep(n);
  },
  month: (el) => {
    const target = mb?.moving && location.hash.startsWith('#/min-booking') ? mb : bk;
    target.month = addMonths(target.month, +el.dataset.dir);
    target === mb ? renderManage() : renderBooking();
  },
  'pick-date': (el) => {
    if (location.hash.startsWith('#/min-booking')) { mb.date = el.dataset.date; mb.start = null; renderManage(); return; }
    bk.date = el.dataset.date; bk.start = null; bk.notice = '';
    renderBooking();
    document.querySelector('.times')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },
  'pick-time': (el) => {
    if (location.hash.startsWith('#/min-booking')) { mb.start = +el.dataset.start; renderManage(); return; }
    const y = window.scrollY;
    bk.start = +el.dataset.start; renderBooking(); window.scrollTo(0, y);
  },
  'submit-booking': () => document.getElementById('customer-form')?.requestSubmit(),
  ics: (el) => {
    const b = state.bookings.find((x) => x.ref === el.dataset.ref);
    const blob = new Blob([icsFor(b)], { type: 'text/calendar' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `stylebybrothers-${b.ref}.ics`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  'mb-move': () => { mb.moving = true; mb.date = firstAvailableDate(mb.booking.serviceId, mb.booking.anyBarber ? 'any' : mb.booking.barberId, mb.booking.id); mb.month = monthStart(mb.date || today()); mb.start = null; mb.msg = ''; renderManage(); },
  'mb-stop': () => { mb.moving = false; renderManage(); },
  'mb-save': () => {
    const r = E.moveBooking(state, mb.booking, { date: mb.date, start: mb.start }, now());
    if (r.ok) { queueMessages(mb.booking, 'flyttet'); save(); mb.moving = false; mb.msg = 'Din tid er flyttet. (Demo: der er ikke sendt nogen e-mail.)'; mb.msgKind = 'ok'; }
    else { mb.msg = r.error === 'too_late' ? 'Tiden er for tæt på til at ændre online.' : 'Tiden er ikke længere ledig. Vælg en anden.'; mb.msgKind = 'danger'; mb.start = null; }
    renderManage();
  },
  'mb-cancel': () => {
    if (!confirm('Vil du aflyse din tid?')) return;
    const r = E.cancelBooking(state, mb.booking, now());
    if (r.ok) { queueMessages(mb.booking, 'aflyst'); save(); mb.msg = 'Din tid er aflyst. (Demo: der er ikke sendt nogen e-mail.)'; mb.msgKind = 'ok'; }
    else { mb.msg = 'Tiden er for tæt på til at aflyse online. Ring til salonen.'; mb.msgKind = 'danger'; }
    renderManage();
  },
  'mb-reset': () => { mb = null; history.replaceState(null, '', '#/min-booking'); renderManage(new URLSearchParams()); },
  'admin-login': () => { try { sessionStorage.setItem('sbb-admin', '1'); } catch { window.__sbbAdmin = true; } route(); },
  'admin-logout': () => { try { sessionStorage.removeItem('sbb-admin'); } catch { window.__sbbAdmin = false; } location.hash = '#/'; },
  'admin-day': (el) => { adminDate = E.addDays(adminDate, +el.dataset.dir); adminMove = null; route(); },
  'admin-today': () => { adminDate = today(); route(); },
  seed: () => { const n = seedBookings(); save(); toast(`${n} eksempelbookinger lavet for de næste 7 dage`); route(); },
  'move-start': (el) => { const b = state.bookings.find((x) => x.id === el.dataset.id); adminMove = { id: b.id, date: b.date, start: null, barberId: b.barberId }; route(); },
  'move-stop': () => { adminMove = null; route(); },
  'move-save': (el) => {
    const b = state.bookings.find((x) => x.id === el.dataset.id);
    if (adminMove.start == null) { toast('Vælg en ny tid'); return; }
    const r = E.moveBooking(state, b, { date: adminMove.date, start: adminMove.start, barberId: adminMove.barberId }, now(), 'salon');
    if (r.ok) { queueMessages(b, 'flyttet'); save(); adminMove = null; adminDate = b.date; toast('Bookingen er flyttet'); } else toast('Tiden er ikke ledig');
    route();
  },
  'admin-cancel': (el) => {
    const b = state.bookings.find((x) => x.id === el.dataset.id);
    if (!confirm(`Aflys ${b.name} kl. ${E.fmtTime(b.start)}?`)) return;
    E.cancelBooking(state, b, now(), 'salon'); queueMessages(b, 'aflyst'); save(); toast('Bookingen er aflyst'); route();
  },
  'service-add': () => { state.services.push({ id: uid('s'), name: 'Ny behandling', desc: '', duration: 30, price: 0, active: false }); save(); route(); },
  'service-del': (el) => { if (!confirm('Slet behandlingen? Eksisterende bookinger bevares.')) return; state.services = state.services.filter((s) => s.id !== el.dataset.id); state.barbers.forEach((b) => { b.serviceIds = b.serviceIds.filter((id) => id !== el.dataset.id); }); save(); route(); },
  'service-move': (el) => { const i = state.services.findIndex((s) => s.id === el.dataset.id); const j = i + +el.dataset.dir; [state.services[i], state.services[j]] = [state.services[j], state.services[i]]; save(); route(); },
  'barber-add': () => { const base = defaultState().barbers[0]; state.barbers.push({ ...structuredClone(base), id: uid('b'), name: `Barber ${state.barbers.length + 1}`, role: '', active: false }); save(); route(); },
  'barber-del': (el) => { if (!confirm('Slet barberen? Eksisterende bookinger bevares.')) return; state.barbers = state.barbers.filter((b) => b.id !== el.dataset.id); save(); route(); },
  'barber-photo-del': (el) => { barber(el.dataset.id).photo = ''; save(); route(); },
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
  'gallery-del': (el) => { if (!confirm('Slet billedet fra galleriet?')) return; state.gallery = state.gallery.filter((g) => g.id !== el.dataset.id); save(); route(); },
  reset: () => { if (!confirm('Nulstil al demodata i denne browser?')) return; state = defaultState(); save(); toast('Demoen er nulstillet'); route(); },
};

app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || !actions[el.dataset.act]) return;
  if (el.tagName === 'BUTTON') e.preventDefault();
  actions[el.dataset.act](el, e);
});
document.body.addEventListener('click', (e) => {
  const el = e.target.closest('#menu [data-act]');
  if (el && !app.contains(el)) actions[el.dataset.act]?.(el, e);
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
      else if (kind === 'gallery') state.gallery.find((g) => g.id === el.dataset.id).src = src;
      else state.gallery.unshift({ id: uid('g'), category: 'fades', title: 'Nyt billede', src });
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
    if (b) renderConfirmation(b); else { location.hash = '#/booking'; }
    return;
  }
  if (path.startsWith('/booking')) { currentView = 'booking'; startBooking(params); window.scrollTo(0, 0); return; }
  if (path.startsWith('/min-booking')) { currentView = 'manage'; renderManage(params); window.scrollTo(0, 0); return; }
  if (path.startsWith('/admin')) { currentView = 'admin'; const y = window.scrollY; renderAdmin(path.split('/')[2]); window.scrollTo(0, y); return; }
  // Forside: "#/#galleri" eller "#galleri" ruller til sektionen.
  const target = h.includes('#', 1) ? h.slice(h.indexOf('#', 1) + 1) : (!h.startsWith('#/') ? h.slice(1) : '');
  if (currentView === 'home' && target) { document.getElementById(target)?.scrollIntoView({ behavior: 'smooth' }); return; }
  if (currentView === 'home' && !target && h === '#/' && document.querySelector('.hero')) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  currentView = 'home';
  renderHome(target);
}
window.addEventListener('hashchange', route);
route();
