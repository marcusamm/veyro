import { escapeHtml as esc } from '../lib/email';

export const AJ_PHONE = '60 64 41 43';
export const AJ_TELEPHONE = 'tel:+4560644143';
export const AJ_ADDRESS = 'Sorøvej 5kl, Slagelse';
export const AJ_DIRECTIONS = 'https://www.google.com/maps/dir/?api=1&destination=Sor%C3%B8vej%205kl%2C%20Slagelse';
const openingHours = `<section class="opening-hours" aria-label="Åbningstider">
  <h3>Åbningstider</h3>
  <p>Mandag–fredag kl. 09.00–16.00</p>
  <p>Lørdag og søndag efter aftale.</p>
</section>`;
const instagram = 'https://www.instagram.com/ajauto4200/';
const navigation = [
  ['/', 'Forside'],
  ['/ydelser', 'Ydelser'],
  ['/om-os', 'Om os'],
  ['/kontakt', 'Kontakt'],
];

/** Server-rendered booking actions stay useful before JavaScript is available. */
function bookingAction(ready: boolean, className = 'button'): string {
  return `<a class="${className}" data-booking-cta href="${ready ? '/booking' : AJ_TELEPHONE}">${ready ? 'Book tid' : 'Ring og aftal en tid'}</a>`;
}

function directions(className = 'text-link'): string {
  return `<a class="${className}" href="${AJ_DIRECTIONS}" target="_blank" rel="noopener noreferrer">Find vej</a>`;
}

function visitActions(ready: boolean, className = 'actions'): string {
  return `<div class="${className}">
    ${bookingAction(ready)}
    ${ready ? `<a class="phone-link" data-booking-phone href="${AJ_TELEPHONE}">Ring ${AJ_PHONE}</a>` : `<span class="action-phone" data-booking-phone>${AJ_PHONE}</span>`}
  </div>`;
}

export interface ShellOptions {
  bookingReady?: boolean;
  admin?: boolean;
  noindex?: boolean;
}

export function shell(path: string, title: string, description: string, body: string, options: ShellOptions = {}): string {
  const ready = options.bookingReady === true;
  const pageClass = path === '/' ? 'page-home' : options.admin ? 'page-admin' : 'page-inner';
  // The booking page already contains the action or form in its first screen.
  const headerAction = path === '/booking' ? '' : `<div class="header-action">${bookingAction(ready, 'button button-small')}</div>`;
  return `<!doctype html>
<html lang="da">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#1b1922">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="https://aj.veyro.dk${esc(path)}">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:type" content="website">
  ${options.noindex ? '<meta name="robots" content="noindex,nofollow">' : ''}
  <link rel="icon" href="/aj-logo.png" type="image/png">
  <link rel="stylesheet" href="/aj.css">
  ${options.admin ? '<link rel="stylesheet" href="/aj-admin.css">' : ''}
  <script src="${options.admin ? '/aj-admin.js' : '/aj.js'}" defer></script>
</head>
<body class="${pageClass}" data-booking-ready="${ready}">
  <a class="skip" href="#main">Gå til indhold</a>
  <header class="site-header">
    <div class="container header-inner">
      <a class="brand" href="/" aria-label="AJ Auto, forside">
        <span class="brand-image"><img src="/aj-logo.png" alt="AJ Auto" width="1536" height="1024"></span>
      </a>
      <nav id="navigation" aria-label="Hovedmenu">
        ${navigation.map(([url, label]) => `<a href="${url}"${path === url ? ' aria-current="page"' : ''}>${label}</a>`).join('\n        ')}
      </nav>
      ${headerAction}
      <button class="menu-toggle" type="button" aria-expanded="false" aria-controls="navigation">Menu</button>
    </div>
  </header>
  <main id="main">${body}</main>
  <footer class="site-footer">
    <div class="container footer-inner">
      <div class="footer-name"><a href="/">AJ Auto</a></div>
      <nav class="footer-links" aria-label="Links i bunden">
        <a href="/kontakt">Kontakt</a>
        <a href="${instagram}" target="_blank" rel="noopener noreferrer">Instagram</a>
        <a href="/kontakt#personoplysninger">Personoplysninger</a>
        <a href="/admin">Værkstedets login</a>
      </nav>
      <p class="footer-meta">© ${new Date().getFullYear()} AJ Auto <small>Udviklet af <a href="https://veyro.dk/">Veyro</a></small></p>
    </div>
  </footer>
</body>
</html>`;
}

export function home(bookingReady: boolean): string {
  return `
<section class="home-hero">
  <div class="container hero-inner">
    <div class="hero-copy">
      <p class="hero-location">AJ Auto · ${AJ_ADDRESS}</p>
      <h1>Olieskift og bilhandel <span>i Slagelse</span></h1>
      ${visitActions(bookingReady, 'hero-actions')}
    </div>
  </div>
</section>
<section class="container home-services" aria-labelledby="home-services-title">
  <h2 id="home-services-title" class="sr-only">Vores ydelser</h2>
  <div class="service-list">
    <article class="service-row">
      <h3>Olieskift</h3>
      <div class="service-row-copy">
        <p>Vi skifter motorolie og oliefilter. Ring, hvis du vil kende prisen for din bil.</p>
        <a class="text-link" href="/ydelser#olieskift">Læs om olieskift</a>
      </div>
    </article>
    <article class="service-row">
      <h3>Køb, salg og bytte</h3>
      <div class="service-row-copy">
        <p>Vil du sælge din bil eller lade den indgå i en byttehandel? Ring og fortæl, hvilken bil du har.</p>
        <a class="text-link" href="/ydelser#bilhandel">Læs om bilhandel</a>
      </div>
    </article>
  </div>
  <div id="home-campaign" hidden></div>
</section>
<section class="location-end" aria-labelledby="home-location-title">
  <div class="container location-end-inner">
    <div><h2 id="home-location-title">Find værkstedet</h2><address class="location-address">${AJ_ADDRESS}</address></div>
    ${openingHours}
    <div class="location-links">${directions()}</div>
  </div>
</section>`;
}

export function services(bookingReady: boolean): string {
  return `
<div class="container services-page">
  <header class="page-heading services-intro">
    <h1>Olieskift og bilhandel</h1>
    <nav class="service-index" aria-label="Ydelser på siden">
      <a href="#olieskift">Olieskift</a>
      <a href="#bilhandel">Køb, salg og bytte</a>
    </nav>
  </header>
  <section class="service-detail" id="olieskift" aria-labelledby="oil-title">
    <div class="service-detail-title"><h2 id="oil-title">Olieskift</h2></div>
    <div class="service-detail-body">
      <p>Vi skifter motorolie og oliefilter. Fortæl os, hvilken bil du har, så aftaler vi pris og tidspunkt.</p>
      <div id="services-campaign" hidden></div>
      ${visitActions(bookingReady, 'service-actions')}
    </div>
  </section>
  <section class="service-detail" id="bilhandel" aria-labelledby="trade-title">
    <div class="service-detail-title"><h2 id="trade-title">Køb, salg og bytte</h2></div>
    <div class="service-detail-body">
      <p>Vil du sælge din bil eller lade den indgå i en byttehandel? Ring og fortæl, hvilken bil du har.</p>
      <p>Du kan også kontakte os, hvis du søger en anden bil.</p>
      <a class="text-link" href="/kontakt">Kontakt os om bilhandel</a>
    </div>
  </section>
</div>`;
}

export function about(bookingReady: boolean): string {
  return `
<section class="container about-page">
  <header class="page-heading about-heading"><h1>Vi er AJ Auto</h1></header>
  <div class="about-layout">
    <div class="about-copy">
      <p class="lead">Vi holder til på Sorøvej i Slagelse.</p>
      <p>Hos os kan du få skiftet motorolie og oliefilter. Vi beskæftiger os også med køb, salg og bytte af biler.</p>
      <p>Vil du aftale et olieskift eller tale om bilhandel? Ring og fortæl os om din bil.</p>
      ${visitActions(bookingReady, 'about-contact')}
    </div>
    <aside class="about-address" aria-label="Adresse og Instagram">
      <h2>AJ Auto</h2>
      <address>${AJ_ADDRESS}</address>
      ${directions()}
      <p><a class="text-link" href="${instagram}" target="_blank" rel="noopener noreferrer">@ajauto4200</a></p>
    </aside>
  </div>
</section>`;
}

export function contact(_bookingReady: boolean): string {
  return `
<section class="container contact-page">
  <header class="page-heading contact-heading"><h1>Kontakt AJ Auto</h1></header>
  <div class="contact-details">
    <div class="contact-detail">
      <a class="contact-phone" href="${AJ_TELEPHONE}"><strong>${AJ_PHONE}</strong><span>Ring</span></a>
    </div>
    <div class="contact-detail contact-address">
      <address>${AJ_ADDRESS}</address>
      ${directions()}
    </div>
  </div>
  ${openingHours}
  <div class="contact-layout">
    <div class="contact-copy"><h2>Skriv til os</h2><p>Fortæl kort, hvad du har brug for. Beskeden bestiller ikke en tid.</p></div>
    <div class="form-panel">
      <noscript><p>Slå JavaScript til for at sende en besked, eller <a href="${AJ_TELEPHONE}">ring på ${AJ_PHONE}</a>.</p></noscript>
      <form id="contact-form" method="post" action="/api/contact" aria-label="Skriv til AJ Auto">
        <div class="form-grid">
          <label>Navn<input name="name" autocomplete="name" required maxlength="100"></label>
          <label><span>Telefon <span class="fineprint">(valgfrit)</span></span><input type="tel" name="phone" autocomplete="tel" maxlength="30"></label>
        </div>
        <label>E-mail<input type="email" name="email" autocomplete="email" required maxlength="254"></label>
        <label>Besked<textarea name="message" rows="5" required minlength="10" maxlength="2000"></textarea></label>
        <label class="honey" aria-hidden="true">Hjemmeside<input name="website" tabindex="-1" autocomplete="off"></label>
        <p class="fineprint">Vi bruger oplysningerne til at svare dig. Undlad at skrive følsomme oplysninger. <a href="#personoplysninger">Om dine oplysninger</a>.</p>
        <div id="contact-status" class="form-status" role="status" aria-live="polite"></div>
        <button class="button" type="submit">Send besked</button>
      </form>
    </div>
  </div>
</section>
<section class="container privacy-section" id="personoplysninger" aria-labelledby="privacy-title">
  <h2 id="privacy-title">Dine oplysninger</h2>
  <p>AJ Auto bruger navn, e-mail, telefon og de oplysninger, du selv giver, til at svare dig og administrere din aftale. Oplysningerne vises kun for medarbejdere med adgang. Del ikke personlige booking- og kalenderlinks med andre.</p>
  <p>Veyro driver hjemmesiden og bookingsystemet med Cloudflare til hosting og lagring og Resend til e-mail. Hjemmesiden bruger kun nødvendige teknologier til formularer og login, ingen statistik- eller reklamecookies.</p>
  <p>Vil du have indsigt i, rettet eller slettet dine oplysninger? Ring til AJ Auto på <a href="${AJ_TELEPHONE}">${AJ_PHONE}</a>.</p>
</section>`;
}

export function booking(bookingReady: boolean): string {
  return `
<section class="container booking-page">
  <header class="page-heading booking-heading">
    <h1 data-booking-title>${bookingReady ? 'Book tid' : 'Aftal en tid'}</h1>
  </header>
  <div class="booking-layout">
    <div class="booking-panel">
      <ol class="booking-steps" aria-label="Bookingtrin"${bookingReady ? '' : ' hidden'}>
        <li aria-current="step"><span>1</span>Ydelse</li>
        <li><span>2</span>Tid</li>
        <li><span>3</span>Oplysninger</li>
        <li><span>4</span>Bekræft</li>
      </ol>
      <div id="booking-root" aria-live="polite">
        ${bookingReady ? '<p class="loading">Henter ydelser…</p>' : `<div class="empty-state"><p>Du kan ikke booke online lige nu. Ring, så aftaler vi en tid til din bil.</p>${bookingAction(false)}<p class="booking-phone">${AJ_PHONE}</p></div>`}
      </div>
      <noscript><p>${bookingReady ? `Slå JavaScript til for at booke online, eller <a href="${AJ_TELEPHONE}">ring på ${AJ_PHONE}</a>.` : 'Du kan aftale en tid på telefon.'}</p></noscript>
    </div>
    <div class="booking-meta">
      <address>AJ Auto · ${AJ_ADDRESS}</address>
      <p>Mandag–fredag kl. 09.00–16.00. <a href="${AJ_TELEPHONE}">Ring for en tid i weekenden</a>.</p>
    </div>
  </div>
</section>`;
}

export function manage(_bookingReady: boolean): string {
  return `
<section class="container manage-container">
  <header class="page-heading manage-heading"><h1 data-booking-title>Din aftale</h1></header>
  <div class="booking-panel" id="manage-root" aria-live="polite"><p class="loading">Henter din aftale…</p></div>
</section>`;
}
