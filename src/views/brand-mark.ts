import { html } from 'hono/html';

/** The same untouched SVG asset is served by the portal's existing favicon route. */
export function brandMark() {
  return html`<img class="veyro-brand-mark" src="/favicon.svg" width="64" height="64" alt="" aria-hidden="true" decoding="async">`;
}
