const font = `
@font-face {
  font-family: "Manrope";
  src: url("/manrope.woff2") format("woff2");
  font-weight: 200 800;
  font-display: swap;
}
`;

export const webmailCss = font + `
:root {
  color-scheme: light;
  font-family: "Manrope", system-ui, sans-serif;
  color: #191916;
  background: #f4f2ec;
  -webkit-text-size-adjust: 100%;
}
* { box-sizing: border-box; }
body {
  margin: 0 auto;
  width: min(100%, 100rem);
  min-height: 100vh;
  padding: 0 clamp(1.35rem, 6.1vw, 7rem);
}
.mail-top {
  min-height: 5.25rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  border-bottom: 1px solid #cbc8c0;
}
.mail-brand { display: flex; align-items: center; gap: .6rem; font-size: 1.55rem; font-weight: 800; letter-spacing: -.075em; }
.mail-brand img { display: block; }
.mail-home {
  color: #534f49;
  padding-block: .8rem;
  font-size: .9rem;
  font-weight: 600;
  text-underline-offset: .24em;
  text-decoration-color: #b1ada4;
}
.mail-home:hover { color: #191916; text-decoration-color: currentColor; }
a:focus-visible { outline: 3px solid #a03a12; outline-offset: 5px; }
.mail-desk {
  display: grid;
  grid-template-columns: 1.05fr 1fr;
  align-items: center;
  gap: clamp(2.25rem, 5vw, 6rem);
  max-width: 78rem;
  margin: 0 auto;
  min-height: min(47rem, calc(100svh - 5.25rem));
  padding: clamp(3rem, 7vw, 7rem) 0;
}
.mail-entry { min-width: 0; }
.mail-entry h1 {
  margin: 0;
  font-size: clamp(3.4rem, 6.3vw, 6.8rem);
  line-height: 1.02;
  letter-spacing: -.077em;
  font-weight: 650;
}
.mail-entry h1 span { color: #e4480b; }
.mail-description {
  max-width: 32ch;
  margin: 1.55rem 0 0;
  color: #524e45;
  font-size: clamp(1.05rem, 1.5vw, 1.25rem);
  line-height: 1.55;
}
.mail-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #191916;
  color: #fffaf4;
  min-height: 3.2rem;
  margin-top: 1.9rem;
  padding: .75rem 1.4rem;
  border-radius: .65rem;
  font-size: 1rem;
  font-weight: 650;
  text-decoration: none;
}
.mail-button:hover { background: #39372f; }
.mail-preview-link { display:block; width:fit-content; margin-top:1.25rem; padding:.35rem 0; color:#423e37; font-size:.93rem; font-weight:650; text-underline-offset:.25em; }
.mail-art {
  position: relative;
  display: grid;
  place-items: center;
  aspect-ratio: 1.13;
  contain: paint;
  border-radius: 1.1rem;
  background: #ff662e;
}
.mail-envelope {
  position: relative;
  width: 74%;
  aspect-ratio: 1.53;
  transform: rotate(-9deg);
  border: 1px solid #b43e17;
  border-radius: 5px;
  background: #ffab7f;
  box-shadow: 0 2px 0 #b34521, 0 21px 26px -11px #8c2c1d70;
}
.mail-flap, .mail-flap::before {
  position: absolute;
  inset: 0;
  border-radius: 4px;
  clip-path: polygon(0 0, 100% 0, 52% 57%, 48% 57%);
  background: #ad441e;
}
.mail-flap::before { content: ""; inset: -1px 0 2px; background: #ffbc98; }
.mail-seal {
  position: absolute;
  left: 50%;
  top: 54%;
  width: 13%;
  height: auto;
  transform: translate(-50%, -50%);
}
.mail-postmark {
  position: absolute;
  right: 7%;
  bottom: 10%;
  color: #7e321a;
  font-family: ui-monospace, monospace;
  font-size: clamp(.65rem, 1vw, .9rem);
}
@media (max-width: 46rem) {
  .mail-top { min-height: 4.4rem; }
  .mail-desk { grid-template-columns: 1fr; gap: 2.5rem; padding: 3.25rem 0 2rem; min-height: auto; }
  .mail-entry h1 { font-size: clamp(3.2rem, 12vw, 4.9rem); }
  .mail-description { margin-top: 1.15rem; }
  .mail-button { margin-top: 1.45rem; }
  .mail-art { aspect-ratio: 1.75; max-height: 18rem; }
  .mail-envelope { width: 55%; }
}
@media (max-height: 28rem) and (orientation: landscape) {
  .mail-desk { min-height: auto; padding: 2rem 0; }
  .mail-art { max-height: 14rem; }
}
`;

/** Scope the native skin to SOGo's login and mailbox chrome, outside message bodies. */
export const sogoCss = font + `
#loginContent {
  overflow: hidden;
  border-radius: 12px;
  font-family: "Manrope", system-ui, sans-serif;
}
#loginContent .sg-logo { background: #f4f2ec; }
#loginContent .sg-logo .md-padding > img.md-margin {
  content: url("/favicon.svg");
  width: 52px;
  height: 52px;
}
md-toolbar.toolbar-main {
  background-color: #25241f;
  color: #fffaf4;
  border-bottom: 2px solid #ff5a1f;
  box-sizing: border-box;
}
md-sidenav .sg-mailbox-list-item.sg-selected {
  box-shadow: inset 3px 0 #ff5a1f;
}
`;
