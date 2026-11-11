# SBB editorial redesign — source and licence record

Updated 10 November 2026 for the current Manrope / natural-scroll implementation. Assets are self-hosted; the browser does not contact Google Fonts, npm or a third-party script CDN.

## Current typography and header

The current design uses **Manrope for all text**, matching Veyro's font family. Body text uses weight 400; headings use 400 or 500. Navigation and buttons use restrained medium weights. Condensed display type, oversized all-capitals treatment and staged heading reveals from the earlier version have been superseded. Barlow font files remain in the asset inventory but are not loaded by the current page.

Veyro's family declaration was verified in `../site/theme/snippets/theme-styles.liquid`: both `--font-body` and `--font-heading` resolve to Manrope. Its font file is `../site/theme/assets/manrope-latin-variable.woff2`. SBB reuses its existing `site/assets/fonts/manrope-variable.woff2`, the same family with a different subset/build; no new font download was required. The old Inter Tight comment in Veyro's `base.css` does not describe the current family declaration.

| Local asset under `site/assets/fonts/` | Source | Weight | Size | Current use |
| --- | --- | --- | --- | --- |
| `manrope-variable.woff2` | [Google Fonts: Manrope variable](https://github.com/google/fonts/blob/main/ofl/manrope/Manrope%5Bwght%5D.ttf) | Variable 200–800 | 29,248 bytes | All page text; preloaded by `index.html` |
| `barlow-condensed-600.woff2` | [Google Fonts: Barlow Condensed SemiBold](https://github.com/google/fonts/blob/main/ofl/barlowcondensed/BarlowCondensed-SemiBold.ttf) | 600 | 28,108 bytes | Retained, unused |
| `barlow-condensed-700.woff2` | [Google Fonts: Barlow Condensed Bold](https://github.com/google/fonts/blob/main/ofl/barlowcondensed/BarlowCondensed-Bold.ttf) | 700 | 28,348 bytes | Retained, unused |
| `barlow-condensed-800.woff2` | [Google Fonts: Barlow Condensed ExtraBold](https://github.com/google/fonts/blob/main/ofl/barlowcondensed/BarlowCondensed-ExtraBold.ttf) | 800 | 28,392 bytes | Retained, unused |

Both families use SIL Open Font License 1.1. Original notices and complete licences remain as `OFL-Barlow-Condensed.txt` and `OFL-Manrope.txt`. The official TTF files were converted and subset using FontTools to WOFF2. Retained Unicode ranges are U+0000–00FF, U+0100–017F, U+2000–206F, U+20AC, U+2122, U+2212, U+FEFF and U+FFFD. Glyph maps were checked for `æøåÆØÅäöÄÖ€`; Manrope's 200–800 variation axis remains intact. Danish, Swedish and English text is supported. The Manrope face uses `font-display: swap` and `font-weight: 200 800`. Source and generated-file SHA-256 hashes are in `site/assets/vendor/asset-manifest.json`.

The header follows [CRISP Barbershop's live site](https://www.crispmtl.com/): menu control on the left, a centred wordmark and a booking link on the right, on a transparent background. CRISP's public HTML and [linked stylesheet](https://cdn.prod.website-files.com/683f577d06dd8cb2e37a185d/css/crisp-41e033.webflow.shared.11d927fac.css) were inspected. The active `.wrapper.menu` uses a transparent three-part arrangement; the generic `.navbar*` rules in that stylesheet are not its active header. SBB adapts this arrangement with its own wordmark, real navigation and Manrope, without the thick black navigation bar.

CRISP's own display family is declared as `Helveticaneueltstd Bdex`, with `Helvetica Neue` for body text and `Perfectly Nineties` for small accents. Those font files were not copied or used. The user's later direction to use Veyro's font superseded the earlier request to match CRISP's typeface exactly.

## Current motion and page flow

The hero remains in normal document flow. There is no pin, collage transition, split-heading reveal or scroll-controlled presentation. The gallery, visit section and footer share the warm ivory background so they read as a continuous page. Service images change with a simple opacity transition on hover or keyboard focus; shop routes use a brief opacity transition. Reduced-motion preferences remove optional transitions. Booking, navigation and shop controls remain real links or buttons.

All GSAP script tags have been removed from `site/index.html`. The following vendor files are retained for provenance but are unused by the current page:

- `site/assets/vendor/gsap.min.js` — 73,357 bytes.
- `site/assets/vendor/ScrollTrigger.min.js` — 44,683 bytes.
- `site/assets/vendor/SplitText.min.js` — 7,955 bytes.

GSAP **3.15.1** was previously downloaded from the [official npm package](https://www.npmjs.com/package/gsap), using [its versioned archive](https://registry.npmjs.org/gsap/-/gsap-3.15.1.tgz). The archive's SHA-512 integrity was verified against npm metadata before extraction. Files and original copyright headers remain unmodified. There is no installed frontend build dependency.

The [GSAP Standard “No Charge” License](https://gsap.com/community/standard-license/) permits commercial websites, including former member-only plugins, while restricting competing visual animation-builder products. A retrieved text copy with its official source URL is stored in `site/assets/vendor/GSAP-LICENSE.txt`. This licence is not MIT. Retaining the files does not mean they are part of the current runtime.

## Superseded animation research

Earlier experiments considered a desktop hero pin, a photograph moving into a collage, masked heading reveals and more elaborate product transitions. Those experiments and implementation recommendations have been superseded by the current normal-scroll design. The references below are retained as a research/provenance record, not instructions to reintroduce them.

GSAP documentation read during that earlier pass:

- [ScrollTrigger](https://gsap.com/docs/v3/Plugins/ScrollTrigger/): scroll-linked timelines, pinning and layout refresh.
- [gsap.matchMedia](https://gsap.com/docs/v3/GSAP/gsap.matchMedia()/): responsive/reduced-motion conditions and animation cleanup.
- [SplitText](https://gsap.com/docs/v3/Plugins/SplitText/): line masks, responsive splitting and accessible semantic output.

Direct Codrops article pages returned HTTP 403 during research. Search-indexed article text and first-party GitHub repositories were accessible. Source code was read; this pass does not claim live observation or browser screenshots of these animations.

### Image-to-grid experiment

- [Article](https://tympanus.net/codrops/2022/05/19/image-to-grid-transition/)
- [Official repository](https://github.com/codrops/ImageToGridTransition)
- [Inspected implementation](https://github.com/codrops/ImageToGridTransition/blob/main/src/js/index.js)

The reference captures a large image with GSAP Flip, reparents it into a grid on click, and introduces surrounding images. It is not originally a scroll-scrubbed hero. SBB's former scroll/collage adaptation has been removed.

### Treatment-image experiment

- [Article](https://tympanus.net/codrops/2020/07/01/creating-a-menu-image-animation-on-hover/)
- [Official repository](https://github.com/codrops/RapidImageHoverMenu)
- [Inspected implementation](https://github.com/codrops/RapidImageHoverMenu/blob/master/src/js/menuItem.js)

The reference uses a clipped wrapper and counter-translated image, with cursor-following rotation and brightness. SBB's current adjacent treatment-image panel uses a simple opacity change on hover or focus instead of that effect.

Both repositories mark their **code** as MIT. No Codrops implementation code was copied into the vendor directory. The menu demo's photographs have a separate CC BY-NC-ND licence and were **not** downloaded or reused. Inspiration does not transfer image rights.

### Product-preview experiment

- [Animated product-grid preview tutorial](https://tympanus.net/codrops/2025/05/27/animated-product-grid-preview-with-gsap-clip-path/)

The indexed tutorial describes a clip-path overlay and assumes eight products and hover interaction. It informed an earlier motion experiment, not the current route-transition treatment. Its generated product images are not used. SBB supports arbitrary catalogue counts and explicit product-image controls for touch and keyboard users.

## Photography

This asset/research pass adds no third-party photographs. SBB's existing verified salon, people and haircut photographs should remain the source for the redesign. Product placeholders, when needed to assess layout, must remain labelled demonstration content in an isolated preview and must not appear as purchasable live merchandise.

Responsive derivatives of the eight existing JPEG photographs are stored in `site/img/optimized/`. These WebP files retain the original aspect ratio and colour; only dimensions and compression change. Widths are 480, 900 and 1200 pixels where the source permits, with 1600-pixel versions of the two large salon photographs. The `mid-fade-skaeg` and `taper-tekstur` sources are only 414 × 414 pixels, so they each retain that native width rather than being enlarged. `manifest.json` records each source and output's dimensions, bytes and SHA-256 hash. Original JPEG files are unchanged. The 900-pixel main hero derivative was visually inspected for clarity.

### Actual image inventory and remaining shot needs

All eight original JPEG files were inspected. There are five distinct haircut views and one salon-interior view represented by three files. `salonen-hero.jpg` and `salonen-forside.jpg` are byte-identical; `salonen.jpg` depicts the same room and camera angle at a lower resolution. They should not be presented as three independent salon photographs.

| Existing image | Native dimensions | Useful role and limitation |
| --- | --- | --- |
| `high-fade-skaeg.jpg` | 1200 × 1200 | Clear side-profile haircut and beard. Suitable main image; its square source limits a very wide desktop crop and high-density full-screen sharpness. |
| `kroeller-taper.jpg` | 1200 × 1200 | Curly haircut with visible shop lettering. Strong companion portrait crop. |
| `slick-back.jpg` | 1200 × 1200 | Side-profile cut with longer swept-back top. Clear supporting work image. |
| `taper-tekstur.jpg` | 414 × 414 | Low-resolution haircut view. Small supporting frame only; enlargement cannot reveal extra detail. |
| `mid-fade-skaeg.jpg` | 414 × 414 | Low-resolution beard/fade view. Small supporting frame only; cannot produce a sharp large lightbox. |
| `salonen-forside.jpg`, `salonen-hero.jpg` | 2560 × 1920 | Same interior view: chairs, mirrors and shelves. Use once prominently, with a detail crop if useful. |
| `salonen.jpg` | 1200 × 900 | Lower-resolution version of the same interior composition. |

No dedicated staff portrait, clear barber-at-work foreground photograph, distinct close-up of tools/hands, isolated product photography or video was found in `site/`. Blurred people in haircut backgrounds are not a substitute for an identifiable team portrait. Existing product stock visible on a shelf does not verify which products are currently sold online.

The most useful new salon-supplied photographs would be:

1. A horizontal barber-at-work image at least 2400 pixels wide, with clear hair/hands and uncluttered space for the opening headline.
2. The original high-resolution files for the two 414-pixel haircut photographs; ideally at least 1600 pixels on the long edge.
3. One owner/team portrait with confirmed names and roles, and a separate close detail of clippers, scissors or beard work.
4. A second interior angle or entrance photograph, rather than another crop of the current room view.
5. Front and back/detail photographs of each actual saleable product, with readable packaging and consistent light, at least 1200 pixels on the long edge.

These notes describe the files available in this repository. They do not independently establish a photographer licence, client model release, staff identity or current product catalogue. No new claim about people or products should be inferred from the images alone. Service durations in `data.js` are explicitly labelled estimates in the existing source and should be confirmed by the salon if described as verified business information.

## Webshop references and implementation

Research by the shop implementation pass used these accessible sources:

- [TrueKind's live storefront](https://truekindskincare.com/): the page content, product navigation and cart structure were readable. The live animation was not observed in this pass.
- [Designing TrueKind — its creators' Codrops case study](https://tympanus.net/codrops/2025/06/25/designing-truekind-a-skincare-brands-journey-through-moodboards-motion-and-meaning/): the indexed excerpt describes expanding a product background into a page transition. The direct page returned HTTP 403; no video viewing is claimed.
- [Garoa — developer Victor Work's project page](https://victor.work/project/garoa/): the project description and links to its screenshots were accessible. It identifies Victor Work's development/animation role and Studio BA / Bruno Arizio's design. Garoa's original live domain could not be opened during this pass.
- The supplied TrueKind and Garoa Awwwards pages timed out in the research tool. Their animations have not been presented as verified observations.

The original webshop implementation used more prominent masked previews and page-transition experiments inspired by these references. The current design keeps a stable rectangular product grid, hash-routed detail pages with explicit thumbnail controls, arrow-key and touch navigation, a brief opacity transition between shop routes, and the native-dialog cart drawer. These are original implementations; no reference site's images or ecommerce source code were copied. All controls remain real buttons or links, and reduced motion removes optional transitions.

The homepage's selected-product component reads the same published catalogue as the shop. It accepts optional `productIds` and `limit` parameters, defaults to the first three published products, and renders an honest short note when none exist. Temporary demonstration items are created only by the guarded localhost seed script. A local preview notice explicitly identifies their names, prices, stock and salon photographs as test material. Before public product launch, the barber must provide front/side/detail photographs of the actual products, accurate names/descriptions/prices and stock. The owner editor supports up to six images, replacement, removal and accessible ordering controls.

### Latest supplied opening reference

The user’s 10 November screenshot explicitly requests CRISP’s opening composition. The local opening uses a full-viewport SBB photograph, uniform dark overlay, bottom-centred two-line Danish headline and a rectangular white booking link. It retains Manrope from the prior request, now at 800 weight for the hero/header only. CRISP’s public CSS identifies its hero face as Helvetica Neue LT Std Bold Extended; that proprietary font has not been copied. No CRISP photography is reused. The image and exact glyph shapes therefore differ while the composition follows the supplied reference. The body remains in normal flow with no scroll pinning.
