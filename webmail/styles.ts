export const webmailCss = `
@font-face {
  font-family: "Manrope";
  src: url("/manrope.woff2") format("woff2");
  font-weight: 200 800;
  font-display: swap;
}
:root {
  color-scheme: light;
  font-family: "Manrope", system-ui, sans-serif;
  color: #191916;
  background: #f4f2ec;
  -webkit-text-size-adjust: 100%;
}
* { box-sizing: border-box; }
body { margin: 0; }
main {
  width: min(100%, 35rem);
  margin-inline: auto;
  padding: clamp(3rem, 14vh, 8rem) 1.5rem 2rem;
}
.mail-brand {
  display: flex;
  align-items: center;
  gap: .6rem;
  margin-bottom: 2.5rem;
  font-size: 1.1rem;
  font-weight: 750;
  letter-spacing: -.025em;
}
h1 { margin: 0; font-size: clamp(1.75rem, 5.5vw, 2.5rem); line-height: 1.15; letter-spacing: -.045em; }
p { margin: 1rem 0; color: #524e45; line-height: 1.55; }
a { display: inline-block; padding-block: .5rem; font-weight: 650; color: #191916; text-underline-offset: .23em; }
a:focus-visible { outline: 3px solid #a03a12; outline-offset: 4px; }
`;
