# Public website languages

The Danish website lives at `/`. English is served at `/en/`, Swedish at `/sv/`; public subpages retain their existing handles below the language prefix.

Unprefixed public page requests use Cloudflare's `request.cf.country`: Denmark (`DK`) stays Danish, Sweden (`SE`) redirects to Swedish, and other/unknown countries redirect to English. Local development without country metadata stays Danish. Redirects are temporary and private/no-store, and happen before page rendering. Explicit `/en/` and `/sv/` links always retain their language; known crawlers can fetch all canonical pages. Demos, assets, PDFs, portal routes and form submissions are excluded.

The language switcher adds a validated `?lang=da|en|sv` selection. The server saves a host-only `veyro_language` cookie for one year and redirects to the clean URL, preserving the other query parameters. This works without JavaScript and lets visitors keep Danish outside Denmark. A saved manual choice takes precedence over country detection on unprefixed pages. Only the language choice is stored; country/IP data is not persisted for this feature.

- `site/theme/locales/`: static interface text, accessibility labels, validation messages and JavaScript strings. Liquid uses `| t`; client scripts read `ThemeStrings`.
- `en.content.json` and `sv.content.json`: exact-source translations of display values from the existing templates, page bodies, menus and schema defaults. Preserve embedded HTML, URLs, placeholders and commercial terms when editing.
- `src/site/localization.ts`: request-local content translation and public navigation URLs. Machine identifiers, form values, section anchors and product types stay stable.
- Danish content and admin content editing remain the source. After changing source copy, update the corresponding catalog keys in both languages. Unknown/custom admin text deliberately falls back to the source; it is never automatically sent to an external translation service.
- The base currency stays DKK. English displays approximate EUR amounts and Swedish approximate SEK amounts using the dated ECB reference in `src/site/currency.ts`. Refresh that rate deliberately; displayed conversions do not change payment amounts or the currency agreed in an offer. The customer portal, fictional standalone demos and existing PDF agreement exports remain separate applications/documents in Danish.

After changes run `npm run build:site`, `npm run typecheck`, and `npx vitest run tests/site.test.mjs`. The generated theme hash includes all translations, so cached HTML and asset URLs are invalidated together.

The language switcher preserves the current page, query selection and section. Contact forms submit to the existing endpoint and return to the same language; consent keys and service values remain compatible with the existing lead workflow. Test submissions use the isolated local harness and mocked email/payment services.
