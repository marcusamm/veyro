# Lerværk photography — 1 November 2026

The Lerværk demo now uses licensed photographs in place of the 32 previous hero/product assets described on the site as 3D visualisations. The new `foto-` filenames distinguish the replacement photography from retired assets and avoid stale image-cache reuse.

Lerværk and its catalogue are fictional. Photographs illustrate product types, materials and atmosphere; they are not evidence that Lerværk made or sells the photographed objects. Product dimensions, variants, prices and stock remain demonstration data. Photographers and pictured workshops are not presented as Lerværk staff or partners. Public attribution is available at `/demo/lervaerk/fotokrediter.html`.

## Sources

All stems below live in `public/demo/lervaerk/assets/img/` and end in `-{width}.webp`.

| Asset stem | Photographer | Original photo | Licence |
| --- | --- | --- | --- |
| `foto-hero-bord`, `foto-hero-mobile` | Tom Crew | [Four light bowls](https://unsplash.com/photos/YA2E3d7a9Wo) | Unsplash |
| `foto-krus-sand` | Katja Vogt | [Two ceramic mugs](https://unsplash.com/photos/two-white-ceramic-mug-CipURjPCXOo) | Unsplash |
| `foto-krus-skovgron` | David Mao | [Green mug on wooden desk](https://unsplash.com/photos/green-ceramic-mug-on-wooden-desk-m0l5J8Lqnzo) | Unsplash |
| `foto-krus-blagra` | Joel Timothy | [Cappuccino in a blue mug](https://unsplash.com/photos/cappuccino-in-blue-ceramic-mug-Eam2UM2zcX4) | Unsplash |
| `foto-espressokop` | Joao Sócola | [Espresso cup and saucer, 6763232](https://www.pexels.com/photo/white-ceramic-mug-on-white-ceramic-saucer-6763232/) | Pexels |
| `foto-skal` | Tom Crew | [Bowls, bgIO-u4GEfI](https://unsplash.com/photos/bgIO-u4GEfI) | Unsplash |
| `foto-serveringsskal` | Tom Crew | [Bowl, Mz__0nr1AM8](https://unsplash.com/photos/Mz__0nr1AM8) | Unsplash |
| `foto-frokosttallerken` | Yan Krukau | [Ceramic plate, 6611429](https://www.pexels.com/photo/6611429/) | Pexels |
| `foto-middagstallerken` | RDNE Stock project | [Colourful plates, 8903358](https://www.pexels.com/photo/colorful-plates-on-the-table-8903358/) | Pexels |
| `foto-kande` | RDNE Stock project | [Tableware with pouring jug, 8903276](https://www.pexels.com/photo/stacked-tableware-8903276/) | Pexels |
| `foto-fad` | RDNE Stock project | [Tableware with serving platters, 8903655](https://www.pexels.com/photo/blue-ceramic-plates-and-ceramic-cups-8903655/) | Pexels |
| `foto-vaerksted` | cottonbro studio | [Hands working clay, 6694323](https://www.pexels.com/photo/6694323/) | Pexels |

Licence references: [Unsplash licence](https://unsplash.com/license), [Pexels licence](https://www.pexels.com/license/). These are free stock photographs, not Unsplash+ assets or images copied from merchant product catalogues.

## Processing and delivery

- Image processing is limited to cropping, resizing and WebP encoding. No synthesis, generated extensions or recolouring was applied.
- Hero: widths 800 and 1600 px, approximately 3:2, plus an 800 px mobile crop that brings the bowls into the first screen.
- Ten product/variant stems and the workshop stem: widths 400, 800 and 1200 px. Most use 4:5; `foto-serveringsskal` and `foto-fad` use 4:3 to retain wide objects.
- Total: 36 local responsive WebP assets. The original source pages remain linked above; the website does not depend on remote image delivery.
- The same images are used across the catalogue, product pages, related products, variant selection, cart and checkout. `foto-vaerksted` replaces misleading repeated product “detail study” images with a correctly captioned process photograph.
- All nine Lerværk preview files were refreshed using browser captures of the homepage, product page and populated cart. Desktop captures: 1920 × 1200, also delivered at 960 × 600. Mobile captures: 390 × 640. Cache versions were updated in all preview references.

## Static verification

The 12 Lerværk HTML pages were checked for existing local image/script/stylesheet targets, descriptive image alternatives and obsolete image references. The old 3D-visualisation claim and “Detaljestudie” captions were removed. Product controls, IDs, prices and stock behaviour were preserved; the hero's former single-mug offer now links to the collection shown by the opening photograph.
