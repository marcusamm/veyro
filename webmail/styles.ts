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
