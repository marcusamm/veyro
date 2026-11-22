# AJ Auto · billedmateriale

Det officielle logo er kundens uændrede PNG i `public/aj/logo.png`. Luft omkring logoet beskæres kun i CSS. Der er ikke genereret et nyt kundelogo.

Nye fotoillustrationer er genereret med den indbyggede imagegen-funktion og JPEG-komprimeret til web. Ingen personer, kundelokaler, bilmodeller til salg eller konkrete olieprodukter dokumenteres af dem.

- `public/aj/hero-car.jpg` — 1672 × 941, cirka 221 KB, mørk bil med lilla reflekser; bruges på forsiden og i bilhandel-sektionen. Original PNG bevaret i workspace `outputs/aj-auto/imagegen/hero-car-original.png`.
- `public/aj/oil-service.jpg` — 1200 × 900, cirka 132 KB, umærket oliebeholder og oliefilter; bruges i olieskift-sektionen. Original PNG og prompt bevaret i workspace `artifacts/aj-auto/`.

## Hero · præcis prompt

```text
Use case: ads-marketing
Asset type: full-width landscape website hero photograph-style illustration for a Danish local auto workshop, 16:9 aspect ratio.
Primary request: cinematic, premium but understated automotive studio photography of an unbranded dark charcoal ordinary modern compact family car. Close front three-quarter view showing the windshield, hood and front wheel, with realistic automotive materials and proportions.
Scene/backdrop: minimal nearly black photographic studio, not a customer workshop. No visible shop equipment or signage.
Composition/framing: wide landscape 16:9. The car occupies the RIGHT 60% of the composition, cropped tastefully close at the right edge; its front three-quarter detail is the focus. Reserve the LEFT 40% as clean, near-black negative space, free of objects and bright reflections, for large white website typography that will be added separately. Maintain a dark upper edge for a website navigation bar.
Lighting/mood: controlled softbox light tracing the hood, windshield and wheel; rich charcoal shadows; subtle, restrained deep purple reflections matching #392080; realistic paint, glass and rubber textures. Photographic and believable, without theatrical haze.
Constraints: no people, no logos, no badges, no readable number plates, no license plate text, no words, no watermarks. This is an ordinary everyday car, not a luxury brand, sports car or flashy supercar. No neon glow. No typography. Opaque image.
```

## Olieskift · præcis prompt

```text
Mode: built-in image_gen__imagegen; new opaque image.
Use case: product-mockup. Asset type: landscape 4:3 service-card image for AJ Auto's Danish workshop website. Create a premium understated photographic studio still life: one unbranded charcoal-grey automotive motor-oil bottle with realistic moulded plastic form and cap, entirely blank with no writing or label, accompanied by one cylindrical pleated oil filter with realistic warm ivory filter paper and dark metal ends. Clean light-grey seamless studio background and floor. Arrange the two objects centrally with generous breathing room, fully visible and grounded by soft contact shadows; filter beside and slightly in front of bottle. Landscape 4:3 composition. Soft broad photographic lighting, realistic automotive materials, carefully controlled restrained highlights, just a very subtle deep-purple reflected tone inspired by #392080. Calm, credible, polished product photography suitable for an automotive service card. No text, no logos, no brands, no watermarks, no hands or people, no claims, no workshop or customer premises, no additional objects. This is a neutral photo-style illustration of oil-change materials, not documentation of actual products offered.

Web export: sips JPEG quality82,1200x900,132190bytes.

```
