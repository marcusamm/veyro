// Shared styles for the AJ Auto pages and customer booking flow.
export const css = `
:root {
  color-scheme: light;
  --ink: #19191c;
  --muted: #55565b;
  --paper: #f6f5f1;
  --line: #d4d3ce;
  --violet: #40258e;
  --violet-hover: #2c166e;
  --gutter: clamp(20px, 5.5vw, 96px);
  --heading: "Helvetica Neue", Arial, sans-serif;
  font: 100%/1.55 "Helvetica Neue", Arial, sans-serif;
  color: var(--ink);
  background: white;
}
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; }
main { flex: 1; }
.sr-only {
  position: absolute; height: 1px; width: 1px; overflow: hidden;
  clip-path: inset(50%); padding: 0; border: 0; white-space: nowrap;
}
body, main { min-width: 0; }
main { min-height: 52vh; }
[hidden] { display: none !important; }
img { max-width: 100%; display: block; }
h1, h2, h3, p, ol, ul, dl, dd, address { margin: 0; }
address { font-style: normal; }
h1, h2, h3 {
  font-family: var(--heading);
  font-weight: 700;
  line-height: 1.04;
  letter-spacing: -.047em;
  text-wrap: balance;
}
h1 { font-size: clamp(2.8rem, 6.4vw, 6.4rem); }
h2 { font-size: clamp(1.9rem, 3.4vw, 3.6rem); }
h3 { font-size: clamp(1.32rem, 2vw, 2rem); }
a { color: var(--violet); text-underline-offset: .22em; text-decoration-thickness: .07em; }
a:hover { color: var(--violet-hover); text-decoration-thickness: .12em; }
button, input, select, textarea { font: inherit; }
button { cursor: pointer; }
button:disabled { cursor: default; opacity: .55; }
:focus-visible { outline: 3px solid #795bd9; outline-offset: 4px; }
.container { width: min(calc(100% - 2 * var(--gutter)), 1320px); margin-inline: auto; }
.skip { position: fixed; inset: 8px auto auto 12px; z-index: 20; transform: translateY(-160%); background: white; padding: 9px 16px; }
.skip:focus { transform: none; }
.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 48px;
  padding: 12px 21px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: var(--violet);
  color: white;
  font-weight: 650;
  font-size: 1rem;
  line-height: 1.25;
  text-decoration: none;
  text-align: center;
}
.button:hover { background: var(--violet-hover); color: white; }
.button-secondary { color: var(--ink); border-color: #959599; background: white; }
.button-secondary:hover { color: var(--ink); background: var(--paper); }
.text-link, .phone-link { display: inline-block; font-weight: 600; }
.site-header { position: relative; z-index: 5; border-bottom: 1px solid var(--line); background: white; }
.header-inner { display: flex; align-items: center; gap: clamp(18px, 3vw, 44px); min-height: 94px; }
.brand { margin-right: auto; display: inline-flex; }
.brand-image {
  display: block;
  width: 98px;
  aspect-ratio: 1.52;
  position: relative;
  overflow: hidden;
}
.brand-image img { position: absolute; width: 160%; max-width: none; height: auto; left: -29%; top: -33%; mix-blend-mode: multiply; }
#navigation { display: flex; align-items: center; gap: clamp(18px, 2.5vw, 38px); }
#navigation a, .menu-toggle {
  color: var(--ink);
  text-decoration: none;
  font-size: .97rem;
  font-weight: 600;
}
#navigation a { padding-block: 8px; }
#navigation a:hover, #navigation a[aria-current="page"] { color: var(--violet); text-decoration: underline; text-underline-offset: 7px; }
.menu-toggle { display: none; }
.home-hero { background: var(--ink); color: white; }
.hero-inner { padding-block: clamp(57px, 6.4vw, 100px) clamp(54px, 6.1vw, 94px); }
.home-hero h1 {
  font-size: clamp(3.4rem, 8.55vw, 8.75rem);
  line-height: .98;
  letter-spacing: -.046em;
  max-width: 100%;
}
.home-hero h1 span { display: block; font-style: italic; color: #eae8e3; }
.hero-location { margin-bottom: 25px; color: #e3e2e0; font-size: clamp(.95rem, 1.4vw, 1.16rem); }
.hero-actions, .actions, .service-actions, .location-links, .about-contact, .manage-actions {
  display: flex; flex-wrap: wrap; align-items: center; gap: 12px 25px;
}
.hero-actions { margin-top: clamp(26px, 3.2vw, 46px); }
.home-hero .button { background: #e3dbff; color: #281357; }
.home-hero .button:hover { background: white; }
.home-hero .phone-link, .home-hero .text-link { color: white; }
.home-services { padding-block: clamp(16px, 2.3vw, 38px); }
.service-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, .9fr);
  gap: 24px 7%;
  padding-block: clamp(24px, 3.2vw, 46px);
  border-top: 1px solid var(--line);
  align-items: baseline;
}
.service-row:first-child { border-top: 0; }
.service-row-copy .text-link { margin-top: 12px; }
.service-row h2, .service-row h3 { font-size: clamp(1.8rem, 3.65vw, 3.9rem); }
.service-row h2 a, .service-row h3 a { color: var(--ink); text-decoration: none; }
.service-row h2 a:hover, .service-row h3 a:hover { color: var(--violet); text-decoration: underline; }
.service-row-copy p, .service-detail-body p, .about-copy p, .lead {
  font-size: clamp(1.06rem, 1.45vw, 1.32rem);
  max-width: 52ch;
}
.service-row-copy p { color: var(--muted); }
.service-actions { margin-top: 16px; }
.location-end { background: var(--paper); }
.location-end-inner { padding-block: clamp(34px, 4.6vw, 68px); display: flex; flex-wrap: wrap; gap: 20px 7%; justify-content: space-between; align-items: center; }
.opening-hours h3 { font-size: 1.05rem; letter-spacing: 0; margin-bottom: 5px; }
.opening-hours p { color: var(--muted); }
.contact-page .opening-hours { margin-bottom: 30px; }
.location-address { font-size: clamp(1.45rem, 2.7vw, 2.7rem); font-weight: 650; letter-spacing: -.035em; }
.site-footer { border-top: 1px solid var(--line); padding-block: clamp(28px, 3vw, 40px) 24px; font-size: .91rem; }
.footer-inner { display: grid; grid-template-columns: auto 1fr; align-items: baseline; gap: 28px 32px; }
.footer-name { font-weight: 700; }
.footer-links { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 14px 28px; }
.footer-meta {
  grid-column: 1 / -1;
  display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 12px 24px;
  padding-top: 20px; border-top: 1px solid var(--line);
  color: var(--muted); font-size: .8125rem;
}
.footer-meta small { font-size: inherit; }
.site-footer a { color: var(--muted); }
.page-heading, .services-intro, .about-heading, .contact-heading { padding-top: clamp(40px, 6vw, 90px); }
.lead { margin-top: 18px; color: var(--muted); }
.services-page, .about-page, .contact-page { padding-bottom: clamp(56px, 7vw, 100px); }
.service-index { display: flex; gap: 22px; flex-wrap: wrap; padding-block: 18px; }
.service-detail, .about-layout, .contact-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr);
  gap: 30px 7%;
}
.service-detail { padding-block: clamp(36px, 4.6vw, 72px); border-top: 1px solid var(--line); scroll-margin-top: 20px; }
.service-detail-body > * + *, .about-copy > * + *, .form-panel > * + * { margin-top: 18px; }
.cars-page, .car-detail { padding-bottom: clamp(56px, 7vw, 100px); }
.cars-page h1, .car-detail h1 { margin-bottom: clamp(26px, 4vw, 52px); }
.cars-empty { padding-top: 24px; border-top: 1px solid var(--line); }
.cars-empty p:first-child { margin-bottom: 8px; font-size: 1.22rem; }
.car-grid { list-style: none; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 285px), 1fr)); gap: 38px 28px; }
.car-preview { min-width: 0; padding-top: 16px; border-top: 1px solid var(--line); }
.car-preview-link { display: block; color: var(--ink); text-decoration: none; }
.car-preview-link:hover h2 { text-decoration: underline; }
.car-preview h2 { font-size: clamp(1.5rem, 2.5vw, 2.1rem); overflow-wrap: anywhere; }
.car-cover, .car-gallery img { width: 100%; aspect-ratio: 3 / 2; object-fit: cover; }
.car-cover { margin-bottom: 14px; }
.car-facts { margin-top: 8px; color: var(--muted); overflow-wrap: anywhere; }
.car-preview-price { margin-top: 8px; font-size: 1.16rem; font-weight: 650; }
.car-pages { display: flex; gap: 24px; margin-top: 36px; }
.car-detail h1 { margin-top: 16px; overflow-wrap: anywhere; }
.car-details-layout { display: grid; gap: 24px 5%; align-items: start; }
.car-details-layout.has-photos { grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); }
.car-primary-photo img { width: 100%; }
.car-gallery { grid-column: 1; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.car-price { font-size: clamp(1.8rem, 3vw, 2.5rem); font-weight: 650; line-height: 1.2; }
.car-terms { max-width: 64ch; min-width: 0; }
.car-terms > * + * { margin-top: 24px; }
.car-specs > div { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 16px; border-bottom: 1px solid var(--line); padding-block: 8px; }
.car-specs dt { color: var(--muted); }
.car-specs dd, .car-description { overflow-wrap: anywhere; }
.car-description { white-space: pre-line; }
.workshop-services dt { font-weight: 700; font-size: 1.12rem; }
.workshop-services dt:not(:first-child) { margin-top: 22px; }
.workshop-services dd { margin-top: 4px; max-width: 52ch; color: var(--muted); }
.about-layout { margin-top: clamp(30px, 4vw, 68px); }
.about-address { border-left: 3px solid var(--ink); padding-left: clamp(20px, 3vw, 52px); }
.about-address address, .contact-address address { font-size: clamp(1.45rem, 2.6vw, 2.8rem); line-height: 1.2; font-weight: 600; letter-spacing: -.035em; }
.about-address h2 { font-size: 1.15rem; margin-bottom: 10px; }
.about-address a, .about-contact { margin-top: 16px; }
.about-copy > .lead:first-child { margin-top: 0; }
.contact-details { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 32px; padding-block: clamp(28px, 4vw, 64px); }
.contact-detail { display: grid; gap: 10px; justify-items: start; align-content: start; }
.contact-phone { font-size: clamp(2rem, 4vw, 4rem); font-weight: 650; letter-spacing: -.045em; line-height: 1.1; }
.contact-phone { display: inline-flex; flex-direction: column; align-items: flex-start; gap: 10px; text-decoration: none; }
.contact-phone strong { order: -1; color: var(--ink); }
.contact-phone span { font-size: 1rem; line-height: 1.55; letter-spacing: 0; text-decoration: underline; text-underline-offset: .22em; }
.contact-copy p { max-width: 33ch; margin-top: 16px; color: var(--muted); }
.contact-layout { border-top: 1px solid var(--line); padding-top: clamp(32px, 4vw, 60px); }
.privacy-section { margin-block: 0 clamp(44px, 4vw, 72px); max-width: 74ch; }
.privacy-section h2 { margin-bottom: 16px; font-size: 1.55rem; }
.privacy-section p + p { margin-top: 12px; }
.booking-page, .manage-container, .message-page { padding-block: clamp(40px, 5vw, 76px) clamp(60px, 9vw, 120px); }
.booking-heading, .manage-heading { padding-top: 0; margin-bottom: clamp(24px, 4vw, 52px); }
.booking-layout, .manage-container { max-width: 54rem; }
.booking-layout h2, .manage-container h2, .form-panel h2 { font-size: clamp(1.7rem, 2.8vw, 2.45rem); }
.booking-panel > * + *, .message-page > * + * { margin-top: 20px; }
.booking-meta, .booking-context, .fineprint, .loading { color: var(--muted); }
.booking-meta { margin-top: 30px; }
.booking-steps { list-style: none; padding: 0; display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; margin-bottom: 30px; }
.booking-steps li { border-top: 2px solid var(--line); padding-top: 8px; color: var(--muted); font-size: .88rem; }
.booking-steps li[aria-current="step"] { color: var(--violet); font-weight: 700; border-color: var(--violet); }
.booking-steps span { margin-right: 5px; }
#booking-root > * + *, #manage-root > * + *, .empty-state > * + * { margin-top: 16px; }
#contact-form, #details-form { display: grid; gap: 18px; }
#contact-form button { justify-self: start; }
form label, .booking-panel label { display: grid; gap: 6px; color: var(--ink); font-size: .97rem; font-weight: 600; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
input, textarea, select { min-width: 0; max-width: 100%; }
form input:not([type="checkbox"]), form textarea, .booking-panel input, .booking-panel select {
  width: 100%; min-height: 46px; padding: 10px 12px; border: 1px solid #929197; border-radius: 4px; background: white; color: var(--ink); font-weight: 400;
}
textarea { resize: vertical; }
.fineprint { font-size: .91rem; font-weight: 400; }
form .field-error { display: block; color: #792f46; font-size: .875rem; font-weight: 500; line-height: 1.4; }
form :is(input, select, textarea)[aria-invalid="true"] { border-color: #92445c; }
.honey { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
.form-status:not(:empty), .campaign:not([hidden]) { padding: 12px 16px; border-left: 3px solid var(--violet); background: #f4f1fb; }
.form-status:empty { display: none; }
.form-status.error { color: #79262a; background: #fff3ef; border-color: #9b3735; }
.choice, .slot {
  background: white; border: 1px solid #a2a0a6; border-radius: 4px; color: var(--ink); text-align: left; padding: 15px 18px;
}
.choice { width: 100%; }
.service-choices { display: grid; gap: 9px; }
.choice-heading { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 4px 16px; }
.choice-heading > span { color: var(--muted); font-size: .9rem; }
.choice small { margin-top: 3px; }
.booking-by-agreement { padding-top: 20px; }
.booking-by-agreement h3 { font-size: 1.17rem; letter-spacing: 0; margin-bottom: 7px; }
.choice:hover, .slot:hover, .slot[aria-pressed="true"] { border-color: var(--violet); background: #f3effb; }
.choice small, .slot small { display: block; color: var(--muted); }
.choice strong { font-size: 1.17rem; }
.slots { display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 8px; margin-block: 12px; }
.slot { padding: 8px 12px; }
.slot[aria-pressed="true"] { box-shadow: inset 0 0 0 1px var(--violet); }
.booking-controls { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-top: 24px; }
.back-button { border: 0; background: transparent; color: var(--violet); padding: 10px 0; text-decoration: underline; text-underline-offset: 4px; }
.booking-summary { margin-block: 20px; }
.booking-summary > div { display: grid; grid-template-columns: minmax(95px, 32%) 1fr; gap: 12px; border-top: 1px solid var(--line); padding-block: 10px; }
.booking-summary dt { color: var(--muted); }
.booking-summary dd, .saved-link { overflow-wrap: anywhere; }
.campaign { margin-block: 16px; }
@media (max-width: 760px) {
  .car-details-layout.has-photos { grid-template-columns: 1fr; }
  .header-inner { min-height: 76px; gap: 12px; }
  .brand-image { width: 79px; }
  .menu-toggle { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 44px; padding: 7px; border: 0; background: white; }
  .header-action .button { min-height: 42px; font-size: .86rem; padding: 9px 12px; }
  #navigation { display: none; position: absolute; inset: 100% 0 auto; flex-direction: column; align-items: stretch; gap: 0; padding: 8px var(--gutter) 16px; border-bottom: 1px solid var(--line); background: white; }
  #navigation.is-open { display: flex; }
  #navigation a { padding: 12px 0; }
  .hero-inner { padding-block: 49px; }
  .home-hero h1 { font-size: clamp(3.25rem, 12.8vw, 5.5rem); }
  .hero-location { margin-bottom: 21px; }
  .service-row, .service-detail, .about-layout, .contact-layout, .contact-details { grid-template-columns: 1fr; }
  .service-row { gap: 12px; }
  .service-detail, .about-layout, .contact-layout { gap: 22px; }
  .about-address { border-left: 0; border-top: 1px solid var(--line); padding: 24px 0 0; }
  .location-end-inner { align-items: start; flex-direction: column; gap: 12px; }
  .footer-inner { grid-template-columns: 1fr; gap: 24px; }
  .footer-links { justify-content: flex-start; }
}
@media (scripting: none) {
  #contact-form, #adm-login-form { display: none; }
}
@media (max-width: 760px) and (scripting: none) {
  .header-inner { flex-wrap: wrap; padding-block: 8px; }
  .menu-toggle { display: none; }
  #navigation { display: flex; flex-direction: row; flex-wrap: wrap; position: static; order: 3; width: 100%; gap: 8px 18px; padding: 0; border: 0; }
}
@media (max-width: 510px) {
  .form-grid { grid-template-columns: 1fr; }
  .booking-steps li { font-size: .77rem; }
  .booking-steps span { display: block; }
}
`;
