# Satisfactory 1.2 factory data

This calculator uses a pinned local snapshot of the **1.2.5.0 stable** game export,
Steam build **26281294**, published by Satisfactory Tools. It does not call an external
calculator API at runtime and does not silently switch recipes when a new game patch arrives.

- Data: https://api.new.satisfactorytools.com/data/versions/stable-26281294.json
- SHA-256: `fddecaa07cdb77022f2e2d87c664617b8905882b10e4da43245638597240ee0c`
- Upstream import time: 2026-11-06T12:16:26+01:00
- Checked: 2026-11-12
- Export/API project and MIT declaration: https://github.com/SatisfactoryTools/ToolsApi/blob/644ac72c9c5d98d62504e3adf49b5ff6361d8635/readme.md#license
- Extraction pipeline: https://github.com/SatisfactoryTools/AssetsExtractor
- Formula reference: https://github.com/SatisfactoryTools/SFTools/blob/f214061425aff679ff6e545e4a0c2ff1333f7ff0/src/app/Model/Planner/Formulas.ts
- Satisfactory Tools MIT license: https://github.com/SatisfactoryTools/SFTools/blob/f214061425aff679ff6e545e4a0c2ff1333f7ff0/LICENSE

The local normalized file contains 175 items, all 276 non-seasonal machine recipes
(including alternate recipes), 11 production-machine types, six belt capacities,
two pipeline capacities, and five extractor definitions. Build-gun, equipment-workshop-only,
handcraft-only and FICSMAS recipes are deliberately excluded.

## Quantity and power conventions

Recipe amounts are per cycle. The upstream exporter already expresses liquids and gases
in **m³**, not litres: do not divide recipe quantities by 1,000 again. Solid amounts are
items. Rate at 100% is `amount × 60 / durationSeconds × manufacturingSpeed`. Clock speed
scales input/output rates linearly.

The recipe-cost setting follows the SC 1.2 calculation convention: multiply each
ingredient's **per-cycle raw amount**, round to the nearest integer and clamp to a
minimum of one raw unit. Solid raw units are items; fluid/gas raw units are litres.
For normalized fluids, use `max(1, round(amountM3 × 1000 × cost)) / 1000` before
calculating cycles per minute. For example, 3 solid items at 0.5× cost become 2,
whereas 1 m³ at 0.5× remains 0.5 m³. Outputs are not multiplied by recipe cost.
See the pinned SC reference and verification scope in
[production parity](../../../docs/production-parity.md).

Production power follows the source machine exponent (1.321929 for the included
production machines): `basePower × (clockPercent / 100)^exponent`. Variable-power
recipes provide a minimum, maximum and average; they are only variable on a machine
whose source `powerUsage` is zero. For example, the Blender retains its fixed 75 MW
for Biochemical Sculptor even though the recipe carries a variable-power flag.

The source's `maxOverclock: 1` and `clockChangePerShard: 0` do not describe the unlocked
maximum. Satisfactory Tools' formula source explicitly supports 1–250% clock speed and
one power shard per 50 percentage points above 100%. The normalized file uses that
range. Somersloop capacity/boost is used by both calculators: output multiplier
`1 + sloopBoost × installedSloops`, input unchanged, power multiplied by the square
of the output multiplier. A UI must not imply it has applied sloops unless it actually
uses those formulas.

Belt and pipe maximum rates are taken from the shipped descriptions in the pinned
export and asserted by the data checks. They represent ideal maximum throughput;
pipe head-lift, backflow, fill state, freight schedules, startup and game-tick simulation
are outside the scope of this flow planner.

Extractor rates are at 100% and normal purity: miners 60/120/240 items/minute,
oil 120 m³/minute, water 120 m³/minute. Miner and oil rates use the raw extraction
cycle data (the oil raw amount needs the 1,000 conversion); water uses its shipped
description because this export's raw water extraction-rate fields are zero.
Impure/normal/pure multipliers are 0.5/1/2; water has no purity. These definitions are
separate from machine production recipes and require dedicated UI/engine support.

## Physical layout limitations

The source supplies **no usable production-machine footprints or connector positions**.
No made-up physical widths, lengths, collision clearances or port coordinates are
included. The board is a schematic planning view, not a scale-accurate in-game build
or save-file editor. Recipe ingredient/product rows can be used as logical flow ports.

## Reproduce and check

From the project root:

```sh
node scripts/import-satisfactory-data.mjs
node --test app/factory/data/data.test.mjs
```

For an already downloaded identical snapshot, pass its file path as the importer's
first argument. A different source hash fails the import and must be reviewed before
updating the explicit version pin. The application ships only the small normalized
snapshot, not the large source export, source images, or third-party website code.

## Attribution and license

Satisfactory, FICSIT, the game names and underlying game content are the property of
Coffee Stain Studios. This is an unofficial private fan planner; no affiliation or
endorsement is implied. No game artwork is redistributed in this dataset.

Satisfactory Tools declares its API and tooling MIT licensed. The upstream MIT notice
is preserved here:

MIT License

Copyright (c) 2026 Tomáš Blatný

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Construction-cost supplement

`construction-costs.json` is derived from the same SHA-256-verified Satisfactory Tools
1.2.5.0 export and is covered by the attribution above. It retains the exact ingredient
quantities of the `inBuildGun` recipes for the 11 production buildings and five modeled
extractors. These recipes are not added to the automated production recipe catalog.
Reproduce with `node scripts/import-construction-data.mjs`; the source hash is checked
before writing. Quantities are building ingredients, not ingredient rates. Installed
Power Shards and Somersloops are listed separately. Belts, pipes, supports, foundations,
power distribution and resource-well arrangements depend on physical placement and
are excluded from the construction bill.
