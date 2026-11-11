# SBB — design and release review

Updated 10 November 2026 after the supplied CRISP opening screenshot. The screenshot supersedes the earlier left-aligned opening; continuous page flow remains.

## Local preview

From the repository root:

```sh
npx wrangler dev --config stylebybrothers/wrangler.toml --port 8788 --local
```

Open [the homepage](http://localhost:8788/), [webshop](http://localhost:8788/#/shop), [booking](http://localhost:8788/#/booking) or [administration](http://localhost:8788/#/admin). The preview uses local Worker storage.

## Release validation — 11 November 2026

The user approved publishing this preview to `sbb.veyro.dk`. The existing `deploy-stylebybrothers.yml` workflow publishes the site and Worker from `main` without running the local seed script or replacing salon data.

- All 58 tests across 3 files pass against the release source.
- An independent source review found no release blockers; all 33 checked assets and imports exist.
- Booking and authentication logic are unchanged. Product gallery compatibility, authenticated draft images, stock reservations and checkout cancellation remain covered by tests.
- The live catalogue was empty and checkout disabled before release. No local demonstration products, test bookings or local credentials are included in the deployment.
- Actual online sales remain gated on live merchant configuration, confirmed products, delivery settings and terms. The visual release does not enable payments.

## Current design

- Transparent header over the opening photograph: menu left, small centred wordmark, plain booking link right. The header scrolls away naturally on the homepage. This arrangement is informed by the active header at [CRISP](https://www.crispmtl.com/); no CRISP logo, photographs or proprietary font files are used.
- Manrope throughout, the same font family used by Veyro. Regular 400 text and display type, with selective 500 emphasis. The screenshot-matched opening and minimal header now use 800 weight. The old condensed family remains unloaded.
- A full-viewport opening with the Danish two-line headline “Mere end en / frisørsalon” centred near the bottom, and one rectangular “Book tid” CTA below it. Icon-only menu at left, SBB wordmark centred, plain booking link at right. No eyebrow, descriptive paragraph, address strip, subtitle or extra opening link. SBB’s existing haircut photograph replaces CRISP’s reference photograph.
- A static photographic opening in normal document flow. Removed the pinned hero, assembled collage, split-heading masks and scroll-triggered entrances. Headings are always visible, including before images finish loading.
- Ivory continues through the introduction, prices, gallery, salon, shop, visit information and footer. There are no alternating dark presentation panels.
- Prices, gallery and product copy use sentence case and a smaller hierarchy. Hover/focus image changes and short shop route fades remain; scrolling does not drive a timeline.
- GSAP, ScrollTrigger and SplitText are no longer loaded. Their previously downloaded files and licence records remain in the repository as unused assets.
- The mobile menu has a labelled trigger, Escape dismissal, keyboard focus containment and inert underlying content. Booking remains reachable through the header, treatment links and a compact mobile shortcut after the hero.

The existing booking engine and shared shop catalogue remain the source of business data. See [DESIGN-SOURCES.md](DESIGN-SOURCES.md) for asset provenance and reference details.

## Verification for the supplied opening screenshot

- Inspected the opening at 2048 × 1197 (reference aspect ratio) and 375 × 812. The hero equals viewport height, one CTA is visible, the photograph loads and neither view overflows horizontally.
- Clicked the mobile opening’s Book tid button and confirmed the booking page opens.
- Verified the icon-only menu retains its accessible label and existing menu behavior. No new scroll animation was added.
- JavaScript syntax, CSS parsing and whitespace checks pass. Final browser logs contain no warnings/errors. The existing 58-test suite was already passing before this presentational-only opening adjustment and was not redundantly rerun.

## Verification for the preceding flow revision

- Browser checks at 375 × 812, 768 × 1024 and 1440 × 1000: no document horizontal overflow; header controls fit. Mobile and desktop openings inspected visually.
- Confirmed computed Manrope typography, a transparent header background, zero pin wrappers, and headings with full opacity and no transforms.
- Opened the desktop and mobile menu, navigated directly to prices, and checked Escape dismissal and trigger focus restoration.
- Selected Skæg from the price list and confirmed the booking page preselected Skæg / 20 minutes / 100 kr. No new booking submitted for this revision.
- Opened the mobile shop and existing local cart; verified the new lighter type, product categories, item/quantity controls and disabled checkout state.
- No browser warnings or errors reported in the final inspection.
- CSS parsing, JavaScript syntax and `git diff --check` passed. All **58 existing tests across 3 files passed** with `npx vitest run` from `stylebybrothers/`.
- Reduced-motion rules remain in source. OS-level reduced-motion emulation, assistive-technology testing and physical-phone performance measurement were not performed.

### Flow revision screenshots (before the supplied opening reference)

- [Desktop opening](../../artifacts/sbb-flow-v3/desktop-home.png)
- [Desktop prices](../../artifacts/sbb-flow-v3/desktop-prices.png)
- [375 px mobile opening](../../artifacts/sbb-flow-v3/mobile-home.png)

The `sbb-editorial-v2` and `sbb-flow-v3` openings show superseded designs. The screenshot-matched opening is recorded in `../../artifacts/sbb-crisp-opening/desktop-home.png` and `mobile-home.png`.

## Existing functionality verified in the prior implementation pass

The previous pass exercised gallery buttons, dragging, keyboard navigation and lightbox dismissal; product detail imagery, quantity changes, cart removal/empty state; and the owner product editor's image upload, replacement, ordering, draft save, publication and unpublication. Those features remain. The current revision does not change booking calculations, stock reservations or the worker backend.

That pass created a local `TEST — Editorial preview` booking (reference ALEBW7) and local test editor products. No actual salon booking or email delivery was made. A Cloudflare production dry-run passed then; no deploy was run.

Stripe sandbox API checks created a Checkout Session, verified idempotent reuse, safe expiration/cancellation with stock restoration, harmless repeat cancellation, and a signed local expiry-webhook replay. No completed card payment or real charge was made.

## Remaining before product launch

The three published local products are clearly labelled demonstration data, using salon photographs as temporary placeholders. They do not represent a verified actual product range. Real product photos, descriptions, prices and stock are needed. The barber must confirm delivery pricing, terms and merchant setup before enabling checkout. A completed sandbox card-payment and paid-order fulfilment check should follow.

Photo-use approval and service-duration confirmation remain outstanding. The source contains five distinct haircut photographs and one salon-interior view represented by several files; no independent staff portrait or actual product photography was fabricated.
